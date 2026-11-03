-- Foundation verification script.
-- Run database/schema.sql and database/advanced.sql first.
-- The script uses dedicated IDs and removes its own data before and after.

USE trading_app;

DELETE FROM trade_request_staging WHERE account_id = 9001;
DELETE FROM trade_audit WHERE account_id = 9001;
DELETE FROM trades WHERE account_id = 9001;
DELETE FROM orders WHERE account_id = 9001;
DELETE FROM holdings WHERE account_id = 9001;
DELETE FROM accounts WHERE account_id = 9001;
DELETE FROM users WHERE user_id = 9001;
DELETE FROM stocks WHERE stock_id = 9001;

INSERT INTO users
    (user_id, name, email, password_hash)
VALUES
    (9001, 'Foundation Test User', 'foundation-test@example.com', 'test-only');

INSERT INTO accounts
    (account_id, user_id, cash_balance, currency)
VALUES
    (9001, 9001, 10000.0000, 'INR');

INSERT INTO stocks
    (stock_id, symbol, company_name, current_price)
VALUES
    (9001, 'TESTSTOCK', 'Foundation Test Stock', 100.0000);

INSERT INTO trade_request_staging
    (event_id, batch_id, account_id, stock_id, side, quantity)
VALUES
    ('foundation-buy-1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        9001, 9001, 'BUY', 10),
    ('foundation-sell-1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        9001, 9001, 'SELL', 4),
    ('foundation-funds-1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        9001, 9001, 'BUY', 1000),
    ('foundation-shares-1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        9001, 9001, 'SELL', 1000);

CALL flush_trade_batch('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

SELECT 'mixed batch statuses' AS test_name,
       CASE
           WHEN (SELECT COUNT(*) FROM trade_request_staging
                 WHERE batch_id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
                   AND status = 'PROCESSED') = 2
            AND (SELECT COUNT(*) FROM trade_request_staging
                 WHERE batch_id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
                   AND status = 'REJECTED') = 2
           THEN 'PASS' ELSE 'FAIL'
       END AS result;

SELECT 'cash and holding updates' AS test_name,
       CASE
           WHEN (SELECT cash_balance FROM accounts WHERE account_id = 9001)
                    = 9400.0000
            AND (SELECT quantity FROM holdings
                 WHERE account_id = 9001 AND stock_id = 9001) = 6
           THEN 'PASS' ELSE 'FAIL'
       END AS result;

SELECT 'triggers and order status' AS test_name,
       CASE
           WHEN (SELECT COUNT(*) FROM trade_audit WHERE account_id = 9001) = 2
            AND (SELECT COUNT(*) FROM orders
                 WHERE account_id = 9001 AND status = 'EXECUTED') = 2
           THEN 'PASS' ELSE 'FAIL'
       END AS result;

SELECT 'portfolio view' AS test_name,
       CASE
           WHEN (SELECT market_value FROM vw_account_portfolio
                 WHERE account_id = 9001 AND stock_id = 9001) = 600.0000
           THEN 'PASS' ELSE 'FAIL'
       END AS result;

-- Replaying a processed event must not create another trade.
INSERT INTO trade_request_staging
    (event_id, batch_id, account_id, stock_id, side, quantity)
VALUES
    ('foundation-buy-1', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        9001, 9001, 'BUY', 10)
ON DUPLICATE KEY UPDATE
    batch_id = IF(status = 'STAGED', VALUES(batch_id), batch_id);

CALL flush_trade_batch('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

SELECT 'duplicate event protection' AS test_name,
       CASE
           WHEN (SELECT COUNT(*) FROM trades WHERE account_id = 9001) = 2
           THEN 'PASS' ELSE 'FAIL'
       END AS result;

DELETE FROM trade_request_staging WHERE account_id = 9001;
DELETE FROM trade_audit WHERE account_id = 9001;
DELETE FROM trades WHERE account_id = 9001;
DELETE FROM orders WHERE account_id = 9001;
DELETE FROM holdings WHERE account_id = 9001;
DELETE FROM accounts WHERE account_id = 9001;
DELETE FROM users WHERE user_id = 9001;
DELETE FROM stocks WHERE stock_id = 9001;
