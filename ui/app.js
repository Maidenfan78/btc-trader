const config = window.__DASHBOARD_CONFIG__ || {};
const apiBase = config.apiBase || window.location.origin;

const state = {
  token: localStorage.getItem("dashboard_token") || "",
  bots: [],
  status: {},
  selectedBot: null,
};

const botGrid = document.getElementById("bot-grid");
const healthPill = document.getElementById("health-pill");
const updatedPill = document.getElementById("updated-pill");
const metricsBots = document.getElementById("metric-bots");
const metricsRunning = document.getElementById("metric-running");
const metricsPositions = document.getElementById("metric-positions");
const detailTitle = document.getElementById("detail-title");
const detailSubtitle = document.getElementById("detail-subtitle");
const positionsTable = document.getElementById("positions-table");
const logsBox = document.getElementById("logs-box");
const loginForm = document.getElementById("login-form");
const loginStatus = document.getElementById("login-status");

const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const restartBtn = document.getElementById("restart-btn");

document.getElementById("refresh-btn").addEventListener("click", () => {
  refreshAll();
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value.trim();
  loginStatus.textContent = "Signing in...";

  try {
    const response = await fetch(`${apiBase}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || "Login failed");
    }
    const data = await response.json();
    state.token = data.token;
    localStorage.setItem("dashboard_token", data.token);
    loginStatus.textContent = "Authenticated. Control actions enabled.";
  } catch (error) {
    loginStatus.textContent = error.message;
  }
});

async function apiFetch(path, options = {}) {
  const headers = options.headers || {};
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  const response = await fetch(`${apiBase}${path}`, { ...options, headers });
  if (response.status === 401) {
    state.token = "";
    localStorage.removeItem("dashboard_token");
  }
  return response;
}

async function refreshAll() {
  await Promise.all([loadHealth(), loadBots(), loadStatus()]);
  updateMetrics();
  renderBots();
  if (!state.selectedBot && state.bots.length > 0) {
    selectBot(state.bots[0].id);
  } else if (state.selectedBot) {
    selectBot(state.selectedBot, true);
  }
}

async function loadHealth() {
  try {
    const response = await fetch(`${apiBase}/api/health`);
    if (!response.ok) throw new Error("API offline");
    const data = await response.json();
    healthPill.textContent = `API: ${data.status}`;
    healthPill.style.color = "var(--accent)";
  } catch (error) {
    healthPill.textContent = "API: offline";
    healthPill.style.color = "var(--danger)";
  }
}

async function loadBots() {
  const response = await apiFetch("/api/bots");
  if (!response.ok) return;
  const data = await response.json();
  state.bots = data.bots || [];
}

async function loadStatus() {
  const response = await apiFetch("/api/status");
  if (!response.ok) return;
  state.status = await response.json();
  updatedPill.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
}

function updateMetrics() {
  const botCount = state.bots.length;
  const runningCount = Object.values(state.status).filter((bot) => bot.running).length;
  const positionCount = Object.values(state.status).reduce((sum, bot) => {
    const open = bot.state?.openPositionCount || 0;
    return sum + open;
  }, 0);
  const totalPnL = Object.values(state.status).reduce((sum, bot) => {
    const pnl = bot.state?.performance?.totalPnL || 0;
    return sum + pnl;
  }, 0);

  metricsBots.textContent = botCount;
  metricsRunning.textContent = runningCount;
  metricsPositions.textContent = positionCount;

  const metricsPnL = document.getElementById("metric-pnl");
  if (metricsPnL) {
    metricsPnL.textContent = formatPnL(totalPnL);
    metricsPnL.className = totalPnL >= 0 ? "pnl-positive" : "pnl-negative";
  }
}

function formatPnL(value) {
  const sign = value >= 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

function renderBots() {
  botGrid.innerHTML = "";
  state.bots.forEach((bot) => {
    const status = state.status[bot.id] || {};
    const running = status.running;
    const perf = status.state?.performance || {};
    const pnl = perf.totalPnL || 0;
    const trades = perf.totalTrades || 0;
    const winRate = perf.winRate || 0;
    const lastTradeTime = status.state?.lastTradeTime || 0;
    const lastTradeStr = lastTradeTime > 0 ? formatTimeAgo(lastTradeTime) : "Never";

    const card = document.createElement("div");
    card.className = `bot-card ${state.selectedBot === bot.id ? "active" : ""}`;
    card.innerHTML = `
      <h4>${bot.name}</h4>
      <div class="meta">${bot.indicator.toUpperCase()} • ${bot.timeframe.toUpperCase()}</div>
      <div class="bot-stats">
        <span class="${pnl >= 0 ? "pnl-positive" : "pnl-negative"}">${formatPnL(pnl)}</span>
        <span class="meta">${trades} trades${trades > 0 ? ` (${(winRate * 100).toFixed(0)}% win)` : ""}</span>
      </div>
      <div class="meta">Last trade: ${lastTradeStr}</div>
      <div class="badge ${running ? "" : "offline"}">${running ? "Running" : "Stopped"}</div>
    `;
    card.addEventListener("click", () => selectBot(bot.id));
    botGrid.appendChild(card);
  });
}

function formatTimeAgo(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "Just now";
}

async function selectBot(botId, preserve = false) {
  state.selectedBot = botId;
  const bot = state.bots.find((b) => b.id === botId);
  if (!bot) return;
  detailTitle.textContent = bot.name;
  detailSubtitle.textContent = `${bot.indicator.toUpperCase()} • ${bot.timeframe.toUpperCase()}`;

  if (!preserve) {
    renderBots();
  }

  await Promise.all([loadSignals(botId), loadPositions(botId), loadTrades(botId), loadLogs(botId)]);
  bindControlButtons(botId);
}

function loadSignals(botId) {
  const signalsTable = document.getElementById("signals-table");
  const status = state.status[botId];
  const snapshot = status?.state?.indicatorSnapshot;

  if (!snapshot || Object.keys(snapshot).length === 0) {
    signalsTable.innerHTML = `
      <div class="table-row header">
        <span>Asset</span><span>Price</span><span>Indicator</span><span>Trend</span>
      </div>
      <div class="table-row muted">No signal data yet.</div>
    `;
    return;
  }

  const rows = Object.entries(snapshot).map(([asset, data]) => {
    const trendClass = data.trend === "BULLISH" ? "trend-bull" :
                       data.trend === "BEARISH" ? "trend-bear" : "trend-neutral";
    const trendIcon = data.trend === "BULLISH" ? "▲" :
                      data.trend === "BEARISH" ? "▼" : "●";
    const indicator2 = data.indicator2 !== undefined ? ` / ${data.indicator2.toFixed(2)}` : "";
    return `
      <div class="table-row">
        <span>${asset}</span>
        <span>$${data.price.toFixed(2)}</span>
        <span>${data.indicator.toFixed(2)}${indicator2}</span>
        <span class="${trendClass}">${trendIcon} ${data.trend}</span>
      </div>
    `;
  }).join("");

  signalsTable.innerHTML = `
    <div class="table-row header">
      <span>Asset</span><span>Price</span><span>Indicator</span><span>Trend</span>
    </div>
    ${rows}
  `;
}

function bindControlButtons(botId) {
  startBtn.onclick = () => controlBot(botId, "start");
  stopBtn.onclick = () => controlBot(botId, "stop");
  restartBtn.onclick = () => controlBot(botId, "restart");
}

async function controlBot(botId, action) {
  if (!state.token) {
    loginStatus.textContent = "Login required for control actions.";
    return;
  }

  const response = await apiFetch(`/api/control/${botId}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    loginStatus.textContent = body.error || "Action failed.";
    return;
  }
  loginStatus.textContent = `${botId} ${action} requested.`;
  await refreshAll();
}

async function loadPositions(botId) {
  const response = await apiFetch(`/api/positions/${botId}`);
  if (!response.ok) {
    positionsTable.innerHTML = `<div class="table-row muted">No positions available.</div>`;
    return;
  }
  const data = await response.json();
  const positions = data.positions || [];

  if (!positions.length) {
    positionsTable.innerHTML = `
      <div class="table-row header">
        <span>Asset</span><span>Qty</span><span>Entry</span><span>Now</span><span>PnL</span>
      </div>
      <div class="table-row muted">No open positions.</div>
    `;
    return;
  }

  const rows = positions.map((pos) => {
    const pnl = pos.unrealizedPnL ? pos.unrealizedPnL.toFixed(2) : "--";
    const price = pos.currentPrice ? pos.currentPrice.toFixed(2) : "--";
    return `
      <div class="table-row">
        <span>${pos.symbol}</span>
        <span>${pos.quantity.toFixed(4)}</span>
        <span>${pos.entryPrice.toFixed(2)}</span>
        <span>${price}</span>
        <span>${pnl}</span>
      </div>
    `;
  }).join("");

  positionsTable.innerHTML = `
    <div class="table-row header">
      <span>Asset</span><span>Qty</span><span>Entry</span><span>Now</span><span>PnL</span>
    </div>
    ${rows}
  `;
}

async function loadTrades(botId) {
  const tradesTable = document.getElementById("trades-table");
  const response = await apiFetch(`/api/trades/${botId}?limit=10`);
  if (!response.ok) {
    tradesTable.innerHTML = `
      <div class="table-row header">
        <span>Date</span><span>Asset</span><span>Type</span><span>Price</span><span>P&L</span>
      </div>
      <div class="table-row muted">Failed to load trades.</div>
    `;
    return;
  }
  const data = await response.json();
  const trades = data.trades || [];

  if (!trades.length) {
    tradesTable.innerHTML = `
      <div class="table-row header">
        <span>Date</span><span>Asset</span><span>Type</span><span>Price</span><span>P&L</span>
      </div>
      <div class="table-row muted">No trades yet.</div>
    `;
    return;
  }

  const rows = trades.map((trade) => {
    const date = new Date(trade.timestamp || trade.date).toLocaleDateString();
    const pnl = trade.pnl ? formatPnL(trade.pnl) : "--";
    const pnlClass = trade.pnl >= 0 ? "pnl-positive" : "pnl-negative";
    return `
      <div class="table-row">
        <span>${date}</span>
        <span>${trade.asset || trade.symbol || "--"}</span>
        <span>${trade.type || trade.action || "--"}</span>
        <span>$${(trade.price || 0).toFixed(2)}</span>
        <span class="${pnlClass}">${pnl}</span>
      </div>
    `;
  }).join("");

  tradesTable.innerHTML = `
    <div class="table-row header">
      <span>Date</span><span>Asset</span><span>Type</span><span>Price</span><span>P&L</span>
    </div>
    ${rows}
  `;
}

async function loadLogs(botId) {
  const response = await apiFetch(`/api/logs/${botId}?lines=120`);
  if (!response.ok) {
    logsBox.textContent = "Failed to load logs.";
    return;
  }
  const data = await response.json();
  const logs = data.logs || [];
  const lines = logs.map((log) => {
    let text = typeof log === "string" ? log : (log.message || JSON.stringify(log));
    return stripAnsi(text);
  });
  logsBox.innerHTML = formatLogLines(lines);
}

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function formatLogLines(lines) {
  return lines.map((line) => {
    const isError = /\[ERROR\]/i.test(line) || /error:/i.test(line);
    const isWarn = /\[WARN\]/i.test(line) || /warn:/i.test(line);
    const isSignal = /signal/i.test(line) && /(LONG|SHORT|detected)/i.test(line);
    const isTrade = /(opening|closed|position|entry|exit)/i.test(line);

    let className = "";
    if (isError) className = "log-error";
    else if (isWarn) className = "log-warn";
    else if (isSignal) className = "log-signal";
    else if (isTrade) className = "log-trade";

    const escaped = line.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return className ? `<div class="${className}">${escaped}</div>` : `<div>${escaped}</div>`;
  }).join("");
}

refreshAll();
setInterval(refreshAll, 30000);
