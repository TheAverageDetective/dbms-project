-- Trading application foundation schema.
-- Target: MySQL 8.x
-- Run this file before database/advanced.sql.

CREATE DATABASE IF NOT EXISTS trading_app
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_ai_ci;

USE trading_app;

CREATE TABLE IF NOT EXISTS users (
    user_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS accounts (
    account_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE,
    cash_balance DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
    currency CHAR(3) NOT NULL DEFAULT 'INR',
    CONSTRAINT fk_accounts_user
        FOREIGN KEY (user_id) REFERENCES users(user_id),
    CONSTRAINT chk_accounts_cash_nonnegative
        CHECK (cash_balance >= 0)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS stocks (
    stock_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL UNIQUE,
    company_name VARCHAR(255) NOT NULL,
    current_price DECIMAL(18,4) NOT NULL,
    CONSTRAINT chk_stocks_price_positive
        CHECK (current_price > 0)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS orders (
    order_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT NOT NULL,
    stock_id BIGINT NOT NULL,
    side ENUM('BUY', 'SELL') NOT NULL,
    quantity INT NOT NULL,
    order_price DECIMAL(18,4) NOT NULL,
    status ENUM('PENDING', 'EXECUTED', 'REJECTED', 'CANCELLED')
        NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_orders_account
        FOREIGN KEY (account_id) REFERENCES accounts(account_id),
    CONSTRAINT fk_orders_stock
        FOREIGN KEY (stock_id) REFERENCES stocks(stock_id),
    CONSTRAINT chk_orders_quantity_positive
        CHECK (quantity > 0),
    CONSTRAINT chk_orders_price_positive
        CHECK (order_price > 0),
    INDEX idx_orders_account_created (account_id, created_at),
    INDEX idx_orders_stock_created (stock_id, created_at)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS trades (
    trade_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    order_id BIGINT NOT NULL UNIQUE,
    account_id BIGINT NOT NULL,
    stock_id BIGINT NOT NULL,
    quantity INT NOT NULL,
    execution_price DECIMAL(18,4) NOT NULL,
    executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_trades_order
        FOREIGN KEY (order_id) REFERENCES orders(order_id),
    CONSTRAINT fk_trades_account
        FOREIGN KEY (account_id) REFERENCES accounts(account_id),
    CONSTRAINT fk_trades_stock
        FOREIGN KEY (stock_id) REFERENCES stocks(stock_id),
    CONSTRAINT chk_trades_quantity_positive
        CHECK (quantity > 0),
    CONSTRAINT chk_trades_price_positive
        CHECK (execution_price > 0),
    INDEX idx_trades_account_executed (account_id, executed_at),
    INDEX idx_trades_stock_executed (stock_id, executed_at)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS holdings (
    account_id BIGINT NOT NULL,
    stock_id BIGINT NOT NULL,
    quantity INT NOT NULL,
    average_cost DECIMAL(18,4) NOT NULL,
    PRIMARY KEY (account_id, stock_id),
    CONSTRAINT fk_holdings_account
        FOREIGN KEY (account_id) REFERENCES accounts(account_id),
    CONSTRAINT fk_holdings_stock
        FOREIGN KEY (stock_id) REFERENCES stocks(stock_id),
    CONSTRAINT chk_holdings_quantity_positive
        CHECK (quantity > 0),
    CONSTRAINT chk_holdings_average_cost_positive
        CHECK (average_cost > 0)
) ENGINE = InnoDB;

-- Demo data for local development. The password values are placeholders only;
-- authentication is outside this database-foundation pass.
INSERT IGNORE INTO users (user_id, name, email, password_hash) VALUES
    (1, 'Demo Investor', 'demo.investor@example.com',
        '$2b$12$demo.investor.password.hash'),
    (2, 'Aarav Sharma', 'aarav.sharma@example.com',
        '$2b$12$aarav.sharma.password.hash'),
    (3, 'Diya Nair', 'diya.nair@example.com',
        '$2b$12$diya.nair.password.hash'),
    (4, 'Rohan Mehta', 'rohan.mehta@example.com',
        '$2b$12$rohan.mehta.password.hash');

INSERT IGNORE INTO accounts (account_id, user_id, cash_balance, currency) VALUES
    (1, 1, 10000000.0000, 'INR'),
    (2, 2, 250000.0000, 'INR'),
    (3, 3, 500000.0000, 'INR'),
    (4, 4, 100000.0000, 'INR');

INSERT IGNORE INTO stocks (stock_id, symbol, company_name, current_price) VALUES
    (1, 'RELIANCE', 'Reliance Industries Limited', 2945.6500),
    (2, 'TCS', 'Tata Consultancy Services Limited', 4120.3000),
    (3, 'INFY', 'Infosys Limited', 1785.2000),
    (4, 'HDFCBANK', 'HDFC Bank Limited', 1688.7500),
    (5, 'ICICIBANK', 'ICICI Bank Limited', 1245.9000),
    (6, 'ITC', 'ITC Limited', 465.3500),
    (7, 'SBIN', 'State Bank of India', 812.4500),
    (8, 'WIPRO', 'Wipro Limited', 542.6000);

INSERT IGNORE INTO orders
    (order_id, account_id, stock_id, side, quantity, order_price, status)
VALUES
    (1, 1, 1, 'BUY', 100, 2900.0000, 'EXECUTED'),
    (2, 1, 3, 'BUY', 250, 1750.0000, 'EXECUTED'),
    (3, 2, 2, 'BUY', 20, 4050.0000, 'EXECUTED'),
    (4, 3, 4, 'BUY', 50, 1660.0000, 'EXECUTED'),
    (5, 4, 6, 'BUY', 100, 460.0000, 'EXECUTED'),
    (6, 1, 5, 'BUY', 75, 1230.0000, 'PENDING'),
    (7, 2, 8, 'SELL', 30, 540.0000, 'CANCELLED');

INSERT IGNORE INTO trades
    (trade_id, order_id, account_id, stock_id, quantity, execution_price)
VALUES
    (1, 1, 1, 1, 100, 2898.5000),
    (2, 2, 1, 3, 250, 1748.7500),
    (3, 3, 2, 2, 20, 4045.0000),
    (4, 4, 3, 4, 50, 1658.2500),
    (5, 5, 4, 6, 100, 459.8000);

INSERT IGNORE INTO holdings
    (account_id, stock_id, quantity, average_cost)
VALUES
    (1, 1, 100, 2898.5000),
    (1, 3, 250, 1748.7500),
    (2, 2, 20, 4045.0000),
    (3, 4, 50, 1658.2500),
    (4, 6, 100, 459.8000);
