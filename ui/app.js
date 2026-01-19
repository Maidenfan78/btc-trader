const config = window.__DASHBOARD_CONFIG__ || {};
const apiBase = config.apiBase || window.location.origin;

const state = {
  token: localStorage.getItem("dashboard_token") || "",
  bots: [],
  status: {},
  selectedBot: null,
  timelineEvents: [],
  timelineOffset: 0,
  timelineHasMore: true,
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

// ============================================================================
// Timeline functionality
// ============================================================================

const timelineFeed = document.getElementById("timeline-feed");
const timelineBotFilter = document.getElementById("timeline-bot-filter");
const timelineAssetFilter = document.getElementById("timeline-asset-filter");
const timelineTypeFilter = document.getElementById("timeline-type-filter");
const timelineLoadMore = document.getElementById("timeline-load-more");
const timelineRefreshBtn = document.getElementById("timeline-refresh-btn");

const EVENT_ICONS = {
  CYCLE_START: "🔄",
  CYCLE_END: "✓",
  SIGNAL_GENERATED: "📊",
  SIGNAL_REJECTED: "🚫",
  NO_SIGNAL: "•",
  POSITION_OPENED: "📈",
  TP_HIT: "🎯",
  TRAILING_STOP_UPDATED: "↑",
  TRAILING_STOP_HIT: "🛑",
  RUNNER_TRIMMED: "✂️",
  TRADE_FAILED: "⚠️",
  ERROR: "❌",
};

const EVENT_CATEGORIES = {
  CYCLE_START: "cycle",
  CYCLE_END: "cycle",
  SIGNAL_GENERATED: "signal",
  SIGNAL_REJECTED: "signal",
  NO_SIGNAL: "signal",
  POSITION_OPENED: "position",
  TP_HIT: "position",
  TRAILING_STOP_UPDATED: "position",
  TRAILING_STOP_HIT: "position",
  RUNNER_TRIMMED: "position",
  TRADE_FAILED: "error",
  ERROR: "error",
};

async function loadTimeline(reset = false) {
  if (reset) {
    state.timelineOffset = 0;
    state.timelineEvents = [];
    state.timelineHasMore = true;
    timelineFeed.innerHTML = '<div class="timeline-loading">Loading events...</div>';
  }

  const botId = timelineBotFilter.value;
  const asset = timelineAssetFilter.value;
  const types = timelineTypeFilter.value;

  let url = `/api/timeline?limit=30&offset=${state.timelineOffset}`;
  if (botId) url += `&botId=${encodeURIComponent(botId)}`;
  if (asset) url += `&asset=${encodeURIComponent(asset)}`;
  if (types) url += `&types=${encodeURIComponent(types)}`;

  try {
    const response = await apiFetch(url);
    if (!response.ok) throw new Error("Failed to load timeline");

    const data = await response.json();
    const events = data.events || [];

    if (reset) {
      state.timelineEvents = events;
    } else {
      state.timelineEvents = [...state.timelineEvents, ...events];
    }

    state.timelineHasMore = data.hasMore;
    state.timelineOffset += events.length;

    renderTimeline();
  } catch (error) {
    timelineFeed.innerHTML = `<div class="timeline-empty">Failed to load timeline: ${error.message}</div>`;
  }
}

function renderTimeline() {
  if (state.timelineEvents.length === 0) {
    timelineFeed.innerHTML = '<div class="timeline-empty">No events yet. Run a bot to generate activity.</div>';
    timelineLoadMore.disabled = true;
    return;
  }

  const eventsHtml = state.timelineEvents.map(renderTimelineEvent).join("");
  timelineFeed.innerHTML = eventsHtml;
  timelineLoadMore.disabled = !state.timelineHasMore;
}

function renderTimelineEvent(event) {
  const icon = EVENT_ICONS[event.type] || "•";
  const category = EVENT_CATEGORIES[event.type] || "cycle";
  const time = formatEventTime(event.timestamp);
  const content = formatEventContent(event);
  const context = formatEventContext(event);

  const typeLabel = event.type.replace(/_/g, " ");

  return `
    <div class="timeline-event ${category}">
      <div class="timeline-time">
        ${time}
      </div>
      <div>
        <div class="timeline-header">
          <span class="timeline-icon">${icon}</span>
          <span class="timeline-asset">${event.asset === "*" ? "All" : event.asset}</span>
          <span class="timeline-type">${typeLabel}</span>
        </div>
        <div class="timeline-content">${content}</div>
        <div class="timeline-context">${context}</div>
      </div>
    </div>
  `;
}

function formatEventTime(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();

  const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (isToday) {
    return timeStr;
  }

  const dateStr = date.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${dateStr}<br>${timeStr}`;
}

function formatEventContent(event) {
  const p = event.payload || {};

  switch (event.type) {
    case "CYCLE_START":
      return `Processing ${p.assetsToProcess?.join(", ") || "assets"} with ${p.totalOpenPositions || 0} open positions`;

    case "CYCLE_END":
      return `Processed ${p.assetsProcessed || 0} assets, ${p.signalsGenerated || 0} signals, ${p.positionsOpened || 0} opened, ${p.runnersTrimmed || 0} trimmed (${(p.cycleDurationMs / 1000).toFixed(1)}s)`;

    case "SIGNAL_GENERATED":
      return `${p.signalType} signal: MFI crossed ${p.crossDirection === "UP" ? "above" : "below"} ${p.signalType === "LONG" ? p.buyLevel : p.sellLevel} (${p.previousIndicator?.toFixed(1)} → ${p.currentIndicator?.toFixed(1)})`;

    case "SIGNAL_REJECTED":
      return `${p.signalType} signal rejected: ${p.reason}`;

    case "NO_SIGNAL":
      return `${p.reason} (MFI: ${p.indicatorValue?.toFixed(1)})`;

    case "POSITION_OPENED":
      return `Opened ${p.legIds?.length || 2} legs at $${p.fillPrice?.toFixed(2)} | TP: $${p.tpTarget?.toFixed(2)} | Total: $${p.totalUsdc?.toFixed(2)}`;

    case "TP_HIT":
      return `Take profit hit! Entry: $${p.entryPrice?.toFixed(2)} → Exit: $${p.exitPrice?.toFixed(2)} | P&L: ${formatPnL(p.pnlUsdc)} (${p.pnlPercent?.toFixed(1)}%)`;

    case "TRAILING_STOP_UPDATED":
      return `Trailing stop ${p.reason === "ACTIVATED" ? "activated" : "moved"}: $${p.previousStop?.toFixed(2) || "--"} → $${p.newStop?.toFixed(2)} (high: $${p.newHighest?.toFixed(2)})`;

    case "TRAILING_STOP_HIT":
      return `Trailing stop hit! Entry: $${p.entryPrice?.toFixed(2)} → Exit: $${p.exitPrice?.toFixed(2)} (high: $${p.highestReached?.toFixed(2)}) | P&L: ${formatPnL(p.pnlUsdc)} (${p.pnlPercent?.toFixed(1)}%)`;

    case "RUNNER_TRIMMED":
      return `Runner trimmed on MFI ${p.triggerIndicator?.toFixed(1)} > ${p.triggerLevel} | Entry: $${p.entryPrice?.toFixed(2)} → Exit: $${p.exitPrice?.toFixed(2)} | P&L: ${formatPnL(p.pnlUsdc)}`;

    case "TRADE_FAILED":
      return `${p.signalType} trade failed: ${p.reason}${p.requiredUsdc ? ` (needed $${p.requiredUsdc}, had $${p.availableUsdc})` : ""}`;

    case "ERROR":
      return `Error in ${p.context || "bot"}: ${p.message}`;

    default:
      return JSON.stringify(p);
  }
}

function formatEventContext(event) {
  const m = event.market;
  if (!m || !m.price) return `${event.botId} | ${event.mode}`;

  const parts = [
    `$${m.price.toFixed(2)}`,
    `${m.indicatorName} ${m.indicator.toFixed(1)}`,
    m.trend,
    `ATR ${m.atrPercent?.toFixed(1)}%`,
  ];

  return `${parts.join(" | ")} | ${event.botId} | ${event.mode}`;
}

async function loadTimelineFilters() {
  try {
    const response = await apiFetch("/api/timeline/filters");
    if (!response.ok) return;

    const data = await response.json();
    const filters = data.filters || {};

    // Populate bot filter
    if (filters.botIds?.length) {
      const options = filters.botIds.map(id => `<option value="${id}">${id}</option>`).join("");
      timelineBotFilter.innerHTML = `<option value="">All Bots</option>${options}`;
    }

    // Populate asset filter
    if (filters.assets?.length) {
      const options = filters.assets.filter(a => a !== "*").map(a => `<option value="${a}">${a}</option>`).join("");
      timelineAssetFilter.innerHTML = `<option value="">All Assets</option>${options}`;
    }
  } catch (error) {
    console.error("Failed to load timeline filters:", error);
  }
}

// Timeline event listeners
timelineRefreshBtn.addEventListener("click", () => loadTimeline(true));
timelineBotFilter.addEventListener("change", () => loadTimeline(true));
timelineAssetFilter.addEventListener("change", () => loadTimeline(true));
timelineTypeFilter.addEventListener("change", () => loadTimeline(true));
timelineLoadMore.addEventListener("click", () => loadTimeline(false));

// ============================================================================
// Initialize
// ============================================================================

refreshAll();
loadTimelineFilters();
loadTimeline(true);
setInterval(refreshAll, 30000);
setInterval(() => loadTimeline(true), 60000);
