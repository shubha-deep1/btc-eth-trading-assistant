"use strict";

// TradeDesk optional backend.
// Supported private actions: AI commentary and read-only Delta wallet balances.
// Deliberately no live order-placement route exists in this release.
require("dotenv").config();
const crypto = require("node:crypto");
const express = require("express");

const app = express();
const PORT = Number(process.env.PORT || 8787);
const MAX_BODY_BYTES = "32kb";
app.disable("x-powered-by");
app.use(express.json({ limit: MAX_BODY_BYTES, strict: true }));

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "http://localhost:8787,http://127.0.0.1:8787")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  } else if (origin) {
    return res.status(403).json({ error: "This website origin is not allowed by the backend." });
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Small in-memory rate limiter. Use your host's rate-limiting features as well for production.
const rateBuckets = new Map();
app.use((req, res, next) => {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const record = rateBuckets.get(key) || { count: 0, resetAt: now + 60_000 };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + 60_000; }
  record.count += 1;
  rateBuckets.set(key, record);
  if (record.count > 90) return res.status(429).json({ error: "Rate limit reached. Wait a minute and retry." });
  if (rateBuckets.size > 5000) {
    for (const [ip, value] of rateBuckets) if (value.resetAt < now) rateBuckets.delete(ip);
  }
  next();
});

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
function requirePrivateAccess(req, res, next) {
  const expected = process.env.APP_ACCESS_TOKEN;
  if (!expected || expected.length < 24) {
    return res.status(503).json({ error: "Private endpoints are locked. Configure APP_ACCESS_TOKEN (at least 24 characters) on the backend first." });
  }
  const header = String(req.headers.authorization || "");
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!constantTimeEqual(supplied, expected)) return res.status(401).json({ error: "Invalid or missing app access token." });
  next();
}
function hasDeltaCredentials() {
  return Boolean(process.env.DELTA_API_KEY && process.env.DELTA_API_SECRET);
}
function signDeltaRequest(method, timestamp, pathAndQuery, bodyText = "") {
  const prehash = `${method.toUpperCase()}${timestamp}${pathAndQuery}${bodyText}`;
  return crypto.createHmac("sha256", process.env.DELTA_API_SECRET).update(prehash).digest("hex");
}
async function deltaRequest(pathAndQuery) {
  const base = String(process.env.DELTA_BASE_URL || "https://api.india.delta.exchange").replace(/\/+$/, "");
  const method = "GET";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signDeltaRequest(method, timestamp, pathAndQuery, "");
  const response = await fetch(`${base}${pathAndQuery}`, {
    method,
    headers: {
      "Accept": "application/json",
      "api-key": process.env.DELTA_API_KEY,
      "signature": signature,
      "timestamp": timestamp,
      "User-Agent": "TradeDesk/2.0 Node.js"
    },
    signal: AbortSignal.timeout(12_000)
  });
  const rawText = await response.text();
  let data;
  try { data = rawText ? JSON.parse(rawText) : {}; } catch { data = {}; }
  if (!response.ok || data.success === false) {
    const code = data?.error?.code || `http_${response.status}`;
    throw new Error(`Delta Exchange returned ${code}. Check API key environment, permissions and IP whitelist.`);
  }
  return data;
}
function asSafeString(value, max = 160) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

app.get("/api/health", (_req, res) => {
  res.json({
    service: "TradeDesk API",
    version: "2.0.0",
    status: "ok",
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    deltaReadOnlyConfigured: hasDeltaCredentials(),
    liveOrderPlacement: false,
    time: new Date().toISOString()
  });
});

app.get("/api/delta/balances", requirePrivateAccess, async (_req, res) => {
  if (!hasDeltaCredentials()) return res.status(503).json({ error: "Set DELTA_API_KEY and DELTA_API_SECRET on the server first." });
  try {
    const response = await deltaRequest("/v2/wallet/balances");
    const rows = Array.isArray(response.result) ? response.result : [];
    const balances = rows.map((row) => ({
      asset: String(row.asset_symbol || "UNKNOWN"),
      balance: String(row.balance ?? "0"),
      availableBalance: String(row.available_balance ?? "0"),
      blockedMargin: String(row.blocked_margin ?? "0")
    }));
    res.json({ success: true, balances });
  } catch (error) {
    console.error("Delta read-only balances error:", error.message);
    res.status(502).json({ error: error.message || "Delta Exchange balance request failed." });
  }
});

app.post("/api/ai-analysis", requirePrivateAccess, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "AI is not configured. Set OPENAI_API_KEY on the backend." });
  const a = req.body && req.body.analysis;
  if (!a || typeof a !== "object" || !["BTCUSDT", "ETHUSDT"].includes(a.symbol)) {
    return res.status(400).json({ error: "Provide a valid BTCUSDT or ETHUSDT technical analysis snapshot." });
  }
  const numericFields = ["price", "ema20", "ema50", "rsi", "macdHistogram", "atr", "score"];
  if (!numericFields.every((key) => Number.isFinite(Number(a[key]))) || !["BUY SETUP", "SELL SETUP", "WAIT"].includes(a.signal)) {
    return res.status(400).json({ error: "Analysis snapshot has invalid indicator values." });
  }
  const snapshot = {
    symbol: a.symbol,
    interval: asSafeString(a.interval, 8),
    signal: a.signal,
    ruleScore: Number(a.score),
    closePrice: Number(a.price),
    ema20: Number(a.ema20),
    ema50: Number(a.ema50),
    rsi14: Number(a.rsi),
    macdHistogram: Number(a.macdHistogram),
    atr14: Number(a.atr),
    trend: asSafeString(a.trend, 80),
    indicatorRules: asSafeString(a.ruleDescription, 220),
    ruleReasons: Array.isArray(a.reasons) ? a.reasons.slice(0, 8).map((item) => ({
      title: asSafeString(item?.title, 100), detail: asSafeString(item?.detail, 220)
    })) : []
  };
  const prompt = [
    "Analyze this cryptocurrency technical-indicator snapshot for educational purposes.",
    "Use only the provided values. Do not claim to have live news, order-book data, market structure details, or volume information that is not supplied.",
    "Explain trend alignment, momentum, volatility, conflicting signals, and what would invalidate the setup.",
    "Do not promise profits, do not invent a probability of success, and do not tell the user to invest or use a specific amount of money.",
    "If the rules say WAIT, explain why waiting may be preferable. Make clear that this is not financial advice and that the rule score is not a win probability.",
    "Keep the output readable with short headings and concise bullet points.",
    `Snapshot JSON: ${JSON.stringify(snapshot)}`
  ].join("\n\n");
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        instructions: "You are an analytical assistant. Clearly separate supplied facts from interpretation. Never imply guaranteed returns or autonomous execution.",
        input: prompt,
        max_output_tokens: 700,
        store: false
      }),
      signal: AbortSignal.timeout(25_000)
    });
    const payloadText = await response.text();
    let payload;
    try { payload = payloadText ? JSON.parse(payloadText) : {}; } catch { payload = {}; }
    if (!response.ok) {
      const message = payload?.error?.message || `AI provider returned HTTP ${response.status}`;
      console.error("AI provider error:", message);
      return res.status(502).json({ error: "AI provider request failed. Check the server key, model configuration and provider account." });
    }
    const text = typeof payload.output_text === "string" ? payload.output_text : (payload.output || [])
      .flatMap((item) => Array.isArray(item.content) ? item.content : [])
      .filter((part) => part.type === "output_text")
      .map((part) => part.text || "").join("\n");
    if (!text.trim()) return res.status(502).json({ error: "The AI provider returned no text. Retry later." });
    res.json({ success: true, model: payload.model || model, analysis: text.trim() });
  } catch (error) {
    console.error("AI commentary error:", error.message);
    res.status(502).json({ error: "Could not reach the AI provider. Check server connectivity and try again." });
  }
});

app.use((_req, res) => res.status(404).json({ error: "Endpoint not found." }));
app.use((error, _req, res, _next) => {
  console.error("Unhandled backend error:", error.message);
  res.status(500).json({ error: "Unexpected backend error." });
});

app.listen(PORT, () => console.log(`TradeDesk API listening on port ${PORT}`));
