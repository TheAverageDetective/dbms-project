USE trading_app;

-- Demo users. These password_hash values are placeholders for local testing only.
INSERT INTO users (user_id, name, email, password_hash) VALUES
(1, 'Demo Investor', 'demo.investor@example.com', '$2b$12$demo.investor.password.hash'),
(2, 'Aarav Sharma', 'aarav.sharma@example.com', '$2b$12$aarav.sharma.password.hash'),
(3, 'Diya Nair', 'diya.nair@example.com', '$2b$12$diya.nair.password.hash'),
(4, 'Rohan Mehta', 'rohan.mehta@example.com', '$2b$12$rohan.mehta.password.hash');

INSERT INTO accounts (account_id, user_id, cash_balance, currency) VALUES
(1, 1, 10000000.00, 'INR'),
(2, 2, 250000.00, 'INR'),
(3, 3, 500000.00, 'INR'),
(4, 4, 100000.00, 'INR');

INSERT INTO stocks (stock_id, symbol, company_name, current_price) VALUES
(1, 'RELIANCE', 'Reliance Industries Limited', 2945.6500),
(2, 'TCS', 'Tata Consultancy Services Limited', 4120.3000),
(3, 'INFY', 'Infosys Limited', 1785.2000),
(4, 'HDFCBANK', 'HDFC Bank Limited', 1688.7500),
(5, 'ICICIBANK', 'ICICI Bank Limited', 1245.9000),
(6, 'ITC', 'ITC Limited', 465.3500),
(7, 'SBIN', 'State Bank of India', 812.4500),
(8, 'WIPRO', 'Wipro Limited', 542.6000);

INSERT INTO orders
    (order_id, account_id, stock_id, side, quantity, order_price, status)
VALUES
(1, 1, 1, 'BUY', 100, 2900.0000, 'EXECUTED'),
(2, 1, 3, 'BUY', 250, 1750.0000, 'EXECUTED'),
(3, 2, 2, 'BUY', 20, 4050.0000, 'EXECUTED'),
(4, 3, 4, 'BUY', 50, 1660.0000, 'EXECUTED'),
(5, 4, 6, 'BUY', 100, 460.0000, 'EXECUTED'),
(6, 1, 5, 'BUY', 75, 1230.0000, 'PENDING'),
(7, 2, 8, 'SELL', 30, 540.0000, 'CANCELLED');

INSERT INTO trades
    (trade_id, order_id, account_id, stock_id, quantity, execution_price)
VALUES
(1, 1, 1, 1, 100, 2898.5000),
(2, 2, 1, 3, 250, 1748.7500),
(3, 3, 2, 2, 20, 4045.0000),
(4, 4, 3, 4, 50, 1658.2500),
(5, 5, 4, 6, 100, 459.8000);

INSERT INTO holdings (account_id, stock_id, quantity, average_cost) VALUES
(1, 1, 100, 2898.5000),
(1, 3, 250, 1748.7500),
(2, 2, 20, 4045.0000),
(3, 4, 50, 1658.2500),
(4, 6, 100, 459.8000);
