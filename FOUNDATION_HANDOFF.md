# Trading Foundation Handoff

This repository now contains the database and Redis foundation for the stock
trading application. `Review1/`, `Review2/`, and `Review2/main.py` are kept as
historical review material. The implementation files used going forward are
the top-level `database/` and `lib/` directories.

## Scope

The foundation supports only immediate stock BUY and SELL requests. It does
not support options, derivatives, deposits, withdrawals, short selling, or an
order-matching engine.

MySQL is the durable source of truth. Redis holds pending requests, status
lookups, a dead-letter stream, and non-authoritative request analytics.

## Setup

Use MySQL 8.x and Redis 6/7+.

1. Create a MySQL user and database access using your local credentials.
2. Run `database/schema.sql`.
3. Run `database/advanced.sql`.
4. Copy `.env.example` to the local environment configuration and fill in the
   real credentials.
5. Install connector dependencies with `npm install`.
6. Run `npm run typecheck` to verify the connector.
7. Run `database/tests.sql` against the local `trading_app` database.

The SQL scripts use `CREATE IF NOT EXISTS` for the base objects and seed data
uses `INSERT IGNORE`, so the bootstrap can be run again without duplicating
the demo rows. The advanced script replaces its procedures, triggers, and
views when rerun.

## Database model

- `users`: application identities.
- `accounts`: one cash account per user.
- `stocks`: tradable stocks and the current execution quote.
- `orders`: BUY/SELL requests that become executed orders after a trade row is
  inserted.
- `trades`: durable executions, one execution per order.
- `holdings`: current per-account stock quantities and weighted average cost.
- `trade_audit`: trigger-created audit rows for executed trades.
- `trade_request_staging`: idempotent Redis event staging and processing status.

The two application-facing views are:

- `vw_stock_trading_summary`: stock-level volume and traded-value aggregates.
- `vw_account_portfolio`: holdings, cost basis, market value, and unrealized
  profit/loss for each account.

## Trade lifecycle

1. The backend calls `enqueueTrade` with an account, stock, side, and positive
   quantity.
2. Redis adds the request to `trading:trade_requests` and marks its status as
   `PENDING`.
3. A worker calls `flushTradeBatch` periodically.
4. The worker stages each event in MySQL using the Redis Stream event ID.
5. MySQL calls `flush_trade_batch`.
6. `flush_trade_batch` creates a savepoint for each event and calls
   `execute_trade`.
7. Valid requests update cash/holdings and insert an order/trade. Invalid
   requests roll back to that event's savepoint and become `REJECTED`.
8. The order-status and trade-audit triggers run automatically.
9. Redis status hashes are updated and rejected requests are published to
   `trading:trade_rejections`.
10. The Redis checkpoint advances only after every event in the batch is
    finalized as `PROCESSED` or `REJECTED`.

Execution uses `stocks.current_price` at flush time. The client never supplies
the authoritative execution price.

## Connector API

The reusable implementation is in `lib/trading-connector.ts`.

```ts
type TradeSide = "BUY" | "SELL";

interface TradeRequest {
  accountId: number;
  stockId: number;
  side: TradeSide;
  quantity: number;
}

enqueueTrade(redis, request)
  -> Promise<{ eventId: string; status: "PENDING" }>

flushTradeBatch(clients, batchSize?)
  -> Promise<{
       batchId: string;
       processed: string[];
       rejected: Array<{ eventId: string; errorMessage: string }>;
       checkpoint: string | null;
     }>

getTradeStatus(redis, eventId)
  -> Promise<TradeStatusResult>

getCachedAnalytics(redis)
  -> Promise<CachedAnalytics>
```

The connector reads all connection settings from environment variables. The
browser must never receive MySQL credentials or connect directly to Redis.
These functions should be called from Next.js Route Handlers or another
server-only backend module.

## Frontend integration guidance

The next frontend/backend layer should expose server-side endpoints similar to:

- `GET /api/stocks` — query `stocks`.
- `GET /api/portfolio` — query `vw_account_portfolio` for the authenticated
  account.
- `GET /api/stocks/summary` — query `vw_stock_trading_summary`.
- `POST /api/trades` — validate the request and call `enqueueTrade`.
- `GET /api/trades/:eventId` — call `getTradeStatus`.
- `GET /api/dashboard` — call `getCachedAnalytics` and query authoritative
  MySQL views where exact values are required.

The frontend should show a newly submitted trade as `PENDING`, not executed.
It should show `PROCESSED` only after the status endpoint confirms MySQL
execution. Rejected requests should display the returned error message.

## Important invariants

- Only BUY and SELL are valid sides.
- Quantities must be positive integers.
- BUY requires sufficient cash.
- SELL requires sufficient holdings.
- A Redis event ID may create at most one durable trade.
- MySQL, not Redis analytics, determines balances, holdings, and completed
  trades.
- Trade execution must remain server-side.
