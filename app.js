// TradeDesk V2 - public market data, transparent technical signals, backtesting and journaling.
// This browser code NEVER places real exchange orders. Private account access requires server.js.
"use strict";

const $ = (id) => document.getElementById(id);
const JOURNAL_KEY = "tradedesk-journal-v2";
const SETTINGS_KEY = "tradedesk-connection-settings-v1";
const prices = { BTC: null, ETH: null };
let latestAnalysis = null;
let lastBacktestEquity = [];

const MARKET_NAMES = { BTCUSDT: "BTC/USDT", ETHUSDT: "ETH/USDT" };

// ----------------------------- Formatting & network helpers -----------------------------
function formatNumber(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("en-IN", { maximumFractionDigits: digits });
}
function formatINR(value) { return `₹${formatNumber(value)}`; }
function formatUSD(value, digits = 2) { return `$${formatNumber(value, digits)}`; }
function signedPercent(value) { return `${value >= 0 ? "+" : ""}${formatNumber(value)}%`; }
function safeText(id, value) { const node = $(id); if (node) node.textContent = value; }
function setStatus(id, message, tone = "neutral") {
  const node = $(id);
  if (!node) return;
  node.textContent = message;
  node.className = node.className.replace(/\b(status-ok|status-bad|status-warn)\b/g, "").trim();
  if (tone === "ok") node.classList.add("status-ok");
  if (tone === "bad") node.classList.add("status-bad");
  if (tone === "warn") node.classList.add("status-warn");
}
async function fetchJSON(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 200) }; }
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
  } finally {
    window.clearTimeout(timer);
  }
}
function getConnectionSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); }
  catch { return {}; }
}
function getBackendUrl() {
  return String(($('backendUrl')?.value || getConnectionSettings().backendUrl || "")).trim().replace(/\/+$/, "");
}
function getBackendToken() {
  const typed = String($('backendToken')?.value || "").trim();
  if (typed) return typed;
  try { return sessionStorage.getItem("tradedesk-backend-token") || ""; } catch { return ""; }
}
function privateHeaders() {
  const token = getBackendToken();
  return token ? { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

// ----------------------------- Public market data -----------------------------
async function loadMarketData() {
  const query = encodeURIComponent('["BTCUSDT","ETHUSDT"]');
  const hosts = ["https://data-api.binance.vision", "https://api.binance.com"];
  let tickers = null;
  let lastError = null;
  for (const host of hosts) {
    try {
      tickers = await fetchJSON(`${host}/api/v3/ticker/24hr?symbols=${query}`);
      break;
    } catch (error) { lastError = error; }
  }
  if (!Array.isArray(tickers)) {
    ["btc", "eth"].forEach((asset) => {
      safeText(`${asset}Price`, "Unavailable");
      safeText(`${asset}Change`, "Public market data unavailable. Try again later.");
    });
    console.error("Market data error:", lastError);
    setStatus("marketUpdated", "Could not refresh public market data. This can be a network or API availability issue.", "warn");
    return;
  }
  tickers.forEach((ticker) => {
    const asset = ticker.symbol === "BTCUSDT" ? "BTC" : "ETH";
    prices[asset] = Number(ticker.lastPrice);
    const prefix = asset.toLowerCase();
    safeText(`${prefix}Price`, formatUSD(prices[asset]));
    const change = Number(ticker.priceChangePercent);
    const changeNode = $(`${prefix}Change`);
    if (changeNode) {
      changeNode.textContent = `${signedPercent(change)} · last 24 hours`;
      changeNode.className = `market-change ${change >= 0 ? "positive" : "negative"}`;
    }
    safeText(`${prefix}High`, formatUSD(Number(ticker.highPrice)));
    safeText(`${prefix}Low`, formatUSD(Number(ticker.lowPrice)));
  });
  safeText("marketUpdated", `Public Binance ticker data refreshed at ${new Date().toLocaleTimeString()}.`);
}

async function loadKlines(symbol, interval, limit) {
  const hosts = ["https://data-api.binance.vision", "https://api.binance.com"];
  let lastError = null;
  for (const host of hosts) {
    try {
      const rows = await fetchJSON(`${host}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`);
      if (!Array.isArray(rows) || rows.length < 60) throw new Error("Not enough candles returned by public market data.");
      return rows.map((r) => ({
        time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]),
        close: Number(r[4]), volume: Number(r[5]), closeTime: Number(r[6])
      })).filter((c) => [c.time, c.open, c.high, c.low, c.close, c.closeTime].every(Number.isFinite));
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error("Could not download candle data.");
}

// ----------------------------- Technical indicators -----------------------------
function emaSeries(values, period) {
  const result = Array(values.length).fill(null);
  if (values.length < period) return result;
  const multiplier = 2 / (period + 1);
  let seed = values.slice(0, period).reduce((sum, n) => sum + n, 0) / period;
  result[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    seed = (values[i] - seed) * multiplier + seed;
    result[i] = seed;
  }
  return result;
}
function rsiSeries(closes, period = 14) {
  const output = Array(closes.length).fill(null);
  if (closes.length <= period) return output;
  let gains = 0; let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change; else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  output[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    output[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return output;
}
function macdSeries(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const fastEma = emaSeries(closes, fast);
  const slowEma = emaSeries(closes, slow);
  const line = closes.map((_, i) => fastEma[i] != null && slowEma[i] != null ? fastEma[i] - slowEma[i] : null);
  let firstValid = line.findIndex((v) => v != null);
  const tail = line.slice(firstValid).map((v) => v == null ? 0 : v);
  const signalTail = emaSeries(tail, signalPeriod);
  const signal = Array(closes.length).fill(null);
  for (let i = 0; i < signalTail.length; i++) signal[firstValid + i] = signalTail[i];
  const histogram = line.map((v, i) => v != null && signal[i] != null ? v - signal[i] : null);
  return { line, signal, histogram };
}
function atrSeries(candles, period = 14) {
  const tr = Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]; const previousClose = candles[i - 1].close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - previousClose), Math.abs(c.low - previousClose));
  }
  const output = Array(candles.length).fill(null);
  if (candles.length <= period) return output;
  let first = 0;
  for (let i = 1; i <= period; i++) first += tr[i] || 0;
  let value = first / period;
  output[period] = value;
  for (let i = period + 1; i < candles.length; i++) {
    value = (value * (period - 1) + (tr[i] || 0)) / period;
    output[i] = value;
  }
  return output;
}
function indicatorPack(candles) {
  const closes = candles.map((c) => c.close);
  return {
    closes,
    ema20: emaSeries(closes, 20),
    ema50: emaSeries(closes, 50),
    ema9: emaSeries(closes, 9),
    ema21: emaSeries(closes, 21),
    rsi: rsiSeries(closes, 14),
    macd: macdSeries(closes),
    atr: atrSeries(candles, 14)
  };
}

function makeAnalysis(candles, symbol, interval) {
  // Ignore the newest candle if its close time hasn't passed yet.
  const now = Date.now();
  const closed = candles.filter((c) => c.closeTime <= now);
  const data = closed.length >= 60 ? closed : candles.slice(0, -1);
  const ind = indicatorPack(data);
  const i = data.length - 1;
  const previous = i - 1;
  const price = data[i].close;
  const e20 = ind.ema20[i]; const e50 = ind.ema50[i]; const rsi = ind.rsi[i];
  const macd = ind.macd.histogram[i]; const atr = ind.atr[i];
  const prevMacd = ind.macd.histogram[previous];
  if (![price, e20, e50, rsi, macd, atr].every(Number.isFinite)) throw new Error("Indicator warm-up incomplete. Download more candles and try again.");

  let score = 0;
  const reasons = [];
  if (price > e20) { score++; reasons.push({ tone: "bull", title: "Price above EMA 20", detail: "Short-term price is above its 20-period trend average." }); }
  else { score--; reasons.push({ tone: "bear", title: "Price below EMA 20", detail: "Short-term price is below its 20-period trend average." }); }
  if (e20 > e50) { score++; reasons.push({ tone: "bull", title: "EMA 20 above EMA 50", detail: "The faster average is above the slower average, supporting bullish trend structure." }); }
  else { score--; reasons.push({ tone: "bear", title: "EMA 20 below EMA 50", detail: "The faster average is below the slower average, supporting bearish trend structure." }); }
  if (macd > 0 && (prevMacd == null || macd >= prevMacd)) { score++; reasons.push({ tone: "bull", title: "MACD momentum positive", detail: "The MACD histogram is above zero and flat-to-rising." }); }
  else if (macd < 0 && (prevMacd == null || macd <= prevMacd)) { score--; reasons.push({ tone: "bear", title: "MACD momentum negative", detail: "The MACD histogram is below zero and flat-to-falling." }); }
  else { reasons.push({ tone: "neutral", title: "MACD momentum mixed", detail: "MACD is not adding strong confirmation in either direction." }); }
  if (rsi >= 52 && rsi <= 68) { score++; reasons.push({ tone: "bull", title: "RSI supports bullish momentum", detail: `RSI is ${formatNumber(rsi, 1)}, in the engine's bullish momentum zone.` }); }
  else if (rsi >= 32 && rsi <= 48) { score--; reasons.push({ tone: "bear", title: "RSI supports bearish momentum", detail: `RSI is ${formatNumber(rsi, 1)}, in the engine's bearish momentum zone.` }); }
  else if (rsi > 70) { reasons.push({ tone: "warn", title: "RSI is elevated", detail: `RSI ${formatNumber(rsi, 1)} may indicate an extended move. Chasing can be risky.` }); }
  else if (rsi < 30) { reasons.push({ tone: "warn", title: "RSI is oversold", detail: `RSI ${formatNumber(rsi, 1)} may indicate stretched downside; it does not guarantee a reversal.` }); }
  else { reasons.push({ tone: "neutral", title: "RSI is not directional", detail: `RSI ${formatNumber(rsi, 1)} is outside the engine's directional zones.` }); }

  const signal = score >= 3 && rsi < 72 ? "BUY SETUP" : score <= -3 && rsi > 28 ? "SELL SETUP" : "WAIT";
  const side = signal === "BUY SETUP" ? "long" : signal === "SELL SETUP" ? "short" : null;
  const stopDistance = Math.max(atr * 1.5, price * 0.001);
  const stop = side === "long" ? price - stopDistance : side === "short" ? price + stopDistance : null;
  const target = side === "long" ? price + stopDistance * 2 : side === "short" ? price - stopDistance * 2 : null;
  const trend = e20 > e50 ? "Bullish EMA structure" : "Bearish EMA structure";
  return {
    symbol, interval, timestamp: Date.now(), candleTime: data[i].time, price, ema20: e20, ema50: e50,
    rsi, macdHistogram: macd, atr, score, signal, side, trend, reasons,
    entry: price, stop, target, riskReward: 2,
    ruleDescription: "EMA20/EMA50 + RSI14 + MACD histogram; stop reference = 1.5 × ATR14; target reference = 2R.",
    candleCount: data.length
  };
}

function renderAnalysis(a) {
  latestAnalysis = a;
  const title = $("signalTitle");
  title.textContent = a.signal;
  title.className = a.signal === "BUY SETUP" ? "signal-buy" : a.signal === "SELL SETUP" ? "signal-sell" : "signal-wait";
  safeText("signalSummary", `${MARKET_NAMES[a.symbol] || a.symbol} · ${a.interval} · ${a.trend}. Conditions are refreshed from closed candles.`);
  safeText("signalScore", `${a.score > 0 ? "+" : ""}${a.score} / 4`);
  safeText("signalScoreCaption", `${Math.abs(a.score)} net directional points · not a win probability`);
  safeText("analysisPrice", formatUSD(a.price));
  safeText("ema20Value", formatUSD(a.ema20));
  safeText("ema50Value", formatUSD(a.ema50));
  safeText("rsiValue", formatNumber(a.rsi, 1));
  safeText("macdValue", formatUSD(a.macdHistogram, 4));
  safeText("atrValue", formatUSD(a.atr, 4));
  safeText("suggestedSide", a.side ? a.side.toUpperCase() : "WAIT · no plan");
  safeText("suggestedEntry", formatUSD(a.entry));
  safeText("suggestedStop", a.stop == null ? "—" : formatUSD(a.stop));
  safeText("suggestedTarget", a.target == null ? "—" : formatUSD(a.target));
  $("useSignalButton").disabled = !a.side;
  const list = $("reasonsList");
  list.replaceChildren();
  a.reasons.forEach((reason) => {
    const li = document.createElement("li");
    li.className = `reason-${reason.tone}`;
    const strong = document.createElement("strong");
    strong.textContent = reason.title;
    const detail = document.createElement("span");
    detail.textContent = reason.detail;
    li.append(strong, detail);
    list.appendChild(li);
  });
  const tags = $("signalTags");
  tags.innerHTML = "";
  [a.interval, a.trend, `RSI ${formatNumber(a.rsi, 1)}`, `ATR ${formatNumber(a.atr, 3)}`].forEach((text) => {
    const span = document.createElement("span"); span.className = "tag"; span.textContent = text; tags.appendChild(span);
  });
  safeText("aiAnalysisText", localCommentary(a));
  safeText("aiStatus", "Local indicator-based commentary ready. Optional AI service requires backend setup.");
  safeText("analysisUpdated", `Analysed ${a.candleCount} closed candles at ${new Date(a.timestamp).toLocaleTimeString()}.`);
}
function localCommentary(a) {
  if (a.signal === "BUY SETUP") return `Rule-based read: bullish conditions are aligned on ${a.interval}. Price ${formatUSD(a.price)} is above EMA20 and EMA20 is above EMA50, with RSI ${formatNumber(a.rsi, 1)} and a positive MACD histogram. The reference stop is ${formatUSD(a.stop)} and the illustrative 2R target is ${formatUSD(a.target)}. Review structure, support/resistance, liquidity, spread and fees before any decision.`;
  if (a.signal === "SELL SETUP") return `Rule-based read: bearish conditions are aligned on ${a.interval}. Price ${formatUSD(a.price)} is below EMA20 and EMA20 is below EMA50, with RSI ${formatNumber(a.rsi, 1)} and a negative MACD histogram. The reference stop is ${formatUSD(a.stop)} and the illustrative 2R target is ${formatUSD(a.target)}. Review structure, support/resistance, liquidity, spread and fees before any decision.`;
  return `Rule-based read: WAIT. The chosen rules are not aligned strongly enough to create a setup on ${a.interval}. Current price is ${formatUSD(a.price)}, RSI is ${formatNumber(a.rsi, 1)}, and the EMA structure is ${a.trend.toLowerCase()}. A directional trend alone is not an entry signal. Wait for a clearer setup and confirm it on a chart.`;
}
async function refreshAnalysis() {
  const button = $("refreshAnalysis");
  button.disabled = true; button.textContent = "Analyzing…";
  try {
    const symbol = $("analysisSymbol").value;
    const interval = $("analysisInterval").value;
    const limit = Number($("analysisCandles").value);
    const rows = await loadKlines(symbol, interval, limit);
    const analysis = makeAnalysis(rows, symbol, interval);
    renderAnalysis(analysis);
    safeText("btMessage", "Ready. Backtesting uses its own selected settings.");
  } catch (error) {
    safeText("signalTitle", "ANALYSIS UNAVAILABLE");
    safeText("signalSummary", error.message || "Could not compute indicators.");
    console.error("Signal analysis failed:", error);
  } finally {
    button.disabled = false; button.textContent = "Analyze market";
  }
}
function applySignalToCalculator() {
  if (!latestAnalysis || !latestAnalysis.side) return;
  $("symbol").value = latestAnalysis.symbol === "BTCUSDT" ? "BTC/USDT" : "ETH/USDT";
  $("side").value = latestAnalysis.side;
  $("entry").value = Number(latestAnalysis.entry.toFixed(4));
  $("stop").value = Number(latestAnalysis.stop.toFixed(4));
  $("target").value = Number(latestAnalysis.target.toFixed(4));
  calculatePlan();
  $("calculator").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ----------------------------- Risk calculator -----------------------------
function calculatePlan() {
  const entry = Number($("entry").value); const stop = Number($("stop").value); const target = Number($("target").value);
  const capital = Number($("capital").value); const riskPercent = Number($("risk").value);
  const usdToInr = Number($("fx").value); const leverage = Number($("leverage").value); const feePercent = Number($("fee").value);
  const isLong = $("side").value === "long";
  const valid = [entry, stop, target, capital, riskPercent, usdToInr, leverage, feePercent].every(Number.isFinite)
    && entry > 0 && stop > 0 && target > 0 && capital > 0 && riskPercent > 0 && riskPercent <= 5
    && usdToInr > 0 && leverage > 0 && feePercent >= 0
    && (isLong ? stop < entry && target > entry : stop > entry && target < entry);
  if (!valid) {
    safeText("calcMessage", "Invalid setup. Use positive values, risk between 0 and 5%, and place stop/target on the correct side of entry.");
    ["riskOut", "rrOut", "sizeOut", "profitOut", "lossOut", "marginOut"].forEach((id) => safeText(id, "—"));
    return;
  }
  const riskBudget = capital * riskPercent / 100;
  const stopDistanceFraction = Math.abs(entry - stop) / entry;
  const targetDistanceFraction = Math.abs(target - entry) / entry;
  const rewardRisk = targetDistanceFraction / stopDistanceFraction;
  const positionValueINR = riskBudget / stopDistanceFraction;
  const positionUnits = positionValueINR / usdToInr / entry;
  const grossTargetINR = positionValueINR * targetDistanceFraction;
  const grossStopINR = positionValueINR * stopDistanceFraction;
  const estimatedFeesINR = positionValueINR * (feePercent / 100) * 2;
  safeText("riskOut", formatINR(riskBudget));
  safeText("rrOut", `${formatNumber(rewardRisk)}:1`);
  safeText("sizeOut", `${formatINR(positionValueINR)} · ${formatNumber(positionUnits, 6)} units`);
  safeText("profitOut", formatINR(grossTargetINR - estimatedFeesINR));
  safeText("lossOut", formatINR(grossStopINR + estimatedFeesINR));
  safeText("marginOut", formatINR(positionValueINR / leverage));
  safeText("calcMessage", `Risk budget ${formatINR(riskBudget)} · stop distance ${formatNumber(stopDistanceFraction * 100, 3)}% · estimated round-trip fees ${formatINR(estimatedFeesINR)}. Position sizing is approximate.`);
}
function useLivePrice() {
  const asset = $("symbol").value.startsWith("BTC") ? "BTC" : "ETH";
  const price = prices[asset];
  if (!price) { safeText("calcMessage", "Live ticker price is unavailable right now."); return; }
  const isLong = $("side").value === "long";
  const stopFraction = Math.min(Math.max((Number($("risk").value) || 1) / 100, 0.001), 0.05);
  $("entry").value = price;
  $("stop").value = price * (isLong ? 1 - stopFraction : 1 + stopFraction);
  $("target").value = price * (isLong ? 1 + 2 * stopFraction : 1 - 2 * stopFraction);
  calculatePlan();
}

// ----------------------------- Historical strategy backtesting -----------------------------
function runSimulation(candles, settings) {
  const data = candles.filter((c) => c.closeTime <= Date.now());
  const ind = indicatorPack(data);
  let equity = settings.startingCapital;
  let peak = equity; let maxDrawdown = 0; let grossWins = 0; let grossLosses = 0;
  const trades = []; const equityPoints = [equity];
  let i = 55;
  while (i < data.length - 2) {
    const previous = i - 1;
    const fast = ind.ema9[i]; const slow = ind.ema21[i];
    const prevFast = ind.ema9[previous]; const prevSlow = ind.ema21[previous];
    const rsi = ind.rsi[i]; const atr = ind.atr[i];
    if (![fast, slow, prevFast, prevSlow, rsi, atr].every(Number.isFinite) || atr <= 0) { i++; continue; }
    let side = null;
    if (prevFast <= prevSlow && fast > slow && rsi >= 50 && rsi <= 70) side = "LONG";
    if (prevFast >= prevSlow && fast < slow && rsi >= 30 && rsi <= 50) side = "SHORT";
    if (!side) { i++; continue; }

    const entryIndex = i + 1;
    const entry = data[entryIndex].open;
    const stopDistance = Math.max(atr * 1.5, entry * 0.001);
    let stop = side === "LONG" ? entry - stopDistance : entry + stopDistance;
    const target = side === "LONG" ? entry + stopDistance * 2 : entry - stopDistance * 2;
    const riskBudget = equity * settings.riskPercent / 100;
    const unitsFromRisk = riskBudget / stopDistance;
    const maxNotional = equity * settings.leverage;
    const units = Math.min(unitsFromRisk, maxNotional / entry);
    if (!Number.isFinite(units) || units <= 0 || equity <= 0) break;

    let exit = null; let exitIndex = entryIndex; let reason = "End of data";
    for (let k = entryIndex; k < data.length; k++) {
      const candle = data[k];
      if (side === "LONG") {
        const stopHit = candle.low <= stop;
        const targetHit = candle.high >= target;
        if (stopHit) { exit = stop; exitIndex = k; reason = "Stop loss"; break; } // conservative if both touched
        if (targetHit) { exit = target; exitIndex = k; reason = "Take profit"; break; }
      } else {
        const stopHit = candle.high >= stop;
        const targetHit = candle.low <= target;
        if (stopHit) { exit = stop; exitIndex = k; reason = "Stop loss"; break; }
        if (targetHit) { exit = target; exitIndex = k; reason = "Take profit"; break; }
      }
    }
    if (exit == null) { exitIndex = data.length - 1; exit = data[exitIndex].close; reason = "End of data"; }
    const direction = side === "LONG" ? 1 : -1;
    const grossPnL = (exit - entry) * units * direction;
    const feeCost = (entry + exit) * units * settings.feePercent / 100;
    const slippageCost = (entry + exit) * units * 0.0002; // rough 0.02% per side approximation
    const netPnL = grossPnL - feeCost - slippageCost;
    equity += netPnL;
    if (netPnL > 0) grossWins += netPnL; else grossLosses += Math.abs(netPnL);
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);
    const trade = { time: data[entryIndex].time, exitTime: data[exitIndex].time, side, entry, exit, reason, netPnL, equity };
    trades.push(trade); equityPoints.push(equity);
    i = Math.max(exitIndex + 1, i + 1); // do not overlap simulated positions
  }
  const wins = trades.filter((t) => t.netPnL > 0).length;
  return {
    trades, equity, startingCapital: settings.startingCapital,
    netReturn: (equity - settings.startingCapital) / settings.startingCapital * 100,
    winRate: trades.length ? wins / trades.length * 100 : 0,
    profitFactor: grossLosses === 0 ? (grossWins > 0 ? Infinity : 0) : grossWins / grossLosses,
    maxDrawdown, equityPoints, candleCount: data.length
  };
}
function renderEquityCurve(points) {
  const canvas = $("equityCanvas");
  if (!canvas) return;
  const cssWidth = Math.max(280, canvas.clientWidth || 600);
  const height = 180; const scale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(cssWidth * scale); canvas.height = Math.floor(height * scale);
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, cssWidth, height);
  ctx.strokeStyle = "rgba(158,171,197,.18)"; ctx.lineWidth = 1;
  for (let row = 1; row <= 3; row++) { const y = row * height / 4; ctx.beginPath(); ctx.moveTo(12, y); ctx.lineTo(cssWidth - 12, y); ctx.stroke(); }
  if (!points || points.length < 2) {
    ctx.fillStyle = "#9eabc5"; ctx.font = "13px system-ui"; ctx.fillText("Run a backtest to draw the equity curve.", 18, height / 2);
    return;
  }
  const min = Math.min(...points); const max = Math.max(...points); const range = Math.max(max - min, Math.abs(max) * 0.001, 1);
  const left = 12; const right = cssWidth - 12; const top = 12; const bottom = height - 12;
  ctx.strokeStyle = "#5e8cff"; ctx.lineWidth = 2; ctx.beginPath();
  points.forEach((point, idx) => {
    const x = left + idx / (points.length - 1) * (right - left);
    const y = bottom - (point - min) / range * (bottom - top);
    if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = "#9eabc5"; ctx.font = "11px system-ui";
  ctx.fillText(formatNumber(max, 2), 14, 12); ctx.fillText(formatNumber(min, 2), 14, height - 2);
}
function renderBacktest(result) {
  safeText("btFinal", formatUSD(result.equity));
  safeText("btReturn", `${result.netReturn >= 0 ? "+" : ""}${formatNumber(result.netReturn, 2)}%`);
  $("btReturn").className = result.netReturn >= 0 ? "positive" : "negative";
  safeText("btCount", String(result.trades.length));
  safeText("btWinRate", `${formatNumber(result.winRate, 1)}%`);
  safeText("btProfitFactor", Number.isFinite(result.profitFactor) ? formatNumber(result.profitFactor, 2) : "∞");
  safeText("btDrawdown", `${formatNumber(result.maxDrawdown, 2)}%`);
  const body = $("btTradesBody"); body.replaceChildren();
  if (!result.trades.length) {
    const row = document.createElement("tr"); const cell = document.createElement("td");
    cell.colSpan = 7; cell.className = "empty-cell"; cell.textContent = "No trades met this strategy's rules in the downloaded history."; row.appendChild(cell); body.appendChild(row);
  } else {
    result.trades.slice(-30).reverse().forEach((trade) => {
      const row = document.createElement("tr");
      const values = [new Date(trade.time).toLocaleString(), trade.side, formatUSD(trade.entry), formatUSD(trade.exit), trade.reason, `${trade.netPnL >= 0 ? "+" : ""}${formatUSD(trade.netPnL)}`, formatUSD(trade.equity)];
      values.forEach((value, index) => { const cell = document.createElement("td"); cell.textContent = value; if (index === 5) cell.className = trade.netPnL >= 0 ? "positive" : "negative"; row.appendChild(cell); });
      body.appendChild(row);
    });
  }
  lastBacktestEquity = result.equityPoints;
  renderEquityCurve(result.equityPoints);
}
async function startBacktest() {
  const button = $("runBacktest"); button.disabled = true; button.textContent = "Testing…";
  setStatus("btMessage", "Downloading candles and simulating the strategy…");
  try {
    const settings = {
      symbol: $("btSymbol").value, interval: $("btInterval").value, limit: Number($("btCandles").value),
      startingCapital: Number($("btCapital").value), riskPercent: Number($("btRisk").value),
      leverage: Number($("btLeverage").value), feePercent: Number($("btFee").value)
    };
    if (!(settings.startingCapital >= 10) || !(settings.riskPercent > 0 && settings.riskPercent <= 2) || !(settings.leverage >= 1) || !(settings.feePercent >= 0 && settings.feePercent <= 1)) {
      throw new Error("Use starting capital ≥ 10 USDT, risk from 0.1% to 2%, leverage from 1× to 5×, and fees from 0% to 1% per side.");
    }
    const candles = await loadKlines(settings.symbol, settings.interval, settings.limit);
    const result = runSimulation(candles, settings);
    renderBacktest(result);
    setStatus("btMessage", `Test complete on ${result.candleCount} historical candles. Entry is the next candle open; fees and approximate slippage are deducted.`, "ok");
  } catch (error) {
    setStatus("btMessage", error.message || "Backtest failed.", "bad");
    console.error("Backtest failed:", error);
  } finally { button.disabled = false; button.textContent = "Run backtest"; }
}

// ----------------------------- Paper-trade journal -----------------------------
function readJournal() {
  try { const data = JSON.parse(localStorage.getItem(JOURNAL_KEY) || "[]"); return Array.isArray(data) ? data : []; }
  catch (error) { console.error("Could not read journal:", error); return []; }
}
function saveJournal(entries) {
  try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries)); return true; }
  catch (error) { console.error("Could not save journal:", error); window.alert("Could not save journal. Export your records or check browser storage."); return false; }
}
function renderJournal() {
  const entries = readJournal(); const body = $("journalBody"); body.replaceChildren();
  if (!entries.length) {
    const row = document.createElement("tr"); const cell = document.createElement("td"); cell.className = "empty-cell"; cell.colSpan = 6; cell.textContent = "No trades recorded yet."; row.appendChild(cell); body.appendChild(row);
  } else {
    entries.slice().reverse().forEach((trade) => {
      const row = document.createElement("tr");
      const values = [new Date(trade.date).toLocaleString(), trade.market, String(trade.side).toUpperCase(), String(trade.result).toUpperCase(), formatINR(Number(trade.pnl)), trade.memo || "—"];
      values.forEach((value, index) => { const cell = document.createElement("td"); cell.textContent = value; if (index === 4 && Number(trade.pnl) !== 0) cell.className = Number(trade.pnl) > 0 ? "positive" : "negative"; row.appendChild(cell); });
      body.appendChild(row);
    });
  }
  const net = entries.reduce((sum, trade) => sum + (Number(trade.pnl) || 0), 0);
  const wins = entries.filter((trade) => Number(trade.pnl) > 0).length;
  safeText("tradeCount", `${entries.length} trade${entries.length === 1 ? "" : "s"}`);
  safeText("net", formatINR(net)); $("net").className = net >= 0 ? "positive" : "negative";
  safeText("winRate", `${formatNumber(entries.length ? wins / entries.length * 100 : 0, 1)}%`); safeText("wins", String(wins));
}
function addJournalEntry() {
  const raw = $("pnl").value; const pnl = Number(raw);
  if (!raw.trim() || !Number.isFinite(pnl)) { window.alert("Enter a valid realized P&L after fees."); return; }
  if ($("result").value === "win" && pnl <= 0) { window.alert("The selected outcome is Win, but P&L is not positive. Correct the outcome or P&L."); return; }
  if ($("result").value === "loss" && pnl >= 0) { window.alert("The selected outcome is Loss, but P&L is not negative. Correct the outcome or P&L."); return; }
  const entries = readJournal();
  entries.push({ date: new Date().toISOString(), market: $("symbol").value, side: $("side").value, result: $("result").value, pnl, memo: $("memo").value.trim() });
  if (saveJournal(entries)) { $("memo").value = ""; renderJournal(); }
}
function exportJournalCSV() {
  const entries = readJournal();
  if (!entries.length) { window.alert("There are no journal entries to export."); return; }
  const columns = ["date", "market", "side", "result", "pnl", "memo"];
  const escapeCSV = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const csv = [columns.join(","), ...entries.map((entry) => columns.map((column) => escapeCSV(entry[column])).join(","))].join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = "tradedesk-journal.csv"; document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function clearJournal() {
  if (!window.confirm("Delete all paper-trade journal entries saved in this browser? This cannot be undone.")) return;
  if (saveJournal([])) renderJournal();
}

// ----------------------------- Optional protected backend: AI + Delta read-only -----------------------------
function loadBackendSettings() {
  const settings = getConnectionSettings();
  if (settings.backendUrl) $("backendUrl").value = settings.backendUrl;
  try { const token = sessionStorage.getItem("tradedesk-backend-token"); if (token) $("backendToken").value = token; } catch { /* private browsing may restrict storage */ }
}
function saveBackendSettings() {
  const backendUrl = getBackendUrl();
  if (backendUrl && !/^https:\/\//i.test(backendUrl) && !/^http:\/\/localhost(?::\d+)?$/i.test(backendUrl)) {
    setStatus("backendStatus", "Use HTTPS for a deployed backend (localhost is allowed for testing).", "bad"); return;
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ backendUrl }));
  try { const token = String($("backendToken").value || "").trim(); if (token) sessionStorage.setItem("tradedesk-backend-token", token); else sessionStorage.removeItem("tradedesk-backend-token"); } catch { /* token can remain only in the field for this session */ }
  setStatus("backendStatus", backendUrl ? `Saved backend address: ${backendUrl}` : "Backend address cleared. Local market tools still work.", backendUrl ? "ok" : "warn");
}
async function testBackend() {
  const base = getBackendUrl();
  if (!base) { setStatus("backendStatus", "Enter and save your backend URL first.", "warn"); return; }
  try {
    const health = await fetchJSON(`${base}/api/health`);
    setStatus("backendStatus", `Connected · ${health.service || "TradeDesk backend"} · ${health.aiConfigured ? "AI configured" : "AI not configured"}`, "ok");
  } catch (error) { setStatus("backendStatus", `Connection failed: ${error.message}`, "bad"); }
}
async function connectDelta() {
  const base = getBackendUrl();
  if (!base) { setStatus("deltaStatus", "Enter and save your secured backend URL first.", "warn"); return; }
  setStatus("deltaStatus", "Checking secure read-only account endpoint…");
  try {
    const data = await fetchJSON(`${base}/api/delta/balances`, { headers: privateHeaders() });
    const balances = Array.isArray(data.balances) ? data.balances : [];
    const summary = balances.slice(0, 5).map((b) => `${b.asset}: ${b.availableBalance}`).join(" · ");
    setStatus("deltaStatus", `Connected read-only${summary ? ` · ${summary}` : " · no balance rows returned"}. Live orders remain disabled.`, "ok");
  } catch (error) { setStatus("deltaStatus", `Not connected: ${error.message}. Check server settings and read-only API keys.`, "bad"); }
}
async function requestAICommentary() {
  const base = getBackendUrl();
  if (!latestAnalysis) { setStatus("aiStatus", "Run Analyze market first.", "warn"); return; }
  if (!base) { setStatus("aiStatus", "No backend configured. Showing local rule-based commentary instead.", "warn"); safeText("aiAnalysisText", localCommentary(latestAnalysis)); return; }
  setStatus("aiStatus", "Requesting model commentary from your secured backend…");
  try {
    const result = await fetchJSON(`${base}/api/ai-analysis`, {
      method: "POST", headers: privateHeaders(),
      body: JSON.stringify({ analysis: latestAnalysis })
    }, 25000);
    if (!result.analysis) throw new Error("The backend did not return analysis text.");
    safeText("aiAnalysisText", result.analysis);
    setStatus("aiStatus", `AI commentary ready${result.model ? ` · ${result.model}` : ""}. Verify every claim against the chart.`, "ok");
  } catch (error) {
    safeText("aiAnalysisText", `${localCommentary(latestAnalysis)}\n\nOptional AI service unavailable: ${error.message}`);
    setStatus("aiStatus", `AI request failed: ${error.message}`, "bad");
  }
}

// ----------------------------- Start-up -----------------------------
function initializeApp() {
  $("calcButton").addEventListener("click", calculatePlan);
  $("livePriceButton").addEventListener("click", useLivePrice);
  $("refreshAnalysis").addEventListener("click", refreshAnalysis);
  $("useSignalButton").addEventListener("click", applySignalToCalculator);
  $("runBacktest").addEventListener("click", startBacktest);
  $("logTradeButton").addEventListener("click", addJournalEntry);
  $("exportButton").addEventListener("click", exportJournalCSV);
  $("clearButton").addEventListener("click", clearJournal);
  $("saveBackendSettings").addEventListener("click", saveBackendSettings);
  $("testBackendButton").addEventListener("click", testBackend);
  $("connectDeltaButton").addEventListener("click", connectDelta);
  $("aiAnalysisButton").addEventListener("click", requestAICommentary);
  $("btSymbol").addEventListener("change", () => {});
  $("analysisSymbol").addEventListener("change", () => {});
  window.addEventListener("resize", () => { if (lastBacktestEquity.length) renderEquityCurve(lastBacktestEquity); });
  loadBackendSettings();
  renderJournal();
  calculatePlan();
  loadMarketData();
  refreshAnalysis();
  window.setInterval(loadMarketData, 60000);
  // Recompute indicators on a slower cadence to avoid hammering public candle endpoints.
  window.setInterval(refreshAnalysis, 180000);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initializeApp);
else initializeApp();
