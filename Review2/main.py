"""Simple Redis-first trading demo.

New trades are accepted into a Redis Stream first. The flush command later
persists a batch of stream entries to MySQL in one transaction.

Examples:
    python main.py demo
    python main.py enqueue --account-id 1 --stock-id 2 --quantity 3 --price 4100
    python main.py flush
    python main.py dashboard
"""

import argparse
import os
import time
import uuid
from decimal import Decimal, InvalidOperation

import mysql.connector
import redis


STREAM_KEY = "trading:trade_events"
CHECKPOINT_KEY = "trading:trade_events:last_flushed_id"
STOCK_RANKING_KEY = "trading:stock:volume"
ACCOUNT_RANKING_KEY = "trading:account:activity"
SUMMARY_KEY = "trading:dashboard:summary"


def connect_mysql():
    return mysql.connector.connect(
        host=os.getenv("MYSQL_HOST", "127.0.0.1"),
        user=os.getenv("MYSQL_USER", "root"),
        password=os.getenv("MYSQL_PASSWORD", "12345678"),
        database=os.getenv("MYSQL_DATABASE", "trading_app"),
    )


def connect_redis():
    client = redis.Redis(
        host=os.getenv("REDIS_HOST", "127.0.0.1"),
        port=int(os.getenv("REDIS_PORT", "6379")),
        decode_responses=True,
    )
    client.ping()
    return client


def money(value):
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError):
        raise ValueError("price must be a valid number")
    if result <= 0:
        raise ValueError("price must be positive")
    return result


def enqueue_trade(redis_client, account_id, stock_id, quantity, price, side="BUY"):
    """Accept a trade into Redis without contacting MySQL."""
    side = side.upper()
    if side not in ("BUY", "SELL"):
        raise ValueError("side must be BUY or SELL")
    if int(quantity) <= 0:
        raise ValueError("quantity must be positive")

    price = money(price)
    event_id = redis_client.xadd(
        STREAM_KEY,
        {
            "account_id": int(account_id),
            "stock_id": int(stock_id),
            "side": side,
            "quantity": int(quantity),
            "price": str(price),
        },
    )

    value = price * int(quantity)
    redis_client.hincrby(SUMMARY_KEY, "total_trades", 1)
    redis_client.hincrby(SUMMARY_KEY, "pending_trades", 1)
    redis_client.hincrbyfloat(SUMMARY_KEY, "total_traded_value", float(value))
    redis_client.hincrby(f"trading:stock:{stock_id}", "total_trades", 1)
    redis_client.hincrby(f"trading:stock:{stock_id}", "total_shares", int(quantity))
    redis_client.hincrbyfloat(f"trading:stock:{stock_id}", "total_value", float(value))
    redis_client.zincrby(STOCK_RANKING_KEY, float(value), str(stock_id))
    redis_client.zincrby(ACCOUNT_RANKING_KEY, float(value), str(account_id))
    return event_id


def flush_pending_trades(redis_client, batch_size=100):
    """Stage and flush the next Redis batch through the MySQL procedure."""
    last_id = redis_client.get(CHECKPOINT_KEY) or "0-0"
    events = redis_client.xrange(
        STREAM_KEY,
        min=f"({last_id}",
        max="+",
        count=batch_size,
    )
    if not events:
        print("No pending Redis trades to flush.")
        return 0

    db = connect_mysql()
    cursor = db.cursor()
    batch_id = uuid.uuid4().hex
    try:
        db.start_transaction()
        for event_id, event in events:
            cursor.execute(
                "INSERT IGNORE INTO trade_flush_staging "
                "(event_id, batch_id, account_id, stock_id, side, quantity, execution_price) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (
                    event_id,
                    batch_id,
                    int(event["account_id"]),
                    int(event["stock_id"]),
                    event["side"].upper(),
                    int(event["quantity"]),
                    Decimal(event["price"]),
                ),
            )
        cursor.execute("CALL flush_trade_batch(%s)", (batch_id,))
        db.commit()
        redis_client.set(CHECKPOINT_KEY, events[-1][0])
        redis_client.hincrby(SUMMARY_KEY, "pending_trades", -len(events))
        print(f"Flushed {len(events)} trade(s) from Redis to MySQL.")
        return len(events)
    except Exception:
        db.rollback()
        print("Flush failed; MySQL rolled back and Redis checkpoint was not advanced.")
        raise
    finally:
        cursor.close()
        db.close()


def show_dashboard(redis_client):
    summary = redis_client.hgetall(SUMMARY_KEY)
    print("\n" + "=" * 50)
    print("       REDIS-FIRST TRADING DASHBOARD")
    print("=" * 50)
    print("Queued trade events:", summary.get("total_trades", "0"))
    print("Pending Redis trades:", summary.get("pending_trades", "0"))
    print("Total traded value: ₹", summary.get("total_traded_value", "0"))

    print("\nTOP STOCK ACTIVITY")
    for rank, (stock_id, score) in enumerate(
        redis_client.zrevrange(STOCK_RANKING_KEY, 0, 4, withscores=True), start=1
    ):
        details = redis_client.hgetall(f"trading:stock:{stock_id}")
        print(
            f"{rank}. Stock {stock_id} | "
            f"Trades: {details.get('total_trades', 0)} | "
            f"Shares: {details.get('total_shares', 0)} | "
            f"Value: ₹{float(details.get('total_value', 0)):,.2f}"
        )

    print("\nTOP INVESTOR ACTIVITY")
    for rank, (account_id, score) in enumerate(
        redis_client.zrevrange(ACCOUNT_RANKING_KEY, 0, 4, withscores=True), start=1
    ):
        print(f"{rank}. Account {account_id} | Value: ₹{score:,.2f}")


def run_demo(redis_client):
    print("Adding demo trades to Redis...")
    examples = [(1, 2, 3, "4100.00", "BUY"), (2, 8, 5, "540.00", "BUY")]
    for account_id, stock_id, quantity, price, side in examples:
        event_id = enqueue_trade(
            redis_client, account_id, stock_id, quantity, price, side
        )
        print(f"Queued {side} event {event_id} in Redis")
    show_dashboard(redis_client)
    print("\nRun `python main.py flush` to persist these events to MySQL.")


def parse_args():
    parser = argparse.ArgumentParser(description="Redis-first trading demo")
    subparsers = parser.add_subparsers(dest="command")

    enqueue = subparsers.add_parser("enqueue", help="put one trade into Redis")
    enqueue.add_argument("--account-id", type=int, required=True)
    enqueue.add_argument("--stock-id", type=int, required=True)
    enqueue.add_argument("--quantity", type=int, required=True)
    enqueue.add_argument("--price", required=True)
    enqueue.add_argument("--side", choices=("BUY", "SELL"), default="BUY")

    flush = subparsers.add_parser("flush", help="flush Redis trades into MySQL")
    flush.add_argument("--batch-size", type=int, default=100)
    loop = subparsers.add_parser(
        "flush-loop", help="flush Redis trades periodically"
    )
    loop.add_argument("--batch-size", type=int, default=100)
    loop.add_argument("--interval", type=float, default=10)
    subparsers.add_parser("dashboard", help="show Redis activity")
    subparsers.add_parser("demo", help="queue a couple of demo trades")
    return parser.parse_args()


def main():
    args = parse_args()
    command = args.command or "demo"
    redis_client = connect_redis()

    if command == "enqueue":
        event_id = enqueue_trade(
            redis_client,
            args.account_id,
            args.stock_id,
            args.quantity,
            args.price,
            args.side,
        )
        print(f"Queued {args.side} trade in Redis with event id {event_id}.")
    elif command == "flush":
        flush_pending_trades(redis_client, args.batch_size)
    elif command == "flush-loop":
        print(f"Flushing every {args.interval:g} second(s). Press Ctrl+C to stop.")
        try:
            while True:
                flush_pending_trades(redis_client, args.batch_size)
                time.sleep(args.interval)
        except KeyboardInterrupt:
            print("\nFlush loop stopped.")
    elif command == "dashboard":
        show_dashboard(redis_client)
    else:
        run_demo(redis_client)


if __name__ == "__main__":
    main()
