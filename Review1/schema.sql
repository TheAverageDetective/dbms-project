CREATE DATABASE trading_app;
USE trading_app;

CREATE TABLE users (
    user_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE accounts (
    account_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE,
    cash_balance DECIMAL(18,2) NOT NULL DEFAULT 0,
    currency CHAR(3) NOT NULL DEFAULT 'USD',

    FOREIGN KEY (user_id)
        REFERENCES users(user_id),

    CHECK (cash_balance >= 0)
);

CREATE TABLE stocks (
    stock_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL UNIQUE,
    company_name VARCHAR(255) NOT NULL,
    current_price DECIMAL(18,4) NOT NULL,

    CHECK (current_price >= 0)
);

CREATE TABLE orders (
    order_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT NOT NULL,
    stock_id BIGINT NOT NULL,
    side ENUM('BUY', 'SELL') NOT NULL,
    quantity INT NOT NULL,
    order_price DECIMAL(18,4) NOT NULL,
    status VARCHAR(30) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (account_id)
        REFERENCES accounts(account_id),

    FOREIGN KEY (stock_id)
        REFERENCES stocks(stock_id),

    CHECK (quantity > 0),
    CHECK (order_price >= 0)
);

CREATE TABLE trades (
    trade_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    order_id BIGINT NOT NULL UNIQUE,
    account_id BIGINT NOT NULL,
    stock_id BIGINT NOT NULL,
    quantity INT NOT NULL,
    execution_price DECIMAL(18,4) NOT NULL,
    executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (order_id)
        REFERENCES orders(order_id),

    FOREIGN KEY (account_id)
        REFERENCES accounts(account_id),

    FOREIGN KEY (stock_id)
        REFERENCES stocks(stock_id),

    CHECK (quantity > 0),
    CHECK (execution_price >= 0)
);

CREATE TABLE holdings (
    account_id BIGINT NOT NULL,
    stock_id BIGINT NOT NULL,
    quantity INT NOT NULL,
    average_cost DECIMAL(18,4) NOT NULL,

    PRIMARY KEY (account_id, stock_id),

    FOREIGN KEY (account_id)
        REFERENCES accounts(account_id),

    FOREIGN KEY (stock_id)
        REFERENCES stocks(stock_id),

    CHECK (quantity > 0),
    CHECK (average_cost >= 0)
);