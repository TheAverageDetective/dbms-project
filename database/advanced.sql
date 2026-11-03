-- Trading application advanced database features.
-- Run database/schema.sql before this file.

USE trading_app;

CREATE TABLE IF NOT EXISTS trade_audit (
    audit_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    trade_id BIGINT NOT NULL UNIQUE,
    order_id BIGINT NOT NULL,
    account_id BIGINT NOT NULL,
    stock_id BIGINT NOT NULL,
    side ENUM('BUY', 'SELL') NOT NULL,
    quantity INT NOT NULL,
    execution_price DECIMAL(18,4) NOT NULL,
    executed_at TIMESTAMP NOT NULL,
    audited_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_trade_audit_trade
        FOREIGN KEY (trade_id) REFERENCES trades(trade_id),
    CONSTRAINT fk_trade_audit_order
        FOREIGN KEY (order_id) REFERENCES orders(order_id),
    CONSTRAINT fk_trade_audit_account
        FOREIGN KEY (account_id) REFERENCES accounts(account_id),
    CONSTRAINT fk_trade_audit_stock
        FOREIGN KEY (stock_id) REFERENCES stocks(stock_id),
    INDEX idx_trade_audit_account_time (account_id, audited_at)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS trade_request_staging (
    event_id VARCHAR(40) PRIMARY KEY,
    batch_id CHAR(32) NOT NULL,
    account_id BIGINT NOT NULL,
    stock_id BIGINT NOT NULL,
    side ENUM('BUY', 'SELL') NOT NULL,
    quantity INT NOT NULL,
    status ENUM('STAGED', 'PROCESSED', 'REJECTED') NOT NULL DEFAULT 'STAGED',
    order_id BIGINT NULL,
    execution_price DECIMAL(18,4) NULL,
    error_message VARCHAR(255) NULL,
    staged_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP NULL,
    CONSTRAINT fk_flush_account
        FOREIGN KEY (account_id) REFERENCES accounts(account_id),
    CONSTRAINT fk_flush_stock
        FOREIGN KEY (stock_id) REFERENCES stocks(stock_id),
    CONSTRAINT fk_flush_order
        FOREIGN KEY (order_id) REFERENCES orders(order_id),
    CONSTRAINT chk_flush_quantity_positive
        CHECK (quantity > 0),
    INDEX idx_flush_batch_status (batch_id, status, staged_at),
    INDEX idx_flush_status_time (status, staged_at)
) ENGINE = InnoDB;

DROP TRIGGER IF EXISTS trg_trade_audit_insert;
DROP TRIGGER IF EXISTS trg_trade_marks_order_executed;
DROP PROCEDURE IF EXISTS flush_trade_batch;
DROP PROCEDURE IF EXISTS execute_trade;
DROP VIEW IF EXISTS vw_account_portfolio;
DROP VIEW IF EXISTS vw_stock_trading_summary;

DELIMITER $$

CREATE PROCEDURE execute_trade(
    IN p_account_id BIGINT,
    IN p_stock_id BIGINT,
    IN p_side VARCHAR(4),
    IN p_quantity INT,
    OUT p_order_id BIGINT,
    OUT p_execution_price DECIMAL(18,4)
)
main: BEGIN
    DECLARE v_cash_balance DECIMAL(18,4);
    DECLARE v_current_price DECIMAL(18,4);
    DECLARE v_holding_quantity INT DEFAULT 0;
    DECLARE v_total DECIMAL(28,4);
    DECLARE v_normalized_side VARCHAR(4);

    SET p_order_id = NULL;
    SET p_execution_price = NULL;
    SET v_normalized_side = UPPER(TRIM(p_side));

    IF v_normalized_side NOT IN ('BUY', 'SELL') THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Trade side must be BUY or SELL';
    END IF;

    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Trade quantity must be positive';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM accounts WHERE account_id = p_account_id
    ) THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Trading account does not exist';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM stocks WHERE stock_id = p_stock_id
    ) THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Stock does not exist';
    END IF;

    SELECT cash_balance
    INTO v_cash_balance
    FROM accounts
    WHERE account_id = p_account_id
    FOR UPDATE;

    SELECT current_price
    INTO v_current_price
    FROM stocks
    WHERE stock_id = p_stock_id
    FOR UPDATE;

    SET v_total = p_quantity * v_current_price;
    SET p_execution_price = v_current_price;

    IF v_normalized_side = 'BUY' THEN
        IF v_cash_balance < v_total THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Insufficient cash balance for BUY';
        END IF;

        UPDATE accounts
        SET cash_balance = cash_balance - v_total
        WHERE account_id = p_account_id;

        INSERT INTO holdings (account_id, stock_id, quantity, average_cost)
        VALUES (p_account_id, p_stock_id, p_quantity, v_current_price)
        ON DUPLICATE KEY UPDATE
            average_cost = (
                (quantity * average_cost) +
                (p_quantity * v_current_price)
            ) / (quantity + p_quantity),
            quantity = quantity + p_quantity;
    ELSE
        IF NOT EXISTS (
            SELECT 1
            FROM holdings
            WHERE account_id = p_account_id
              AND stock_id = p_stock_id
        ) THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'No holding exists for SELL';
        END IF;

        SELECT quantity
        INTO v_holding_quantity
        FROM holdings
        WHERE account_id = p_account_id
          AND stock_id = p_stock_id
        FOR UPDATE;

        IF v_holding_quantity < p_quantity THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Insufficient shares for SELL';
        END IF;

        UPDATE holdings
        SET quantity = quantity - p_quantity
        WHERE account_id = p_account_id
          AND stock_id = p_stock_id;

        DELETE FROM holdings
        WHERE account_id = p_account_id
          AND stock_id = p_stock_id
          AND quantity = 0;

        UPDATE accounts
        SET cash_balance = cash_balance + v_total
        WHERE account_id = p_account_id;
    END IF;

    INSERT INTO orders
        (account_id, stock_id, side, quantity, order_price, status)
    VALUES
        (p_account_id, p_stock_id, v_normalized_side,
         p_quantity, v_current_price, 'PENDING');

    SET p_order_id = LAST_INSERT_ID();

    INSERT INTO trades
        (order_id, account_id, stock_id, quantity, execution_price)
    VALUES
        (p_order_id, p_account_id, p_stock_id, p_quantity, v_current_price);
END$$

CREATE PROCEDURE flush_trade_batch(IN p_batch_id CHAR(32))
main: BEGIN
    DECLARE done BOOLEAN DEFAULT FALSE;
    DECLARE v_event_id VARCHAR(40);
    DECLARE v_account_id BIGINT;
    DECLARE v_stock_id BIGINT;
    DECLARE v_side VARCHAR(4);
    DECLARE v_quantity INT;
    DECLARE v_order_id BIGINT;
    DECLARE v_execution_price DECIMAL(18,4);
    DECLARE v_error_message VARCHAR(255);

    DECLARE event_cursor CURSOR FOR
        SELECT event_id, account_id, stock_id, side, quantity
        FROM trade_request_staging
        WHERE batch_id = p_batch_id
          AND status = 'STAGED'
        ORDER BY staged_at, event_id;

    DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    START TRANSACTION;
    OPEN event_cursor;

    event_loop: LOOP
        FETCH event_cursor
        INTO v_event_id, v_account_id, v_stock_id, v_side, v_quantity;

        IF done THEN
            LEAVE event_loop;
        END IF;

        SET v_order_id = NULL;
        SET v_execution_price = NULL;
        SET v_error_message = NULL;

        SAVEPOINT event_savepoint;

        BEGIN
            DECLARE v_failed BOOLEAN DEFAULT FALSE;

            DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
            BEGIN
                SET v_failed = TRUE;
                GET DIAGNOSTICS CONDITION 1
                    v_error_message = MESSAGE_TEXT;
                ROLLBACK TO SAVEPOINT event_savepoint;
            END;

            CALL execute_trade(
                v_account_id,
                v_stock_id,
                v_side,
                v_quantity,
                v_order_id,
                v_execution_price
            );

            IF v_failed THEN
                UPDATE trade_request_staging
                SET status = 'REJECTED',
                    error_message = COALESCE(
                        v_error_message,
                        'Trade execution failed'
                    ),
                    processed_at = CURRENT_TIMESTAMP
                WHERE event_id = v_event_id;
            ELSE
                UPDATE trade_request_staging
                SET status = 'PROCESSED',
                    order_id = v_order_id,
                    execution_price = v_execution_price,
                    error_message = NULL,
                    processed_at = CURRENT_TIMESTAMP
                WHERE event_id = v_event_id;
            END IF;
        END;

        RELEASE SAVEPOINT event_savepoint;
    END LOOP;

    CLOSE event_cursor;
    COMMIT;
END$$

CREATE TRIGGER trg_trade_marks_order_executed
AFTER INSERT ON trades
FOR EACH ROW
BEGIN
    UPDATE orders
    SET status = 'EXECUTED'
    WHERE order_id = NEW.order_id;
END$$

CREATE TRIGGER trg_trade_audit_insert
AFTER INSERT ON trades
FOR EACH ROW FOLLOWS trg_trade_marks_order_executed
BEGIN
    INSERT INTO trade_audit
        (trade_id, order_id, account_id, stock_id, side, quantity,
         execution_price, executed_at)
    SELECT
        NEW.trade_id,
        NEW.order_id,
        NEW.account_id,
        NEW.stock_id,
        o.side,
        NEW.quantity,
        NEW.execution_price,
        NEW.executed_at
    FROM orders AS o
    WHERE o.order_id = NEW.order_id;
END$$

DELIMITER ;

CREATE OR REPLACE VIEW vw_stock_trading_summary AS
SELECT
    s.stock_id,
    s.symbol,
    s.company_name,
    COUNT(t.trade_id) AS total_trades,
    COALESCE(SUM(CASE WHEN o.side = 'BUY' THEN t.quantity ELSE 0 END), 0)
        AS bought_shares,
    COALESCE(SUM(CASE WHEN o.side = 'SELL' THEN t.quantity ELSE 0 END), 0)
        AS sold_shares,
    COALESCE(SUM(t.quantity), 0) AS total_shares,
    COALESCE(SUM(t.quantity * t.execution_price), 0.0000)
        AS total_traded_value
FROM stocks AS s
LEFT JOIN trades AS t ON t.stock_id = s.stock_id
LEFT JOIN orders AS o ON o.order_id = t.order_id
GROUP BY s.stock_id, s.symbol, s.company_name;

CREATE OR REPLACE VIEW vw_account_portfolio AS
SELECT
    a.account_id,
    u.name AS user_name,
    s.stock_id,
    s.symbol,
    s.company_name,
    h.quantity,
    h.average_cost,
    s.current_price,
    h.quantity * h.average_cost AS cost_basis,
    h.quantity * s.current_price AS market_value,
    h.quantity * (s.current_price - h.average_cost) AS unrealized_pnl
FROM holdings AS h
JOIN accounts AS a ON a.account_id = h.account_id
JOIN users AS u ON u.user_id = a.user_id
JOIN stocks AS s ON s.stock_id = h.stock_id;
