USE trading_app;

-- Redis batches are copied here before the procedure applies them.
-- event_id is the Redis Stream ID, so retrying a batch does not duplicate it.
CREATE TABLE IF NOT EXISTS trade_flush_staging (
    event_id VARCHAR(40) PRIMARY KEY,
    batch_id CHAR(32) NOT NULL,
    account_id BIGINT NOT NULL,
    stock_id BIGINT NOT NULL,
    side ENUM('BUY', 'SELL') NOT NULL,
    quantity INT NOT NULL,
    execution_price DECIMAL(18,4) NOT NULL,
    processed BOOLEAN NOT NULL DEFAULT FALSE,
    staged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add the linking column once. This form works on MySQL versions where
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS is not supported.
SET @add_order_event_id = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE trade_flush_staging ADD COLUMN order_event_id VARCHAR(40) AFTER event_id',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'trade_flush_staging'
      AND column_name = 'order_event_id'
);
PREPARE add_order_event_id_stmt FROM @add_order_event_id;
EXECUTE add_order_event_id_stmt;
DEALLOCATE PREPARE add_order_event_id_stmt;

CREATE TABLE IF NOT EXISTS order_flush_staging (
    order_event_id VARCHAR(40) PRIMARY KEY,
    batch_id CHAR(32) NOT NULL,
    account_id BIGINT NOT NULL,
    stock_id BIGINT NOT NULL,
    side ENUM('BUY', 'SELL') NOT NULL,
    quantity INT NOT NULL,
    order_price DECIMAL(18,4) NOT NULL,
    processed BOOLEAN NOT NULL DEFAULT FALSE,
    staged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS redis_order_map (
    order_event_id VARCHAR(40) PRIMARY KEY,
    order_id BIGINT NOT NULL UNIQUE
);

DROP TRIGGER IF EXISTS trg_trade_marks_order_executed;
DELIMITER $$

CREATE TRIGGER trg_trade_marks_order_executed
AFTER INSERT ON trades
FOR EACH ROW
BEGIN
    UPDATE orders
    SET status = 'EXECUTED'
    WHERE order_id = NEW.order_id;
END$$

DROP PROCEDURE IF EXISTS flush_trade_batch$$

CREATE PROCEDURE flush_trade_batch(IN p_batch_id CHAR(32))
BEGIN
    -- This procedure assumes Redis contains valid, already-executed trades.
    -- Validation belongs before staging; this procedure only persists the batch.
    DECLARE done BOOLEAN DEFAULT FALSE;
    DECLARE v_event_id VARCHAR(40);
    DECLARE v_account_id BIGINT;
    DECLARE v_stock_id BIGINT;
    DECLARE v_side VARCHAR(4);
    DECLARE v_quantity INT;
    DECLARE v_price DECIMAL(18,4);
    DECLARE v_total DECIMAL(28,4);
    DECLARE v_order_id BIGINT;

    DECLARE trade_cursor CURSOR FOR
        SELECT event_id, account_id, stock_id, side, quantity, execution_price
        FROM trade_flush_staging
        WHERE batch_id = p_batch_id AND processed = FALSE
        ORDER BY staged_at, event_id;

    DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;

    OPEN trade_cursor;

    trade_loop: LOOP
        FETCH trade_cursor
        INTO v_event_id, v_account_id, v_stock_id, v_side, v_quantity, v_price;

        IF done THEN
            LEAVE trade_loop;
        END IF;

        SET v_total = v_quantity * v_price;

        IF v_side = 'BUY' THEN
            UPDATE accounts
            SET cash_balance = cash_balance - v_total
            WHERE account_id = v_account_id;
        ELSE
            DELETE FROM holdings
            WHERE account_id = v_account_id
              AND stock_id = v_stock_id
              AND quantity = v_quantity;

            UPDATE holdings
            SET quantity = quantity - v_quantity
            WHERE account_id = v_account_id
              AND stock_id = v_stock_id
              AND quantity > v_quantity;
            UPDATE accounts
            SET cash_balance = cash_balance + v_total
            WHERE account_id = v_account_id;
        END IF;

        INSERT INTO orders
            (account_id, stock_id, side, quantity, order_price, status)
        VALUES
            (v_account_id, v_stock_id, v_side, v_quantity, v_price, 'PENDING');

        SET v_order_id = LAST_INSERT_ID();

        INSERT INTO trades
            (order_id, account_id, stock_id, quantity, execution_price)
        VALUES
            (v_order_id, v_account_id, v_stock_id, v_quantity, v_price);

        IF v_side = 'BUY' THEN
            INSERT INTO holdings (account_id, stock_id, quantity, average_cost)
            VALUES (v_account_id, v_stock_id, v_quantity, v_price)
            ON DUPLICATE KEY UPDATE
                average_cost = ((quantity * average_cost) +
                                (v_quantity * v_price)) /
                               (quantity + v_quantity),
                quantity = quantity + v_quantity;
        END IF;

        UPDATE trade_flush_staging
        SET processed = TRUE
        WHERE event_id = v_event_id;
    END LOOP;

    CLOSE trade_cursor;
END$$

DELIMITER ;

-- Flushes cached orders first, then cached trades linked to those orders.
DROP PROCEDURE IF EXISTS flush_order_trade_batch;
DELIMITER $$

CREATE PROCEDURE flush_order_trade_batch(IN p_batch_id CHAR(32))
BEGIN
    DECLARE done BOOLEAN DEFAULT FALSE;
    DECLARE v_order_event_id VARCHAR(40);
    DECLARE v_trade_event_id VARCHAR(40);
    DECLARE v_account_id BIGINT;
    DECLARE v_stock_id BIGINT;
    DECLARE v_side VARCHAR(4);
    DECLARE v_quantity INT;
    DECLARE v_order_price DECIMAL(18,4);
    DECLARE v_execution_price DECIMAL(18,4);
    DECLARE v_order_id BIGINT;

    DECLARE order_cursor CURSOR FOR
        SELECT order_event_id, account_id, stock_id, side, quantity, order_price
        FROM order_flush_staging
        WHERE batch_id = p_batch_id AND processed = FALSE
        ORDER BY staged_at, order_event_id;

    DECLARE trade_cursor CURSOR FOR
        SELECT event_id, order_event_id, account_id, stock_id,
               quantity, execution_price
        FROM trade_flush_staging
        WHERE batch_id = p_batch_id AND processed = FALSE
        ORDER BY staged_at, event_id;

    DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;

    OPEN order_cursor;
    order_loop: LOOP
        FETCH order_cursor INTO
            v_order_event_id, v_account_id, v_stock_id, v_side,
            v_quantity, v_order_price;

        IF done THEN LEAVE order_loop; END IF;

        INSERT INTO orders
            (account_id, stock_id, side, quantity, order_price, status)
        VALUES
            (v_account_id, v_stock_id, v_side, v_quantity, v_order_price, 'PENDING');

        SET v_order_id = LAST_INSERT_ID();

        INSERT INTO redis_order_map (order_event_id, order_id)
        VALUES (v_order_event_id, v_order_id);

        UPDATE order_flush_staging
        SET processed = TRUE
        WHERE order_event_id = v_order_event_id;
    END LOOP;
    CLOSE order_cursor;

    SET done = FALSE;
    OPEN trade_cursor;
    trade_loop: LOOP
        FETCH trade_cursor INTO
            v_trade_event_id, v_order_event_id, v_account_id, v_stock_id,
            v_quantity, v_execution_price;

        IF done THEN LEAVE trade_loop; END IF;

        SELECT order_id INTO v_order_id
        FROM redis_order_map
        WHERE order_event_id = v_order_event_id;

        INSERT INTO trades
            (order_id, account_id, stock_id, quantity, execution_price)
        VALUES
            (v_order_id, v_account_id, v_stock_id, v_quantity, v_execution_price);

        UPDATE trade_flush_staging
        SET processed = TRUE
        WHERE event_id = v_trade_event_id;
    END LOOP;
    CLOSE trade_cursor;
END$$

DELIMITER ;

CREATE OR REPLACE VIEW vw_stock_trading_summary AS
SELECT
    s.stock_id,
    s.symbol,
    s.company_name,
    COUNT(t.trade_id) AS total_trades,
    COALESCE(SUM(t.quantity), 0) AS total_shares,
    COALESCE(
        SUM(t.quantity * t.execution_price), 0
    ) AS total_traded_value
FROM stocks s
LEFT JOIN trades t
    ON s.stock_id = t.stock_id
GROUP BY
    s.stock_id,
    s.symbol,
    s.company_name;


