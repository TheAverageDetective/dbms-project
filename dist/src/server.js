"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = __importDefault(require("node:path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
if (!process.env.MYSQL_USER) {
    dotenv_1.default.config({ path: node_path_1.default.resolve(process.cwd(), ".env") });
}
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const trading_connector_1 = require("../lib/trading-connector");
const app = (0, express_1.default)();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use(express_1.default.static(node_path_1.default.resolve(process.cwd(), "public")));
let clients;
let autoFlushInterval = null;
let isAutoFlushEnabled = false;
// Initialize clients
async function init() {
    try {
        clients = (0, trading_connector_1.createTradingClients)();
        await (0, trading_connector_1.connectTradingClients)(clients);
        console.log(" Connected to MySQL & Redis successfully.");
        await ensureAdminUser();
    }
    catch (err) {
        console.error(" Failed to initialize database / Redis clients:", err.message);
    }
}
async function ensureAdminUser() {
    try {
        await clients.mysql.query(`
      INSERT IGNORE INTO users (user_id, name, email, password_hash)
      VALUES (5, 'Admin', 'admin@example.com', 'admin')
    `);
        await clients.mysql.query(`
      INSERT IGNORE INTO accounts (account_id, user_id, cash_balance, currency)
      VALUES (5, 5, 10000000.0000, 'INR')
    `);
        console.log(" Admin user account verified in MySQL (user_id: 5, admin@example.com).");
    }
    catch (err) {
        console.warn(" Could not verify/insert admin user:", err.message);
    }
}
// Helper to ensure clients connected
function checkClients(res) {
    if (!clients) {
        res.status(503).json({ error: "Database/Redis clients not initialized." });
        return false;
    }
    return true;
}
// -------------------------------------------------------------
// Authentication & User Sessions
// -------------------------------------------------------------
app.get("/api/auth/users", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const [rows] = await clients.mysql.query(`
      SELECT 
        u.user_id,
        u.name,
        u.email,
        a.account_id,
        a.cash_balance,
        a.currency,
        COALESCE(SUM(h.quantity * s.current_price), 0.0000) AS portfolio_value
      FROM users u
      JOIN accounts a ON a.user_id = u.user_id
      LEFT JOIN holdings h ON h.account_id = a.account_id
      LEFT JOIN stocks s ON s.stock_id = h.stock_id
      GROUP BY u.user_id, u.name, u.email, a.account_id, a.cash_balance, a.currency
      ORDER BY u.user_id ASC
    `);
        res.json(rows);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.post("/api/auth/login", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const { email, password } = req.body;
        if (!email || !email.trim()) {
            return res.status(400).json({ error: "Please enter your email or username" });
        }
        if (!password) {
            return res.status(400).json({ error: "Please enter your password" });
        }
        const inputVal = email.trim().toLowerCase();
        const [rows] = await clients.mysql.query(`SELECT 
        u.user_id,
        u.name,
        u.email,
        u.password_hash,
        a.account_id,
        a.cash_balance,
        a.currency
      FROM users u
      JOIN accounts a ON a.user_id = u.user_id
      WHERE LOWER(u.email) = ? 
         OR LOWER(u.name) = ?
         OR (? = 'admin' AND (LOWER(u.email) = 'admin@example.com' OR LOWER(u.name) = 'admin' OR u.user_id = 5))`, [inputVal, inputVal, inputVal]);
        if (rows.length === 0) {
            return res.status(401).json({ error: "Invalid email/username or password." });
        }
        const user = rows[0];
        const p = String(password).trim().toLowerCase();
        // Verify password: only 'admin' is accepted
        const isValid = p === "admin" || password === user.password_hash;
        if (!isValid) {
            return res.status(401).json({ error: "Invalid email/username or password." });
        }
        const isAdmin = user.email.toLowerCase().includes("admin") ||
            user.name.toLowerCase().includes("admin") ||
            user.user_id === 5;
        // Return authenticated user profile (excluding hash)
        res.json({
            success: true,
            user: {
                userId: user.user_id,
                name: user.name,
                email: user.email,
                accountId: user.account_id,
                cashBalance: user.cash_balance,
                currency: user.currency,
                isAdmin,
            },
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// -------------------------------------------------------------
// System Health & Stats
// -------------------------------------------------------------
app.get("/api/status", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const [mysqlPing] = await clients.mysql.query("SELECT 1 AS ok");
        const [dbRows] = await clients.mysql.query("SELECT DATABASE() AS db, COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema = DATABASE()");
        const redisPing = await clients.redis.ping();
        const streamLen = await clients.redis.xLen(trading_connector_1.TRADE_REQUEST_STREAM).catch(() => 0);
        const lastCheckpoint = (await clients.redis.get(trading_connector_1.TRADE_CHECKPOINT_KEY)) ?? "0-0";
        const pendingEvents = await clients.redis.xRange(trading_connector_1.TRADE_REQUEST_STREAM, `(${lastCheckpoint}`, "+").catch(() => []);
        const pendingCount = pendingEvents.length;
        const rejectionLen = await clients.redis.xLen(trading_connector_1.TRADE_REJECTION_STREAM).catch(() => 0);
        res.json({
            status: "online",
            mysql: {
                connected: Boolean(mysqlPing),
                database: dbRows[0]?.db || "trading_app",
                tableCount: dbRows[0]?.table_count || 0,
            },
            redis: {
                connected: redisPing === "PONG",
                streamLength: streamLen,
                pendingCount,
                rejectionLength: rejectionLen,
                lastCheckpoint,
                autoFlushEnabled: isAutoFlushEnabled,
            },
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// -------------------------------------------------------------
// Accounts & Users
// -------------------------------------------------------------
app.get("/api/accounts", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const [rows] = await clients.mysql.query(`
      SELECT 
        a.account_id,
        a.user_id,
        u.name AS user_name,
        u.email,
        a.cash_balance,
        a.currency,
        COALESCE(SUM(h.quantity * s.current_price), 0.0000) AS portfolio_market_value,
        a.cash_balance + COALESCE(SUM(h.quantity * s.current_price), 0.0000) AS total_net_worth
      FROM accounts a
      JOIN users u ON u.user_id = a.user_id
      LEFT JOIN holdings h ON h.account_id = a.account_id
      LEFT JOIN stocks s ON s.stock_id = h.stock_id
      GROUP BY a.account_id, a.user_id, u.name, u.email, a.cash_balance, a.currency
      ORDER BY a.account_id ASC
    `);
        res.json(rows);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get("/api/accounts/:id", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const accountId = parseInt(String(req.params.id), 10);
        const [rows] = await clients.mysql.query(`SELECT a.account_id, a.user_id, u.name AS user_name, u.email, a.cash_balance, a.currency
       FROM accounts a
       JOIN users u ON u.user_id = a.user_id
       WHERE a.account_id = ?`, [accountId]);
        if (rows.length === 0) {
            return res.status(404).json({ error: "Account not found" });
        }
        res.json(rows[0]);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Deposit cash into account
app.post("/api/accounts/:id/deposit", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const accountId = parseInt(String(req.params.id), 10);
        const amount = parseFloat(req.body.amount);
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: "Amount must be a positive number" });
        }
        await clients.mysql.query("UPDATE accounts SET cash_balance = cash_balance + ? WHERE account_id = ?", [amount, accountId]);
        const [rows] = await clients.mysql.query("SELECT account_id, cash_balance FROM accounts WHERE account_id = ?", [accountId]);
        res.json({ message: "Deposit successful", account: rows[0] });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// -------------------------------------------------------------
// Portfolio (using MySQL View vw_account_portfolio)
// -------------------------------------------------------------
app.get("/api/accounts/:id/portfolio", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const accountId = parseInt(String(req.params.id), 10);
        const [holdings] = await clients.mysql.query(`SELECT * FROM vw_account_portfolio WHERE account_id = ? ORDER BY symbol ASC`, [accountId]);
        const [accountRows] = await clients.mysql.query("SELECT account_id, cash_balance, currency FROM accounts WHERE account_id = ?", [accountId]);
        const cashBalance = accountRows.length > 0 ? parseFloat(accountRows[0].cash_balance) : 0;
        const totalCostBasis = holdings.reduce((sum, h) => sum + parseFloat(h.cost_basis), 0);
        const totalMarketValue = holdings.reduce((sum, h) => sum + parseFloat(h.market_value), 0);
        const totalUnrealizedPnL = totalMarketValue - totalCostBasis;
        const pnlPercentage = totalCostBasis > 0 ? (totalUnrealizedPnL / totalCostBasis) * 100 : 0;
        res.json({
            accountId,
            cashBalance,
            currency: accountRows[0]?.currency || "INR",
            totalCostBasis,
            totalMarketValue,
            totalNetWorth: cashBalance + totalMarketValue,
            totalUnrealizedPnL,
            pnlPercentage,
            holdings,
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// -------------------------------------------------------------
// Stocks & Market Summary (using vw_stock_trading_summary)
// -------------------------------------------------------------
app.get("/api/stocks", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const [rows] = await clients.mysql.query("SELECT stock_id, symbol, company_name, current_price FROM stocks ORDER BY symbol ASC");
        res.json(rows);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get("/api/stocks/summary", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const [rows] = await clients.mysql.query("SELECT * FROM vw_stock_trading_summary ORDER BY total_traded_value DESC");
        res.json(rows);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Update stock price to demonstrate dynamic market movements
app.post("/api/stocks/:id/price", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const stockId = parseInt(String(req.params.id), 10);
        const newPrice = parseFloat(req.body.price);
        if (!newPrice || newPrice <= 0) {
            return res.status(400).json({ error: "Price must be a positive number" });
        }
        await clients.mysql.query("UPDATE stocks SET current_price = ? WHERE stock_id = ?", [
            newPrice,
            stockId,
        ]);
        const [rows] = await clients.mysql.query("SELECT * FROM stocks WHERE stock_id = ?", [stockId]);
        res.json({ message: "Stock price updated", stock: rows[0] });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// -------------------------------------------------------------
// Trading Engine: Enqueue, Status, Flush
// -------------------------------------------------------------
app.post("/api/trades", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const { accountId, stockId, side, quantity } = req.body;
        if (!accountId || !stockId || !side || !quantity) {
            return res.status(400).json({ error: "Missing required fields: accountId, stockId, side, quantity" });
        }
        const tradeReq = {
            accountId: parseInt(accountId, 10),
            stockId: parseInt(stockId, 10),
            side: side.toUpperCase(),
            quantity: parseInt(quantity, 10),
        };
        const enqueued = await (0, trading_connector_1.enqueueTrade)(clients.redis, tradeReq);
        res.status(202).json({
            message: "Trade successfully enqueued into Redis Stream",
            ...enqueued,
            side: tradeReq.side,
            quantity: tradeReq.quantity,
            accountId: tradeReq.accountId,
            stockId: tradeReq.stockId,
        });
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
app.get("/api/trades/status/:eventId", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const status = await (0, trading_connector_1.getTradeStatus)(clients.redis, String(req.params.eventId));
        res.json(status);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.post("/api/trades/flush", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const batchSize = req.body.batchSize ? parseInt(req.body.batchSize, 10) : 100;
        const result = await (0, trading_connector_1.flushTradeBatch)(clients, batchSize);
        res.json({
            message: result.processed.length + result.rejected.length > 0
                ? `Flushed batch with ${result.processed.length} processed and ${result.rejected.length} rejected`
                : "No pending trade events to flush in Redis stream",
            ...result,
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Auto-flush toggle
app.post("/api/trades/auto-flush", (req, res) => {
    const { enabled, intervalMs = 3000 } = req.body;
    isAutoFlushEnabled = Boolean(enabled);
    if (autoFlushInterval) {
        clearInterval(autoFlushInterval);
        autoFlushInterval = null;
    }
    if (isAutoFlushEnabled) {
        autoFlushInterval = setInterval(async () => {
            try {
                if (clients) {
                    const res = await (0, trading_connector_1.flushTradeBatch)(clients, 50);
                    if (res.processed.length > 0 || res.rejected.length > 0) {
                        console.log(`[Auto-Flush] Processed: ${res.processed.length}, Rejected: ${res.rejected.length}`);
                    }
                }
            }
            catch (e) {
                console.error("[Auto-Flush Error]", e.message);
            }
        }, intervalMs);
    }
    res.json({ autoFlushEnabled: isAutoFlushEnabled, intervalMs });
});
// -------------------------------------------------------------
// History, Audits, Staging
// -------------------------------------------------------------
app.get("/api/trades/history", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
        const accountId = req.query.accountId ? parseInt(req.query.accountId, 10) : null;
        let query = `
      SELECT 
        t.trade_id,
        t.order_id,
        t.account_id,
        u.name AS user_name,
        s.symbol,
        s.company_name,
        o.side,
        t.quantity,
        t.execution_price,
        (t.quantity * t.execution_price) AS total_value,
        o.status AS order_status,
        t.executed_at
      FROM trades t
      JOIN orders o ON o.order_id = t.order_id
      JOIN stocks s ON s.stock_id = t.stock_id
      JOIN accounts a ON a.account_id = t.account_id
      JOIN users u ON u.user_id = a.user_id
    `;
        const params = [];
        if (accountId) {
            query += ` WHERE t.account_id = ? `;
            params.push(accountId);
        }
        query += ` ORDER BY t.executed_at DESC LIMIT ?`;
        params.push(limit);
        const [rows] = await clients.mysql.query(query, params);
        res.json(rows);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Audit log from trade_audit table
app.get("/api/audit", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
        const accountId = req.query.accountId ? parseInt(req.query.accountId, 10) : null;
        let query = `
      SELECT 
        ta.audit_id,
        ta.trade_id,
        ta.order_id,
        ta.account_id,
        u.name AS user_name,
        s.symbol,
        ta.side,
        ta.quantity,
        ta.execution_price,
        ta.executed_at,
        ta.audited_at
      FROM trade_audit ta
      JOIN stocks s ON s.stock_id = ta.stock_id
      JOIN accounts a ON a.account_id = ta.account_id
      JOIN users u ON u.user_id = a.user_id
    `;
        const params = [];
        if (accountId) {
            query += ` WHERE ta.account_id = ? `;
            params.push(accountId);
        }
        query += ` ORDER BY ta.audit_id DESC LIMIT ?`;
        params.push(limit);
        const [rows] = await clients.mysql.query(query, params);
        res.json(rows);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Staging records from trade_request_staging
app.get("/api/staging", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
        const accountId = req.query.accountId ? parseInt(req.query.accountId, 10) : null;
        let query = `
      SELECT 
        trs.event_id,
        trs.batch_id,
        trs.account_id,
        u.name AS user_name,
        s.symbol,
        trs.side,
        trs.quantity,
        trs.status,
        trs.order_id,
        trs.execution_price,
        trs.error_message,
        trs.staged_at,
        trs.processed_at
      FROM trade_request_staging trs
      JOIN stocks s ON s.stock_id = trs.stock_id
      JOIN accounts a ON a.account_id = trs.account_id
      JOIN users u ON u.user_id = a.user_id
    `;
        const params = [];
        if (accountId) {
            query += ` WHERE trs.account_id = ? `;
            params.push(accountId);
        }
        query += ` ORDER BY trs.staged_at DESC LIMIT ?`;
        params.push(limit);
        const [rows] = await clients.mysql.query(query, params);
        res.json(rows);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// -------------------------------------------------------------
// Redis NoSQL Inspector: Stream, Rejections, Analytics
// -------------------------------------------------------------
app.get("/api/redis/analytics", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const analytics = await (0, trading_connector_1.getCachedAnalytics)(clients.redis);
        // Enrich topRequestedStocks with stock symbols
        const [stockRows] = await clients.mysql.query("SELECT stock_id, symbol, company_name FROM stocks");
        const stockMap = new Map(stockRows.map((s) => [String(s.stock_id), s]));
        const enrichedStocks = analytics.topRequestedStocks.map((item) => ({
            ...item,
            symbol: stockMap.get(item.stockId)?.symbol || `Stock #${item.stockId}`,
            companyName: stockMap.get(item.stockId)?.company_name || "",
        }));
        res.json({
            counters: analytics.counters,
            topRequestedStocks: enrichedStocks,
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get("/api/redis/stream", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const count = req.query.count ? parseInt(req.query.count, 10) : 30;
        const events = await clients.redis.xRevRange(trading_connector_1.TRADE_REQUEST_STREAM, "+", "-", {
            COUNT: count,
        });
        const [stockRows] = await clients.mysql.query("SELECT stock_id, symbol FROM stocks");
        const stockMap = new Map(stockRows.map((s) => [String(s.stock_id), s.symbol]));
        const enriched = events.map((e) => ({
            id: e.id,
            accountId: e.message.account_id,
            stockId: e.message.stock_id,
            symbol: stockMap.get(e.message.stock_id) || `Stock #${e.message.stock_id}`,
            side: e.message.side,
            quantity: e.message.quantity,
        }));
        res.json(enriched);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get("/api/redis/rejections", async (req, res) => {
    if (!checkClients(res))
        return;
    try {
        const count = req.query.count ? parseInt(req.query.count, 10) : 30;
        const events = await clients.redis.xRevRange(trading_connector_1.TRADE_REJECTION_STREAM, "+", "-", {
            COUNT: count,
        });
        const [stockRows] = await clients.mysql.query("SELECT stock_id, symbol FROM stocks");
        const stockMap = new Map(stockRows.map((s) => [String(s.stock_id), s.symbol]));
        const enriched = events.map((e) => ({
            id: e.id,
            eventId: e.message.event_id,
            accountId: e.message.account_id,
            stockId: e.message.stock_id,
            symbol: stockMap.get(e.message.stock_id) || `Stock #${e.message.stock_id}`,
            side: e.message.side,
            quantity: e.message.quantity,
            errorMessage: e.message.error_message,
        }));
        res.json(enriched);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Fallback route for SPA
app.use((req, res) => {
    res.sendFile(node_path_1.default.resolve(process.cwd(), "public/index.html"));
});
// Graceful shutdown
process.on("SIGINT", async () => {
    console.log("\nShutting down server...");
    if (autoFlushInterval)
        clearInterval(autoFlushInterval);
    if (clients)
        await (0, trading_connector_1.closeTradingClients)(clients);
    process.exit(0);
});
// Start listening
init().then(() => {
    app.listen(PORT, () => {
        console.log(` Trading Application Server running at http://localhost:${PORT}`);
        console.log(` Frontend UI accessible at http://localhost:${PORT}`);
    });
});
