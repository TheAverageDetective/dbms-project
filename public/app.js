// NexusTrade Frontend Application Logic
// Team 10 - DBMS Level 3 Mini-Project

let activeAccountId = 1;
let currentAuthUser = null;
let registeredUsers = [];
let currentSide = 'BUY';
let stocks = [];
let accounts = [];
let portfolio = { holdings: [] };
let chartInstance = null;
let autoFlushState = false;

// -----------------------------------------------------------------------------
// Formatters
// -----------------------------------------------------------------------------
function formatINR(val) {
  const num = Number(val || 0);
  return '₹ ' + num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatNumber(val) {
  return Number(val || 0).toLocaleString('en-IN');
}

function formatDate(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  return d.toLocaleTimeString() + ' ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// -----------------------------------------------------------------------------
// Toast Notifications
// -----------------------------------------------------------------------------
function showToast(title, message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `pointer-events-auto flex items-start space-x-3 p-3.5 rounded-xl shadow-2xl border text-xs max-w-sm fade-in transition-all duration-300 ${
    type === 'success'
      ? 'bg-slate-900/95 border-emerald-500/40 text-emerald-300'
      : type === 'error'
      ? 'bg-slate-900/95 border-rose-500/40 text-rose-300'
      : type === 'warning'
      ? 'bg-slate-900/95 border-amber-500/40 text-amber-300'
      : 'bg-slate-900/95 border-cyan-500/40 text-cyan-300'
  }`;

  const iconName =
    type === 'success' ? 'check-circle' : type === 'error' ? 'alert-triangle' : type === 'warning' ? 'clock' : 'info';

  toast.innerHTML = `
    <i data-lucide="${iconName}" class="w-4 h-4 shrink-0 mt-0.5"></i>
    <div class="flex-1">
      <div class="font-bold text-white">${title}</div>
      <div class="text-slate-300 mt-0.5">${message}</div>
    </div>
  `;

  container.appendChild(toast);
  lucide.createIcons();

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// -----------------------------------------------------------------------------
// Tab Switching
// -----------------------------------------------------------------------------
function switchTab(tabName) {
  if (tabName === 'redis' && (!currentAuthUser || !currentAuthUser.isAdmin)) {
    showToast('Admin Access Required', 'The Execution Queue is reserved for Administrator accounts.', 'warning');
    return;
  }
  const tabs = ['markets', 'portfolio', 'orders', 'redis'];
  tabs.forEach((t) => {
    const content = document.getElementById(`content-${t}`);
    const btn = document.getElementById(`tab-${t}`);
    if (t === tabName) {
      content?.classList.remove('hidden');
      btn?.classList.add('active', 'text-cyan-400', 'border-cyan-400');
      btn?.classList.remove('text-slate-400', 'border-transparent');
    } else {
      content?.classList.add('hidden');
      btn?.classList.remove('active', 'text-cyan-400', 'border-cyan-400');
      btn?.classList.add('text-slate-400', 'border-transparent');
    }
  });

  // Trigger tab-specific refresh
  if (tabName === 'portfolio') loadPortfolio();
  if (tabName === 'orders') {
    loadTradesHistory();
    loadAuditLog();
    loadStagingRows();
  }
  if (tabName === 'redis') {
    loadRedisStream();
    loadRedisAnalytics();
    loadRedisRejections();
  }
  lucide.createIcons();
}

// -----------------------------------------------------------------------------
// Data Fetchers
// -----------------------------------------------------------------------------
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (!data || data.error) return;

    // MySQL Indicator
    const mysqlDot = document.getElementById('mysql-status-dot');
    const mysqlDbLabel = document.getElementById('mysql-db-label');
    if (mysqlDot) {
      mysqlDot.className = data.mysql?.connected ? 'pulse-dot online' : 'pulse-dot bg-rose-500';
    }
    if (mysqlDbLabel) {
      mysqlDbLabel.textContent = data.mysql?.connected ? 'Online' : 'Offline';
    }

    // Redis Indicator & Stream Length
    const redisPending = document.getElementById('redis-pending-count');
    const flushBadge = document.getElementById('flush-badge');
    const statPending = document.getElementById('stat-redis-pending');
    const lastCheckpoint = document.getElementById('redis-last-checkpoint');

    const pendingCount = data.redis?.pendingCount ?? 0;
    const streamLen = data.redis?.streamLength || 0;
    if (redisPending) redisPending.textContent = pendingCount;
    if (flushBadge) flushBadge.textContent = pendingCount;
    if (statPending) {
      if (pendingCount > 0) {
        statPending.textContent = `${pendingCount} pending flush`;
        statPending.className = 'text-base font-bold text-amber-400 mt-1 font-mono';
      } else {
        statPending.textContent = `0 pending (${streamLen} logged)`;
        statPending.className = 'text-base font-bold text-emerald-400 mt-1 font-mono';
      }
    }
    if (lastCheckpoint) lastCheckpoint.textContent = data.redis?.lastCheckpoint || '0-0';

    // Auto-flush badge
    autoFlushState = Boolean(data.redis?.autoFlushEnabled);
    const autoFlushBtn = document.getElementById('btn-toggle-autoflush');
    if (autoFlushBtn) {
      autoFlushBtn.textContent = autoFlushState ? 'ON' : 'OFF';
      autoFlushBtn.className = autoFlushState
        ? 'text-[10px] font-semibold text-emerald-400 hover:text-emerald-300'
        : 'text-[10px] font-semibold text-rose-400 hover:text-rose-300';
    }
  } catch (err) {
    console.error('Error loading status:', err);
  }
}

async function loadAccounts() {
  try {
    const res = await fetch('/api/accounts');
    accounts = await res.json();
    if (!Array.isArray(accounts)) return;

    const select = document.getElementById('account-select');
    if (select) {
      const currentVal = select.value;
      select.innerHTML = accounts
        .map(
          (acc) =>
            `<option value="${acc.account_id}" ${
              acc.account_id == activeAccountId ? 'selected' : ''
            }>${acc.user_name} (Acc #${acc.account_id}) - ${formatINR(acc.cash_balance)}</option>`
        )
        .join('');
      if (currentVal && accounts.some((a) => a.account_id == currentVal)) {
        select.value = currentVal;
      }
    }

    // Update active account stat
    const activeAcc = accounts.find((a) => a.account_id == activeAccountId) || accounts[0];
    if (activeAcc) {
      activeAccountId = activeAcc.account_id;
      const statCash = document.getElementById('stat-cash');
      const statAccName = document.getElementById('stat-account-name');
      const depositAccName = document.getElementById('deposit-account-name');

      if (statCash) statCash.textContent = formatINR(activeAcc.cash_balance);
      if (statAccName) statAccName.textContent = `${activeAcc.user_name} (#${activeAcc.account_id})`;
      if (depositAccName) depositAccName.textContent = `${activeAcc.user_name} (Account #${activeAcc.account_id})`;
    }
  } catch (err) {
    console.error('Error loading accounts:', err);
  }
}

async function loadStocks() {
  try {
    const res = await fetch('/api/stocks');
    stocks = await res.json();
    if (!Array.isArray(stocks)) return;

    const tbody = document.getElementById('stocks-tbody');
    if (tbody) {
      tbody.innerHTML = stocks
        .map(
          (s) => `
        <tr class="hover:bg-slate-800/40 transition">
          <td class="font-bold text-white">
            <span class="px-2 py-0.5 rounded bg-slate-800 text-cyan-300 font-mono text-xs">${s.symbol}</span>
          </td>
          <td class="text-slate-300 text-xs">${s.company_name}</td>
          <td class="text-right font-mono font-bold text-white">${formatINR(s.current_price)}</td>
          <td class="text-right">
            <button onclick="openPriceModal(${s.stock_id}, '${s.symbol}', ${s.current_price})" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs border border-slate-700 transition" title="Simulate market price change">
              <i data-lucide="edit-3" class="w-3.5 h-3.5 inline text-cyan-400 mr-1"></i>Edit
            </button>
          </td>
          <td class="text-center">
            <div class="inline-flex space-x-1.5">
              <button onclick="prefillTrade(${s.stock_id}, 'BUY')" class="px-2.5 py-1 bg-emerald-500/20 hover:bg-emerald-500 text-emerald-300 hover:text-white rounded text-xs font-semibold transition border border-emerald-500/30">
                BUY
              </button>
              <button onclick="prefillTrade(${s.stock_id}, 'SELL')" class="px-2.5 py-1 bg-rose-500/20 hover:bg-rose-500 text-rose-300 hover:text-white rounded text-xs font-semibold transition border border-rose-500/30">
                SELL
              </button>
            </div>
          </td>
        </tr>
      `
        )
        .join('');
    }

    // Populate quick trade asset selector if needed
    const quickSelect = document.getElementById('quick-stock-select');
    if (quickSelect && quickSelect.children.length === 0) {
      quickSelect.innerHTML = stocks
        .map((s) => `<option value="${s.stock_id}">${s.symbol} - ${s.company_name} (${formatINR(s.current_price)})</option>`)
        .join('');
      updateQuickEstimate();
    }

    lucide.createIcons();
  } catch (err) {
    console.error('Error loading stocks:', err);
  }
}

async function loadSummary() {
  const summaryContainer = document.getElementById('stock-summary-container');
  const isAdmin = currentAuthUser?.isAdmin;

  if (!isAdmin) {
    if (summaryContainer) summaryContainer.classList.add('hidden');
  } else {
    if (summaryContainer) summaryContainer.classList.remove('hidden');
  }

  try {
    const res = await fetch('/api/stocks/summary');
    const summary = await res.json();
    if (!Array.isArray(summary)) return;

    const tbody = document.getElementById('summary-tbody');

    if (tbody && isAdmin) {
      tbody.innerHTML = summary
        .map((row) => {
          const tradedVal = parseFloat(row.total_traded_value || 0);
          return `
          <tr class="hover:bg-slate-800/40">
            <td class="font-mono font-bold text-cyan-300">${row.symbol}</td>
            <td class="text-slate-400 text-xs">${row.company_name}</td>
            <td class="text-right font-mono">${formatNumber(row.total_trades)}</td>
            <td class="text-right font-mono text-emerald-400">${formatNumber(row.bought_shares)}</td>
            <td class="text-right font-mono text-rose-400">${formatNumber(row.sold_shares)}</td>
            <td class="text-right font-mono font-bold text-white">${formatINR(tradedVal)}</td>
          </tr>
        `;
        })
        .join('');
    } else if (tbody && !isAdmin) {
      tbody.innerHTML = '';
    }

    const statTotalTraded = document.getElementById('stat-total-traded');
    if (statTotalTraded) {
      const sum = summary.reduce((acc, row) => acc + parseFloat(row.total_traded_value || 0), 0);
      statTotalTraded.textContent = formatINR(sum);
    }
  } catch (err) {
    console.error('Error loading summary:', err);
  }
}

async function loadPortfolio() {
  try {
    const res = await fetch(`/api/accounts/${activeAccountId}/portfolio`);
    portfolio = await res.json();
    if (!portfolio || portfolio.error) return;

    // Header & Global metrics
    const statMarketVal = document.getElementById('stat-market-val');
    const statTotalWorth = document.getElementById('stat-total-worth');
    const statPnl = document.getElementById('stat-pnl');
    const statPnlPct = document.getElementById('stat-pnl-pct');

    const portCash = document.getElementById('port-cash');
    const portCost = document.getElementById('port-cost');
    const portValue = document.getElementById('port-value');
    const portPnl = document.getElementById('port-pnl');
    const portPnlPct = document.getElementById('port-pnl-pct');
    const portCountBadge = document.getElementById('portfolio-count-badge');

    const isProfit = portfolio.totalUnrealizedPnL >= 0;
    const pnlPrefix = isProfit ? '+₹ ' : '-₹ ';
    const pnlAbs = Math.abs(portfolio.totalUnrealizedPnL);
    const pnlText = `${pnlPrefix}${pnlAbs.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const pnlPctText = `${isProfit ? '+' : ''}${portfolio.pnlPercentage.toFixed(2)}%`;

    if (statMarketVal) statMarketVal.textContent = formatINR(portfolio.totalMarketValue);
    if (statTotalWorth) statTotalWorth.textContent = `Net: ${formatINR(portfolio.totalNetWorth)}`;
    if (statPnl) {
      statPnl.textContent = pnlText;
      statPnl.className = `text-base font-bold mt-1 font-mono ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`;
    }
    if (statPnlPct) {
      statPnlPct.textContent = pnlPctText;
      statPnlPct.className = `text-[10px] block font-semibold ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`;
    }

    if (portCash) portCash.textContent = formatINR(portfolio.cashBalance);
    if (portCost) portCost.textContent = formatINR(portfolio.totalCostBasis);
    if (portValue) portValue.textContent = formatINR(portfolio.totalMarketValue);
    if (portPnl) {
      portPnl.textContent = pnlText;
      portPnl.className = `text-xl font-bold mt-1 font-mono ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`;
    }
    if (portPnlPct) {
      portPnlPct.textContent = pnlPctText;
      portPnlPct.className = `text-[11px] font-semibold ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`;
    }
    if (portCountBadge) portCountBadge.textContent = portfolio.holdings?.length || 0;

    // Holdings Table
    const tbody = document.getElementById('holdings-tbody');
    if (tbody) {
      if (portfolio.holdings && portfolio.holdings.length > 0) {
        tbody.innerHTML = portfolio.holdings
          .map((h) => {
            const hProfit = parseFloat(h.unrealized_pnl) >= 0;
            return `
            <tr class="hover:bg-slate-800/40">
              <td>
                <div class="font-bold text-white font-mono">${h.symbol}</div>
                <div class="text-[11px] text-slate-400 truncate max-w-[140px]">${h.company_name}</div>
              </td>
              <td class="text-right font-mono font-bold text-white">${formatNumber(h.quantity)}</td>
              <td class="text-right font-mono text-slate-300">${formatINR(h.average_cost)}</td>
              <td class="text-right font-mono text-white">${formatINR(h.current_price)}</td>
              <td class="text-right font-mono font-bold text-cyan-300">${formatINR(h.market_value)}</td>
              <td class="text-right font-mono font-bold ${hProfit ? 'text-emerald-400' : 'text-rose-400'}">
                ${hProfit ? '+' : ''}${formatINR(h.unrealized_pnl)}
              </td>
              <td class="text-center">
                <button onclick="prefillTrade(${h.stock_id}, 'SELL', ${h.quantity})" class="px-2.5 py-1 bg-rose-500/20 hover:bg-rose-500 text-rose-300 hover:text-white rounded text-xs font-semibold transition border border-rose-500/30">
                  SELL
                </button>
              </td>
            </tr>
          `;
          })
          .join('');
      } else {
        tbody.innerHTML = `
          <tr>
            <td colspan="7" class="text-center py-6 text-slate-500">
              No stock holdings in this portfolio yet. Use Quick Trade to BUY shares!
            </td>
          </tr>
        `;
      }
    }

    renderPortfolioChart();
    updateQuickHoldingHint();
  } catch (err) {
    console.error('Error loading portfolio:', err);
  }
}

function renderPortfolioChart() {
  const canvas = document.getElementById('portfolioChart');
  if (!canvas) return;

  const holdings = portfolio.holdings || [];
  const labels = holdings.map((h) => h.symbol);
  const values = holdings.map((h) => parseFloat(h.market_value));

  // Add available cash into allocation
  labels.push('Cash');
  values.push(parseFloat(portfolio.cashBalance || 0));

  const colors = [
    '#06b6d4',
    '#3b82f6',
    '#8b5cf6',
    '#ec4899',
    '#f59e0b',
    '#10b981',
    '#6366f1',
    '#14b8a6',
    '#64748b',
  ];

  if (chartInstance) {
    chartInstance.destroy();
  }

  const ctx = canvas.getContext('2d');
  chartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors.slice(0, labels.length),
          borderWidth: 2,
          borderColor: '#131b2e',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            boxWidth: 10,
            color: '#94a3b8',
            font: { size: 10 },
          },
        },
      },
      cutout: '68%',
    },
  });
}

async function loadTradesHistory() {
  try {
    const isFiltered = currentAuthUser && !currentAuthUser.isAdmin;
    const url = isFiltered
      ? `/api/trades/history?limit=50&accountId=${activeAccountId}`
      : `/api/trades/history?limit=50`;
    const res = await fetch(url);
    const trades = await res.json();
    if (!Array.isArray(trades)) return;

    const subtitle = document.getElementById('trades-subtitle');
    if (subtitle) {
      subtitle.textContent = isFiltered
        ? `Showing trade records for ${currentAuthUser.name} (Account #${activeAccountId})`
        : 'All confirmed transaction records across all user accounts (System Admin View)';
    }

    const tbody = document.getElementById('trades-tbody');
    if (tbody) {
      if (trades.length > 0) {
        tbody.innerHTML = trades
          .map(
            (t) => `
          <tr class="hover:bg-slate-800/40">
            <td class="font-mono text-cyan-400 font-bold">#${t.trade_id}</td>
            <td class="font-mono text-slate-400">#${t.order_id}</td>
            <td>
              <span class="text-white font-medium">${t.user_name}</span>
              <span class="text-[11px] text-slate-500 block font-mono">Acc #${t.account_id}</span>
            </td>
            <td class="font-mono font-bold text-slate-200">${t.symbol}</td>
            <td>
              <span class="px-2 py-0.5 rounded text-[11px] font-bold ${
                t.side === 'BUY' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
              }">${t.side}</span>
            </td>
            <td class="text-right font-mono font-bold text-white">${formatNumber(t.quantity)}</td>
            <td class="text-right font-mono text-slate-300">${formatINR(t.execution_price)}</td>
            <td class="text-right font-mono font-bold text-cyan-300">${formatINR(t.total_value)}</td>
            <td class="text-right font-mono text-slate-400 text-xs">${formatDate(t.executed_at)}</td>
          </tr>
        `
          )
          .join('');
      } else {
        tbody.innerHTML = `<tr><td colspan="9" class="text-center py-6 text-slate-500">No executed trades found for your account.</td></tr>`;
      }
    }
  } catch (err) {
    console.error('Error loading trades history:', err);
  }
}

async function loadAuditLog() {
  try {
    const isFiltered = currentAuthUser && !currentAuthUser.isAdmin;
    const url = isFiltered
      ? `/api/audit?limit=50&accountId=${activeAccountId}`
      : `/api/audit?limit=50`;
    const res = await fetch(url);
    const audits = await res.json();
    if (!Array.isArray(audits)) return;

    const subtitle = document.getElementById('audit-subtitle');
    if (subtitle) {
      subtitle.textContent = isFiltered
        ? `Showing audit trail for ${currentAuthUser.name} (Account #${activeAccountId})`
        : 'All compliance audit records across all user accounts (System Admin View)';
    }

    const tbody = document.getElementById('audit-tbody');
    if (tbody) {
      if (audits.length > 0) {
        tbody.innerHTML = audits
          .map(
            (a) => `
          <tr class="hover:bg-slate-800/40">
            <td class="font-mono text-yellow-400 font-bold">#${a.audit_id}</td>
            <td class="font-mono text-slate-400">#${a.trade_id}</td>
            <td class="font-mono text-slate-400">#${a.order_id}</td>
            <td class="text-white font-medium">${a.user_name}</td>
            <td class="font-mono text-cyan-300 font-bold">${a.symbol}</td>
            <td>
              <span class="px-2 py-0.5 rounded text-[10px] font-bold ${
                a.side === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
              }">${a.side}</span>
            </td>
            <td class="text-right font-mono text-white">${formatNumber(a.quantity)}</td>
            <td class="text-right font-mono text-slate-300">${formatINR(a.execution_price)}</td>
            <td class="text-right font-mono text-slate-400 text-xs">${formatDate(a.audited_at)}</td>
          </tr>
        `
          )
          .join('');
      } else {
        tbody.innerHTML = `<tr><td colspan="9" class="text-center py-6 text-slate-500">No audit records found for your account.</td></tr>`;
      }
    }
  } catch (err) {
    console.error('Error loading audit log:', err);
  }
}

async function loadStagingRows() {
  try {
    const isFiltered = currentAuthUser && !currentAuthUser.isAdmin;
    const url = isFiltered
      ? `/api/staging?limit=50&accountId=${activeAccountId}`
      : `/api/staging?limit=50`;
    const res = await fetch(url);
    const rows = await res.json();
    if (!Array.isArray(rows)) return;

    const subtitle = document.getElementById('staging-subtitle');
    if (subtitle) {
      subtitle.textContent = isFiltered
        ? `Showing staged requests for ${currentAuthUser.name} (Account #${activeAccountId})`
        : 'All staged orders in Redis/MySQL batch queue (System Admin View)';
    }

    const tbody = document.getElementById('staging-tbody');
    if (tbody) {
      if (rows.length > 0) {
        tbody.innerHTML = rows
          .map(
            (r) => `
          <tr class="hover:bg-slate-800/40">
            <td class="font-mono text-cyan-400 text-xs">${r.event_id}</td>
            <td class="font-mono text-slate-500 text-[10px] truncate max-w-[90px]" title="${r.batch_id}">${r.batch_id.slice(0, 8)}...</td>
            <td>${r.user_name}</td>
            <td class="font-mono font-bold text-white">${r.symbol}</td>
            <td>
              <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${
                r.side === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
              }">${r.side}</span>
            </td>
            <td class="text-right font-mono font-bold">${formatNumber(r.quantity)}</td>
            <td>
              <span class="px-2 py-0.5 rounded text-[10px] font-bold ${
                r.status === 'PROCESSED'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : r.status === 'REJECTED'
                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                  : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
              }">${r.status}</span>
            </td>
            <td class="text-xs ${r.error_message ? 'text-rose-400' : 'text-slate-400'}">
              ${r.error_message || (r.order_id ? `Order #${r.order_id} @ ${formatINR(r.execution_price)}` : '-')}
            </td>
            <td class="text-right font-mono text-slate-400 text-xs">${formatDate(r.staged_at)}</td>
          </tr>
        `
          )
          .join('');
      } else {
        tbody.innerHTML = `<tr><td colspan="9" class="text-center py-6 text-slate-500">No staged events found for your account.</td></tr>`;
      }
    }
  } catch (err) {
    console.error('Error loading staging:', err);
  }
}

async function loadRedisStream() {
  try {
    const res = await fetch('/api/redis/stream?count=20');
    const events = await res.json();
    if (!Array.isArray(events)) return;

    const tbody = document.getElementById('redis-stream-tbody');
    if (tbody) {
      if (events.length > 0) {
        tbody.innerHTML = events
          .map(
            (e) => `
          <tr class="hover:bg-slate-800/40">
            <td class="font-mono text-cyan-400 font-bold">${e.id}</td>
            <td class="font-mono text-slate-300">#${e.accountId}</td>
            <td class="font-mono text-white font-bold">${e.symbol}</td>
            <td>
              <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${
                e.side === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
              }">${e.side}</span>
            </td>
            <td class="text-right font-mono font-bold">${e.quantity}</td>
            <td class="text-center">
              <span id="status-${e.id.replace(/[^a-zA-Z0-9]/g, '_')}" class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400">
                Checking...
              </span>
            </td>
          </tr>
        `
          )
          .join('');

        // Fetch status for each event
        events.forEach(async (e) => {
          try {
            const statusRes = await fetch(`/api/trades/status/${e.id}`);
            const statusData = await statusRes.json();
            const el = document.getElementById(`status-${e.id.replace(/[^a-zA-Z0-9]/g, '_')}`);
            if (el && statusData) {
              el.textContent = statusData.status;
              el.className = `px-2 py-0.5 rounded text-[10px] font-bold ${
                statusData.status === 'PROCESSED'
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                  : statusData.status === 'REJECTED'
                  ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                  : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
              }`;
            }
          } catch (err) {
            console.error('Status check error:', err);
          }
        });
      } else {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-slate-500">No events currently in Redis Stream. Submit a trade!</td></tr>`;
      }
    }
  } catch (err) {
    console.error('Error loading redis stream:', err);
  }
}

async function loadRedisAnalytics() {
  try {
    const res = await fetch('/api/redis/analytics');
    const data = await res.json();
    if (!data) return;

    // ZSet Leaderboard
    const lb = document.getElementById('zset-leaderboard');
    if (lb && Array.isArray(data.topRequestedStocks)) {
      if (data.topRequestedStocks.length > 0) {
        lb.innerHTML = data.topRequestedStocks
          .map(
            (item, idx) => `
          <div class="flex items-center justify-between p-2 bg-slate-900 rounded-lg border border-slate-800 text-xs">
            <div class="flex items-center space-x-2">
              <span class="w-5 h-5 rounded-full ${
                idx === 0 ? 'bg-amber-500/20 text-amber-400 font-bold' : 'bg-slate-800 text-slate-400'
              } flex items-center justify-center font-mono text-[10px]">${idx + 1}</span>
              <span class="font-bold text-white font-mono">${item.symbol}</span>
            </div>
            <span class="font-mono font-bold text-cyan-400">${item.score} requests</span>
          </div>
        `
          )
          .join('');
      } else {
        lb.innerHTML = `<div class="text-slate-500 text-xs py-2">No ranked trades yet.</div>`;
      }
    }

    // Counters Hash
    const countersEl = document.getElementById('redis-hash-counters');
    if (countersEl && data.counters) {
      countersEl.innerHTML = Object.entries(data.counters)
        .map(
          ([key, val]) => `
        <div class="bg-slate-900 p-2 rounded-lg border border-slate-800">
          <div class="text-[10px] text-slate-500 truncate">${key}</div>
          <div class="font-bold text-white mt-0.5">${val}</div>
        </div>
      `
        )
        .join('');

      // Update global stat cards
      const execCount = document.getElementById('stat-executed-count');
      const rejCount = document.getElementById('stat-rejected-count');
      if (execCount && data.counters.processed_trades) execCount.textContent = data.counters.processed_trades;
      if (rejCount && data.counters.rejected_trades) rejCount.textContent = data.counters.rejected_trades;
    }
  } catch (err) {
    console.error('Error loading redis analytics:', err);
  }
}

async function loadRedisRejections() {
  try {
    const res = await fetch('/api/redis/rejections?count=20');
    const events = await res.json();
    if (!Array.isArray(events)) return;

    const tbody = document.getElementById('rejections-tbody');
    if (tbody) {
      if (events.length > 0) {
        tbody.innerHTML = events
          .map(
            (e) => `
          <tr class="hover:bg-slate-800/40">
            <td class="font-mono text-slate-500 text-[11px]">${e.id}</td>
            <td class="font-mono text-cyan-300 font-semibold">${e.eventId}</td>
            <td class="font-mono">#${e.accountId}</td>
            <td class="font-mono font-bold text-white">${e.symbol}</td>
            <td>
              <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${
                e.side === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
              }">${e.side}</span>
            </td>
            <td class="text-right font-mono font-bold">${e.quantity}</td>
            <td class="text-rose-400 font-semibold">${e.errorMessage || 'Validation failed'}</td>
          </tr>
        `
          )
          .join('');
      } else {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-slate-500">No rejected events in dead-letter queue.</td></tr>`;
      }
    }
  } catch (err) {
    console.error('Error loading rejections:', err);
  }
}

// -----------------------------------------------------------------------------
// Quick Trade Terminal
// -----------------------------------------------------------------------------
function setQuickSide(side) {
  currentSide = side;
  const buyBtn = document.getElementById('side-buy-btn');
  const sellBtn = document.getElementById('side-sell-btn');
  const submitBtn = document.getElementById('quick-submit-btn');
  const label = document.getElementById('quick-btn-label');

  if (side === 'BUY') {
    buyBtn.className = 'py-2 text-xs font-bold rounded-lg bg-emerald-500 text-white shadow-md shadow-emerald-500/20 transition';
    sellBtn.className = 'py-2 text-xs font-bold rounded-lg text-slate-400 hover:text-white transition';
    submitBtn.className =
      'w-full py-2.5 px-4 bg-emerald-500 hover:bg-emerald-400 text-white font-bold rounded-xl text-sm transition shadow-lg shadow-emerald-500/20 flex items-center justify-center space-x-2';
    if (label) label.textContent = 'Enqueue BUY Order';
  } else {
    sellBtn.className = 'py-2 text-xs font-bold rounded-lg bg-rose-500 text-white shadow-md shadow-rose-500/20 transition';
    buyBtn.className = 'py-2 text-xs font-bold rounded-lg text-slate-400 hover:text-white transition';
    submitBtn.className =
      'w-full py-2.5 px-4 bg-rose-500 hover:bg-rose-400 text-white font-bold rounded-xl text-sm transition shadow-lg shadow-rose-500/20 flex items-center justify-center space-x-2';
    if (label) label.textContent = 'Enqueue SELL Order';
  }

  updateQuickEstimate();
  updateQuickHoldingHint();
}

function updateQuickEstimate() {
  const stockSelect = document.getElementById('quick-stock-select');
  const qtyInput = document.getElementById('quick-quantity');
  const quotePriceEl = document.getElementById('quick-quote-price');
  const totalEl = document.getElementById('quick-total-estimate');

  if (!stockSelect || !qtyInput || stocks.length === 0) return;

  const stockId = parseInt(stockSelect.value, 10);
  const stock = stocks.find((s) => s.stock_id === stockId);
  const qty = parseInt(qtyInput.value, 10) || 0;

  if (stock) {
    const price = parseFloat(stock.current_price);
    const total = price * qty;
    if (quotePriceEl) quotePriceEl.textContent = formatINR(price);
    if (totalEl) totalEl.textContent = formatINR(total);
  }
}

function updateQuickHoldingHint() {
  const stockSelect = document.getElementById('quick-stock-select');
  const hintEl = document.getElementById('quick-holding-hint');
  if (!stockSelect || !hintEl) return;

  const stockId = parseInt(stockSelect.value, 10);
  const holding = portfolio.holdings?.find((h) => h.stock_id === stockId);
  const qty = holding ? holding.quantity : 0;
  hintEl.textContent = `Holding: ${qty} shares`;
  if (currentSide === 'SELL' && qty === 0) {
    hintEl.className = 'text-[11px] text-rose-400 font-mono font-bold';
  } else {
    hintEl.className = 'text-[11px] text-slate-400 font-mono';
  }
}

function prefillTrade(stockId, side, qty = 10) {
  setQuickSide(side);
  const stockSelect = document.getElementById('quick-stock-select');
  const qtyInput = document.getElementById('quick-quantity');
  if (stockSelect) stockSelect.value = stockId;
  if (qtyInput) qtyInput.value = qty;
  updateQuickEstimate();
  updateQuickHoldingHint();
  switchTab('markets');

  // Smooth scroll to quick trade box
  document.getElementById('quick-trade-form')?.scrollIntoView({ behavior: 'smooth' });
}

async function handleQuickTrade(event) {
  event.preventDefault();
  const stockSelect = document.getElementById('quick-stock-select');
  const qtyInput = document.getElementById('quick-quantity');
  const submitBtn = document.getElementById('quick-submit-btn');

  const stockId = parseInt(stockSelect.value, 10);
  const quantity = parseInt(qtyInput.value, 10);

  if (!stockId || !quantity || quantity <= 0) {
    showToast('Invalid Input', 'Please enter a valid asset and positive quantity', 'error');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.classList.add('opacity-50');

  try {
    const res = await fetch('/api/trades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: activeAccountId,
        stockId,
        side: currentSide,
        quantity,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to enqueue trade');
    }

    showToast(
      'Order Submitted',
      `Order placed and queued. Click "Settle Batch" to execute.`,
      'warning'
    );

    // Refresh status and stream
    loadStatus();
    loadRedisStream();
    loadRedisAnalytics();

    // Track status until processed
    pollTradeStatus(data.eventId);
  } catch (err) {
    showToast('Order Failed', err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.classList.remove('opacity-50');
  }
}

async function pollTradeStatus(eventId, retries = 10) {
  let attempts = 0;
  const interval = setInterval(async () => {
    attempts++;
    try {
      const res = await fetch(`/api/trades/status/${eventId}`);
      const data = await res.json();

      if (data.status === 'PROCESSED') {
        clearInterval(interval);
        showToast(
          'Trade Executed!',
          `Order #${data.orderId} filled at ${formatINR(data.executionPrice)}.`,
          'success'
        );
        loadAccounts();
        loadPortfolio();
        loadTradesHistory();
        loadAuditLog();
        loadSummary();
      } else if (data.status === 'REJECTED') {
        clearInterval(interval);
        showToast('Trade Rejected', data.errorMessage || 'Execution criteria failed', 'error');
        loadRedisRejections();
      } else if (attempts >= retries) {
        clearInterval(interval);
      }
    } catch (e) {
      clearInterval(interval);
    }
  }, 1500);
}

// -----------------------------------------------------------------------------
// Batch Flush Controller
// -----------------------------------------------------------------------------
async function triggerFlush() {
  const btn = document.getElementById('btn-flush');
  if (btn) {
    btn.disabled = true;
    btn.classList.add('opacity-75');
  }

  try {
    const res = await fetch('/api/trades/flush', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchSize: 100 }),
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Flush failed');

    const processedCount = result.processed?.length || 0;
    const rejectedCount = result.rejected?.length || 0;

    if (processedCount + rejectedCount > 0) {
      showToast(
        'Batch Settled',
        `Processed: ${processedCount} trade(s) | Rejected: ${rejectedCount} trade(s).`,
        processedCount > 0 ? 'success' : 'warning'
      );
    } else {
      showToast('No Pending Trades', 'All queued orders have already been settled.', 'info');
    }

    // Refresh everything
    refreshAll();
  } catch (err) {
    showToast('Flush Error', err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('opacity-75');
    }
  }
}

async function toggleAutoFlush() {
  try {
    const nextState = !autoFlushState;
    const res = await fetch('/api/trades/auto-flush', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: nextState, intervalMs: 3000 }),
    });
    const data = await res.json();
    autoFlushState = data.autoFlushEnabled;

    const btn = document.getElementById('btn-toggle-autoflush');
    if (btn) {
      btn.textContent = autoFlushState ? 'ON' : 'OFF';
      btn.className = autoFlushState
        ? 'text-[10px] font-semibold text-emerald-400 hover:text-emerald-300'
        : 'text-[10px] font-semibold text-rose-400 hover:text-rose-300';
    }

    showToast(
      'Auto-Flush Toggled',
      autoFlushState ? 'Background worker is now flushing every 3s' : 'Auto-flush disabled',
      'info'
    );
  } catch (err) {
    showToast('Error', err.message, 'error');
  }
}

// -----------------------------------------------------------------------------
// Modals: Deposit & Price Edit
// -----------------------------------------------------------------------------
function openDepositModal() {
  const modal = document.getElementById('deposit-modal');
  modal?.classList.remove('hidden');
  document.getElementById('deposit-amount')?.focus();
  lucide.createIcons();
}

function closeDepositModal() {
  document.getElementById('deposit-modal')?.classList.add('hidden');
}

function setDepositValue(val) {
  const input = document.getElementById('deposit-amount');
  if (input) input.value = val;
}

async function handleDepositSubmit(event) {
  event.preventDefault();
  const amount = parseFloat(document.getElementById('deposit-amount').value);
  if (!amount || amount <= 0) return;

  try {
    const res = await fetch(`/api/accounts/${activeAccountId}/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Deposit failed');

    showToast('Funds Deposited', `Added ${formatINR(amount)} to your cash balance!`, 'success');
    closeDepositModal();
    loadAccounts();
    loadPortfolio();
  } catch (err) {
    showToast('Deposit Error', err.message, 'error');
  }
}

function openPriceModal(stockId, symbol, currentPrice) {
  const modal = document.getElementById('price-modal');
  document.getElementById('edit-stock-id').value = stockId;
  document.getElementById('edit-stock-symbol').textContent = symbol;
  document.getElementById('edit-stock-price').value = currentPrice;
  modal?.classList.remove('hidden');
  lucide.createIcons();
}

function closePriceModal() {
  document.getElementById('price-modal')?.classList.add('hidden');
}

async function handlePriceSubmit(event) {
  event.preventDefault();
  const stockId = parseInt(document.getElementById('edit-stock-id').value, 10);
  const price = parseFloat(document.getElementById('edit-stock-price').value);

  if (!stockId || !price || price <= 0) return;

  try {
    const res = await fetch(`/api/stocks/${stockId}/price`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Price update failed');

    showToast('Price Updated', `${data.stock.symbol} quote changed to ${formatINR(price)}`, 'info');
    closePriceModal();
    loadStocks();
    loadPortfolio();
    updateQuickEstimate();
  } catch (err) {
    showToast('Price Update Error', err.message, 'error');
  }
}

// -----------------------------------------------------------------------------
// Authentication & Session Management (Login with Email & Password)
// -----------------------------------------------------------------------------
function fillCredentials(email, password) {
  const emailInput = document.getElementById('login-email');
  const passInput = document.getElementById('login-password');
  if (emailInput) emailInput.value = email;
  if (passInput) passInput.value = password;
  hideLoginError();
  passInput?.focus();
}

function togglePasswordVisibility() {
  const passInput = document.getElementById('login-password');
  const icon = document.getElementById('password-toggle-icon');
  if (!passInput) return;

  if (passInput.type === 'password') {
    passInput.type = 'text';
    icon?.setAttribute('data-lucide', 'eye-off');
  } else {
    passInput.type = 'password';
    icon?.setAttribute('data-lucide', 'eye');
  }
  lucide.createIcons();
}

function showLoginError(msg) {
  const alertEl = document.getElementById('login-error-alert');
  const msgEl = document.getElementById('login-error-msg');
  if (alertEl && msgEl) {
    msgEl.textContent = msg;
    alertEl.classList.remove('hidden');
    lucide.createIcons();
  }
}

function hideLoginError() {
  const alertEl = document.getElementById('login-error-alert');
  if (alertEl) alertEl.classList.add('hidden');
}

async function handleManualLogin(event) {
  event.preventDefault();
  hideLoginError();

  const emailInput = document.getElementById('login-email');
  const passInput = document.getElementById('login-password');
  const submitBtn = document.getElementById('login-submit-btn');
  const btnText = document.getElementById('login-btn-text');

  const email = emailInput?.value?.trim();
  const password = passInput?.value;

  if (!email || !password) {
    showLoginError('Please enter both email and password.');
    return;
  }

  // Loading state
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.classList.add('opacity-70');
  }
  if (btnText) btnText.textContent = 'Verifying credentials...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Authentication failed');
    }

    setAuthenticatedSession(data.user);
  } catch (err) {
    showLoginError(err.message || 'Login failed. Please check your credentials.');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.remove('opacity-70');
    }
    if (btnText) btnText.textContent = 'Log In to Terminal';
  }
}

function applyUserRoleUI(user) {
  const tabRedis = document.getElementById('tab-redis');
  const summaryContainer = document.getElementById('stock-summary-container');
  const roleBadge = document.getElementById('nav-user-role-badge');
  const navAvatar = document.getElementById('nav-user-avatar');

  if (user && user.isAdmin) {
    // Admin: show Execution Queue and Stock Summary
    if (tabRedis) {
      tabRedis.classList.remove('hidden');
      tabRedis.classList.add('flex');
    }
    if (summaryContainer) {
      summaryContainer.classList.remove('hidden');
    }
    if (roleBadge) {
      roleBadge.textContent = 'ADMIN';
      roleBadge.className = 'px-1.5 py-0.2 rounded text-[9px] font-mono font-bold bg-purple-950 text-purple-300 border border-purple-800 uppercase';
    }
    if (navAvatar) {
      navAvatar.className = 'w-6 h-6 rounded-full bg-gradient-to-tr from-purple-600 to-indigo-500 flex items-center justify-center text-[10px] font-bold text-white uppercase shadow-sm shadow-purple-500/30';
      navAvatar.textContent = 'AD';
    }
  } else {
    // Regular trader: hide Execution Queue and Stock Summary
    if (tabRedis) {
      tabRedis.classList.add('hidden');
      tabRedis.classList.remove('flex');
    }
    if (summaryContainer) {
      summaryContainer.classList.add('hidden');
    }
    if (roleBadge) {
      roleBadge.textContent = 'TRADER';
      roleBadge.className = 'px-1.5 py-0.2 rounded text-[9px] font-mono font-bold bg-cyan-950 text-cyan-400 border border-cyan-800 uppercase';
    }
    if (navAvatar) {
      navAvatar.className = 'w-6 h-6 rounded-full bg-cyan-600 flex items-center justify-center text-[10px] font-bold text-white uppercase';
      navAvatar.textContent = user?.name ? user.name.charAt(0) : 'U';
    }

    // If currently on redis tab, switch back to markets
    const redisTabContent = document.getElementById('content-redis');
    if (redisTabContent && !redisTabContent.classList.contains('hidden')) {
      switchTab('markets');
    }
  }
}

function setAuthenticatedSession(user) {
  currentAuthUser = user;
  activeAccountId = user.accountId;
  localStorage.setItem('activeUserId', user.userId);

  // Transition UI
  document.getElementById('login-screen')?.classList.add('hidden');
  document.getElementById('app-screen')?.classList.remove('hidden');

  applyUserRoleUI(user);
  updateNavUserProfile(user);
  refreshAll();
  showToast(
    user.isAdmin ? 'Admin Mode Activated' : 'Authenticated',
    user.isAdmin
      ? `Welcome System Administrator. Full access to Execution Queue and global summaries.`
      : `Welcome back, ${user.name}! Connected to Account #${user.accountId}`,
    user.isAdmin ? 'warning' : 'success'
  );
}

function updateNavUserProfile(user) {
  const nameEl = document.getElementById('nav-user-name');
  const accEl = document.getElementById('nav-user-account');

  if (nameEl) nameEl.textContent = user.name;
  if (accEl) accEl.textContent = `Acc #${user.accountId}`;
}

function logoutUser() {
  currentAuthUser = null;
  localStorage.removeItem('activeUserId');

  document.getElementById('app-screen')?.classList.add('hidden');
  document.getElementById('login-screen')?.classList.remove('hidden');
  hideLoginError();

  // Reset tab to markets
  switchTab('markets');

  showToast('Logged Out', 'Returned to Sign In Screen', 'info');
}

// -----------------------------------------------------------------------------
// Global Refresh & Init
// -----------------------------------------------------------------------------
function refreshAll() {
  loadStatus();
  loadAccounts();
  loadStocks();
  loadSummary();
  loadPortfolio();
  loadTradesHistory();
  loadAuditLog();
  loadStagingRows();
}

document.addEventListener('DOMContentLoaded', () => {
  // Initialize Lucide icons
  lucide.createIcons();

  // Show login screen by default
  document.getElementById('login-screen')?.classList.remove('hidden');
  document.getElementById('app-screen')?.classList.add('hidden');

  // 3-second recurring polling loop when logged in
  setInterval(() => {
    if (currentAuthUser) {
      loadStatus();
      loadPortfolio();
    }
  }, 3000);
});

