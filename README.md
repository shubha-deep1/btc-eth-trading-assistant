# TradeDesk V2 · BTC & ETH

TradeDesk V2 expands the original static planner into a public-market technical-analysis dashboard with a transparent signal engine, a historical strategy tester, risk sizing, a local paper-trade journal, and an optional secured server for AI commentary and read-only Delta Exchange account checks.

## What's included

- **Live ticker overview:** BTC/USDT and ETH/USDT public 24-hour ticker data from Binance.
- **Automatic technical setup detection:** BUY SETUP / SELL SETUP / WAIT using EMA 20/50, RSI 14 and MACD histogram. ATR 14 gives illustrative stop distance; the default target is 2R.
- **Explainable analysis:** The dashboard lists the indicator rules supporting the current condition. The score is a rule-alignment score, not a win probability.
- **Risk calculator:** Estimates position size, planned risk, fees, target outcome and margin from user inputs.
- **Backtesting lab:** Simulates EMA 9/21 crossovers with an RSI filter on historical Binance candles, with ATR stop, 2R target, estimated fees and slippage, equity curve, win rate, profit factor and drawdown.
- **Paper-trade journal:** Stores entries in the browser and exports them to CSV.
- **Optional AI commentary:** The browser sends the indicator snapshot to `server.js`; the AI provider key remains on the backend.
- **Optional Delta Exchange read-only check:** The backend signs a request and returns wallet balances. Do not give the API key trading permissions for this feature.

## Important boundaries

The browser version does **not** place real orders. Automatic signals are deterministic technical rules, not a claim of AI prediction. AI commentary is optional and requires a backend plus an AI provider key. Delta account access is read-only in this release. There is deliberately no real-money order endpoint or unattended trading loop in the included backend; live execution should not be attached to signals until contract sizing, order/stop behavior, demo testing, loss caps and recovery handling have been verified against the exact Delta products being traded.

The front end is static, so GitHub Pages alone cannot safely keep exchange API secrets or run server-side AI requests. Do not paste API keys/secrets into `app.js`, `index.html`, or `styles.css`.

## Updating the existing GitHub Pages site

For the current website, replace these three root files with the new copies from this package:

1. `index.html`
2. `app.js`
3. `styles.css`

Commit the changes to the repository's `main` branch. These three files are enough for local market data, technical signals, the calculator, the historical backtester and journal. AI commentary and Delta balance lookup remain unavailable until you deploy the optional backend below.

## Optional backend deployment

The simplest route is to deploy this repository as a Node.js web service on a trusted backend host (for example a service that supports Node 20+). Keep the website hosted on GitHub Pages separately.

1. Include `server.js`, `package.json`, `.env.example` and `.gitignore` in the repository (or deploy them from a separate private backend repository).
2. Configure the backend build command as `npm install` and start command as `npm start`.
3. Copy the required values from `.env.example` into the host's **private environment settings**. Do not create or commit an actual `.env` file.
4. Set `APP_ACCESS_TOKEN` to a unique random string of at least 32 characters. This is the app access token you enter into the page; it is not your Delta API secret.
5. Set `ALLOWED_ORIGINS` to the origin of your GitHub Pages website, for example `https://YOUR-USERNAME.github.io`. Do not include `/repository-name/` in the origin.
6. For AI commentary, configure `OPENAI_API_KEY` and choose a model available to your provider account in `OPENAI_MODEL`.
7. For Delta read-only balance checks, configure `DELTA_API_KEY` and `DELTA_API_SECRET` on the backend. Prefer a read-only API key and any available IP restrictions. Use the matching production or demo environment base URL for the kind of account/key you created.
8. Open the deployed GitHub Pages website, go to **AI analysis & Delta Exchange account**, enter the backend URL and `APP_ACCESS_TOKEN`, save, then test the backend.

The backend's `/api/health` endpoint does not require the access token and reports which optional services are configured. AI and Delta wallet endpoints require the app access token.

## Local development

Requirements: Node.js 20 or later.

```bash
npm install
cp .env.example .env
# Edit .env and configure APP_ACCESS_TOKEN before using private endpoints.
npm start
```

For a local browser test, you can temporarily set `ALLOWED_ORIGINS=http://localhost:8787,http://127.0.0.1:8787` and serve the static files from a local web server on an allowed origin. Do not disable authentication or CORS to make deployment errors disappear.

## Backtest assumptions

The backtester:

- uses completed candles and avoids overlapping positions;
- evaluates the signal at a candle close and enters at the next candle open;
- uses EMA 9/21 crossover plus RSI confirmation;
- uses a 1.5 × ATR stop and a 2R target;
- sizes positions from the risk budget but caps notional at simulated equity × selected leverage;
- deducts the configured fee for both sides and an approximate 0.02% slippage allowance per side;
- assumes the stop was hit first when a candle touches both stop and target.

It does not model funding, liquidation, contract quantity rules, spread/order-book depth, latency, partial fills, exchange-specific stop triggers or the effect of parameter selection on future results. A backtest can look good while a live strategy loses money.

## Data and security notes

- Public ticker and candle information comes from Binance public endpoints and may be unavailable in some networks.
- Journal entries are stored in browser `localStorage`; export CSV backups.
- AI commentary is based only on the supplied indicator snapshot, not a full financial or news research system.
- The Delta route returns only asset symbol, balance, available balance and blocked margin. Do not expose private keys in the static website.
- Live trading is intentionally not enabled in this release.
