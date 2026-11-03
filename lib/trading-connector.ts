import { randomUUID } from "node:crypto";

import mysql, { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { createClient } from "redis";

export type TradeSide = "BUY" | "SELL";
export type TradeStatus = "PENDING" | "PROCESSED" | "REJECTED" | "UNKNOWN";

export interface TradeRequest {
  accountId: number;
  stockId: number;
  side: TradeSide;
  quantity: number;
}

export interface EnqueuedTrade {
  eventId: string;
  status: "PENDING";
}

export interface TradeStatusResult {
  eventId: string;
  status: TradeStatus;
  accountId?: number;
  stockId?: number;
  side?: TradeSide;
  quantity?: number;
  orderId?: number;
  executionPrice?: number;
  errorMessage?: string;
}

export interface FlushResult {
  batchId: string;
  processed: string[];
  rejected: Array<{ eventId: string; errorMessage: string }>;
  checkpoint: string | null;
}

export interface CachedAnalytics {
  counters: Record<string, string>;
  topRequestedStocks: Array<{ stockId: string; score: number }>;
}

export type TradingRedisClient = ReturnType<typeof createClient>;

export interface TradingClients {
  redis: TradingRedisClient;
  mysql: Pool;
}

export const TRADE_REQUEST_STREAM = "trading:trade_requests";
export const TRADE_REJECTION_STREAM = "trading:trade_rejections";
export const TRADE_CHECKPOINT_KEY = "trading:trade_requests:last_flushed_id";
export const TRADE_ANALYTICS_KEY = "trading:trade_analytics";
export const STOCK_REQUEST_RANKING_KEY = "trading:stock:request_volume";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function statusKey(eventId: string): string {
  return `trading:trade_status:${eventId}`;
}

function asPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function validateRequest(request: TradeRequest): void {
  asPositiveInteger(request.accountId, "accountId");
  asPositiveInteger(request.stockId, "stockId");
  asPositiveInteger(request.quantity, "quantity");
  if (request.side !== "BUY" && request.side !== "SELL") {
    throw new Error("side must be BUY or SELL");
  }
}

export function createTradingClients(): TradingClients {
  const redis = createClient({ url: requiredEnv("REDIS_URL") });
  const mysqlPool = mysql.createPool({
    host: requiredEnv("MYSQL_HOST"),
    port: Number(requiredEnv("MYSQL_PORT")),
    user: requiredEnv("MYSQL_USER"),
    password: requiredEnv("MYSQL_PASSWORD"),
    database: requiredEnv("MYSQL_DATABASE"),
    waitForConnections: true,
    connectionLimit: 10,
    decimalNumbers: true,
  });

  return { redis, mysql: mysqlPool };
}

export async function connectTradingClients(
  clients: TradingClients,
): Promise<void> {
  if (!clients.redis.isOpen) {
    await clients.redis.connect();
  }
  await clients.mysql.query("SELECT 1");
}

export async function closeTradingClients(
  clients: TradingClients,
): Promise<void> {
  if (clients.redis.isOpen) {
    await clients.redis.quit();
  }
  await clients.mysql.end();
}

export async function enqueueTrade(
  redis: TradingRedisClient,
  request: TradeRequest,
): Promise<EnqueuedTrade> {
  validateRequest(request);

  const eventId = await redis.xAdd(TRADE_REQUEST_STREAM, "*", {
    account_id: String(request.accountId),
    stock_id: String(request.stockId),
    side: request.side,
    quantity: String(request.quantity),
  });

  await redis.hSet(statusKey(eventId), {
    event_id: eventId,
    status: "PENDING",
    account_id: String(request.accountId),
    stock_id: String(request.stockId),
    side: request.side,
    quantity: String(request.quantity),
  });
  await redis.hIncrBy(TRADE_ANALYTICS_KEY, "requested_trades", 1);
  await redis.hIncrBy(TRADE_ANALYTICS_KEY, "queued_trades", 1);
  await redis.zIncrBy(
    STOCK_REQUEST_RANKING_KEY,
    1,
    String(request.stockId),
  );

  return { eventId, status: "PENDING" };
}

interface StagedEvent extends RowDataPacket {
  event_id: string;
  status: "STAGED" | "PROCESSED" | "REJECTED";
  order_id: number | null;
  execution_price: number | null;
  error_message: string | null;
}

type StreamEvent = {
  id: string;
  message: Record<string, string>;
};

async function stageEvents(
  connection: PoolConnection,
  batchId: string,
  events: StreamEvent[],
): Promise<void> {
  await connection.beginTransaction();
  try {
    for (const event of events) {
      const { account_id, stock_id, side, quantity } = event.message;
      await connection.execute(
        `INSERT INTO trade_request_staging
          (event_id, batch_id, account_id, stock_id, side, quantity)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           batch_id = IF(status = 'STAGED', VALUES(batch_id), batch_id)`,
        [
          event.id,
          batchId,
          asPositiveInteger(Number(account_id), "account_id"),
          asPositiveInteger(Number(stock_id), "stock_id"),
          side,
          asPositiveInteger(Number(quantity), "quantity"),
        ],
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function updateRedisStatus(
  redis: TradingRedisClient,
  event: StreamEvent,
  staged: StagedEvent,
): Promise<TradeStatusResult> {
  const key = statusKey(event.id);
  const previousStatus = await redis.hGet(key, "status");
  const status = staged.status as Exclude<TradeStatus, "UNKNOWN">;

  if (previousStatus !== status) {
    const values: Record<string, string> = { status };
    if (staged.order_id !== null) values.order_id = String(staged.order_id);
    if (staged.execution_price !== null) {
      values.execution_price = String(staged.execution_price);
    }
    if (staged.error_message !== null) {
      values.error_message = staged.error_message;
    }
    await redis.hSet(key, values);

    if (status === "PROCESSED") {
      await redis.hIncrBy(TRADE_ANALYTICS_KEY, "queued_trades", -1);
      await redis.hIncrBy(TRADE_ANALYTICS_KEY, "processed_trades", 1);
      if (staged.execution_price !== null) {
        await redis.hIncrByFloat(
          TRADE_ANALYTICS_KEY,
          "processed_value",
          staged.execution_price * Number(event.message.quantity),
        );
      }
    } else {
      await redis.hIncrBy(TRADE_ANALYTICS_KEY, "queued_trades", -1);
      await redis.hIncrBy(TRADE_ANALYTICS_KEY, "rejected_trades", 1);
      await redis.xAdd(TRADE_REJECTION_STREAM, "*", {
        event_id: event.id,
        account_id: event.message.account_id,
        stock_id: event.message.stock_id,
        side: event.message.side,
        quantity: event.message.quantity,
        error_message: staged.error_message ?? "Trade rejected",
      });
    }
  }

  return {
    eventId: event.id,
    status,
    accountId: Number(event.message.account_id),
    stockId: Number(event.message.stock_id),
    side: event.message.side as TradeSide,
    quantity: Number(event.message.quantity),
    orderId: staged.order_id ?? undefined,
    executionPrice: staged.execution_price ?? undefined,
    errorMessage: staged.error_message ?? undefined,
  };
}

export async function flushTradeBatch(
  clients: TradingClients,
  batchSize = 100,
): Promise<FlushResult> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error("batchSize must be a positive integer");
  }

  const lastId = (await clients.redis.get(TRADE_CHECKPOINT_KEY)) ?? "0-0";
  const events = await clients.redis.xRange(
    TRADE_REQUEST_STREAM,
    `(${lastId}`,
    "+",
    { COUNT: batchSize },
  );

  if (events.length === 0) {
    return {
      batchId: "",
      processed: [],
      rejected: [],
      checkpoint: lastId,
    };
  }

  const batchId = randomUUID().replaceAll("-", "");
  const normalizedEvents: StreamEvent[] = events.map((event) => ({
    id: event.id,
    message: event.message,
  }));
  const connection = await clients.mysql.getConnection();

  try {
    await stageEvents(connection, batchId, normalizedEvents);
    await connection.query("CALL flush_trade_batch(?)", [batchId]);

    const placeholders = normalizedEvents.map(() => "?").join(", ");
    const [rows] = await connection.query<StagedEvent[]>(
      `SELECT event_id, status, order_id, execution_price, error_message
       FROM trade_request_staging
       WHERE event_id IN (${placeholders})`,
      normalizedEvents.map((event) => event.id),
    );
    const stagedById = new Map(rows.map((row) => [row.event_id, row]));
    const processed: string[] = [];
    const rejected: Array<{ eventId: string; errorMessage: string }> = [];

    for (const event of normalizedEvents) {
      const staged = stagedById.get(event.id);
      if (!staged || staged.status === "STAGED") {
        throw new Error(`Event ${event.id} was not finalized by MySQL`);
      }

      const status = await updateRedisStatus(clients.redis, event, staged);
      if (status.status === "PROCESSED") {
        processed.push(event.id);
      } else {
        rejected.push({
          eventId: event.id,
          errorMessage: status.errorMessage ?? "Trade rejected",
        });
      }
    }

    const checkpoint = normalizedEvents[normalizedEvents.length - 1].id;
    await clients.redis.set(TRADE_CHECKPOINT_KEY, checkpoint);

    return { batchId, processed, rejected, checkpoint };
  } finally {
    connection.release();
  }
}

export async function getTradeStatus(
  redis: TradingRedisClient,
  eventId: string,
): Promise<TradeStatusResult> {
  const values = await redis.hGetAll(statusKey(eventId));
  if (Object.keys(values).length === 0) {
    return { eventId, status: "UNKNOWN" };
  }

  return {
    eventId,
    status: values.status as TradeStatus,
    accountId: values.account_id ? Number(values.account_id) : undefined,
    stockId: values.stock_id ? Number(values.stock_id) : undefined,
    side: values.side as TradeSide | undefined,
    quantity: values.quantity ? Number(values.quantity) : undefined,
    orderId: values.order_id ? Number(values.order_id) : undefined,
    executionPrice: values.execution_price
      ? Number(values.execution_price)
      : undefined,
    errorMessage: values.error_message,
  };
}

export async function getCachedAnalytics(
  redis: TradingRedisClient,
): Promise<CachedAnalytics> {
  const [counters, topRequestedStocks] = await Promise.all([
    redis.hGetAll(TRADE_ANALYTICS_KEY),
    redis.zRangeWithScores(STOCK_REQUEST_RANKING_KEY, 0, 9, { REV: true }),
  ]);

  return {
    counters,
    topRequestedStocks: topRequestedStocks.map((entry) => ({
      stockId: entry.value,
      score: entry.score,
    })),
  };
}
