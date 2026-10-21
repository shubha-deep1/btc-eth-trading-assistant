// ============================================
// TradeDesk - BTC & ETH Trading Assistant
// Market Data, Risk Calculator & Trade Journal
// ============================================

const $ = (id) => document.getElementById(id);

const prices = {
    BTC: null,
    ETH: null
};

const JOURNAL_KEY = "tradedesk-journal";

// ============================================
// Utility Functions
// ============================================

function formatNumber(value, digits = 2) {
    if (!Number.isFinite(value)) {
        return "—";
    }

    return value.toLocaleString("en-IN", {
        maximumFractionDigits: digits
    });
}

function formatINR(value) {
    return `₹${formatNumber(value)}`;
}

// ============================================
// Live BTC & ETH Market Data
// ============================================

async function loadMarketData() {
    const endpoint =
        "https://api.binance.com/api/v3/ticker/24hr?symbols=%5B%22BTCUSDT%22%2C%22ETHUSDT%22%5D";

    try {
        const response = await fetch(endpoint, {
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error("Market data request failed");
        }

        const tickers = await response.json();

        tickers.forEach((ticker) => {
            const asset =
                ticker.symbol === "BTCUSDT" ? "BTC" : "ETH";

            prices[asset] = Number(ticker.lastPrice);

            const prefix = asset.toLowerCase();

            $(prefix + "Price").textContent =
                "$" + formatNumber(prices[asset]);

            const change = Number(ticker.priceChangePercent);

            const changeElement = $(prefix + "Change");

            changeElement.textContent =
                `${change >= 0 ? "+" : ""}${formatNumber(change)}% · 24h`;

            changeElement.className =
                "market-change " +
                (change >= 0 ? "positive" : "negative");
        });

    } catch (error) {
        ["btc", "eth"].forEach((asset) => {
            $(asset + "Price").textContent = "Unavailable";

            $(asset + "Change").textContent =
                "Market data unavailable. Try refreshing or use TradingView.";
        });

        console.error("Market data error:", error);
    }
}

// ============================================
// Trade Risk Calculator
// ============================================

function calculatePlan() {
    const entry = Number($("entry").value);
    const stop = Number($("stop").value);
    const target = Number($("target").value);

    const capital = Number($("capital").value);
    const riskPercent = Number($("risk").value);

    const usdToInr = Number($("fx").value);
    const leverage = Number($("leverage").value);
    const feePercent = Number($("fee").value);

    const isLong = $("side").value === "long";

    const validNumbers = [
        entry,
        stop,
        target,
        capital,
        riskPercent,
        usdToInr,
        leverage,
        feePercent
    ].every(Number.isFinite);

    const validSetup =
        validNumbers &&
        entry > 0 &&
        stop > 0 &&
        target > 0 &&
        capital > 0 &&
        riskPercent > 0 &&
        riskPercent <= 100 &&
        usdToInr > 0 &&
        leverage > 0 &&
        feePercent >= 0 &&
        (
            isLong
                ? stop < entry && target > entry
                : stop > entry && target < entry
        );

    if (!validSetup) {
        $("calcMessage").textContent =
            "Invalid setup. Use positive values and put stop loss and target on the correct side of entry.";

        [
            "riskOut",
            "rrOut",
            "sizeOut",
            "profitOut",
            "lossOut",
            "marginOut"
        ].forEach((id) => {
            $(id).textContent = "—";
        });

        return;
    }

    const riskBudget = capital * riskPercent / 100;

    const stopDistancePercent =
        Math.abs(entry - stop) / entry;

    const targetDistancePercent =
        Math.abs(target - entry) / entry;

    const rewardRisk =
        targetDistancePercent / stopDistancePercent;

    // Risk-based position value in INR.
    const positionValueINR =
        riskBudget / stopDistancePercent;

    // Approximate quantity in the base cryptocurrency.
    const positionUnits =
        positionValueINR / usdToInr / entry;

    const grossTargetINR =
        positionValueINR * targetDistancePercent;

    // Approximate entry and exit fees.
    const estimatedFeesINR =
        positionValueINR * (feePercent / 100) * 2;

    $("riskOut").textContent =
        formatINR(riskBudget);

    $("rrOut").textContent =
        `${formatNumber(rewardRisk)}:1`;

    $("sizeOut").textContent =
        `${formatINR(positionValueINR)} · ${formatNumber(positionUnits, 6)} units`;

    $("profitOut").textContent =
        formatINR(grossTargetINR - estimatedFeesINR);

    $("lossOut").textContent =
        formatINR(riskBudget + estimatedFeesINR);

    $("marginOut").textContent =
        formatINR(positionValueINR / leverage);

    $("calcMessage").textContent =
        `Stop distance: ${formatNumber(stopDistancePercent * 100, 3)}% · ` +
        `Gross target: ${formatINR(grossTargetINR)} · ` +
        `Estimated round-trip fees: ${formatINR(estimatedFeesINR)}.`;
}

// ============================================
// Use Current Market Price
// ============================================

function useLivePrice() {
    const asset = $("symbol").value.startsWith("BTC")
        ? "BTC"
        : "ETH";

    const price = prices[asset];

    if (!price) {
        $("calcMessage").textContent =
            "Live price is unavailable right now.";

        return;
    }

    const isLong = $("side").value === "long";

    const stopFraction =
        (Number($("risk").value) || 1) / 100;

    $("entry").value = price;

    $("stop").value = price * (
        isLong
            ? 1 - stopFraction
            : 1 + stopFraction
    );

    $("target").value = price * (
        isLong
            ? 1 + 2 * stopFraction
            : 1 - 2 * stopFraction
    );

    calculatePlan();
}

// ============================================
// Trade Journal Storage
// ============================================

function readJournal() {
    try {
        const stored =
            localStorage.getItem(JOURNAL_KEY) || "[]";

        const entries = JSON.parse(stored);

        return Array.isArray(entries) ? entries : [];

    } catch (error) {
        console.error("Could not read journal:", error);

        return [];
    }
}

function saveJournal(entries) {
    try {
        localStorage.setItem(
            JOURNAL_KEY,
            JSON.stringify(entries)
        );

        return true;

    } catch (error) {
        console.error("Could not save journal:", error);

        window.alert(
            "Could not save journal data. Export your records or check browser storage."
        );

        return false;
    }
}

// ============================================
// Display Journal & Statistics
// ============================================

function renderJournal() {
    const entries = readJournal();
    const body = $("journalBody");

    body.replaceChildren();

    if (entries.length === 0) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");

        cell.className = "empty-cell";
        cell.colSpan = 6;
        cell.textContent = "No trades recorded yet.";

        row.appendChild(cell);
        body.appendChild(row);

    } else {
        entries.slice().reverse().forEach((trade) => {
            const row = document.createElement("tr");

            const values = [
                new Date(trade.date).toLocaleString(),
                trade.market,
                String(trade.side).toUpperCase(),
                String(trade.result).toUpperCase(),
                formatINR(Number(trade.pnl)),
                trade.memo || "—"
            ];

            values.forEach((value, index) => {
                const cell = document.createElement("td");

                cell.textContent = value;

                if (index === 4 && Number(trade.pnl) !== 0) {
                    cell.className =
                        Number(trade.pnl) > 0
                            ? "positive"
                            : "negative";
                }

                row.appendChild(cell);
            });

            body.appendChild(row);
        });
    }

    const net = entries.reduce(
        (total, trade) => total + Number(trade.pnl),
        0
    );

    const positiveTrades = entries.filter(
        (trade) => Number(trade.pnl) > 0
    ).length;

    $("tradeCount").textContent =
        `${entries.length} trade${entries.length === 1 ? "" : "s"}`;

    $("net").textContent = formatINR(net);

    $("net").className =
        net >= 0 ? "positive" : "negative";

    $("winRate").textContent =
        `${formatNumber(
            entries.length
                ? positiveTrades / entries.length * 100
                : 0,
            1
        )}%`;

    $("wins").textContent =
        String(positiveTrades);
}

// ============================================
// Add a Journal Entry
// ============================================

function addJournalEntry() {
    const pnlInput = $("pnl").value;
    const pnl = Number(pnlInput);

    if (
        pnlInput.trim() === "" ||
        !Number.isFinite(pnl)
    ) {
        window.alert("Enter a valid realized P&L.");

        return;
    }

    const entries = readJournal();

    entries.push({
        date: new Date().toISOString(),
        market: $("symbol").value,
        side: $("side").value,
        result: $("result").value,
        pnl: pnl,
        memo: $("memo").value.trim()
    });

    if (!saveJournal(entries)) {
        return;
    }

    $("memo").value = "";

    renderJournal();
}

// ============================================
// Export Journal to CSV
// ============================================

function exportJournalCSV() {
    const entries = readJournal();

    if (entries.length === 0) {
        window.alert(
            "There are no journal entries to export."
        );

        return;
    }

    const columns = [
        "date",
        "market",
        "side",
        "result",
        "pnl",
        "memo"
    ];

    const escapeCSV = (value) => {
        return `"${String(value ?? "").replace(/"/g, '""')}"`;
    };

    const csv = [
        columns.join(","),

        ...entries.map((entry) =>
            columns
                .map((column) => escapeCSV(entry[column]))
                .join(",")
        )
    ].join("\r\n");

    const blob = new Blob(
        ["\uFEFF" + csv],
        { type: "text/csv;charset=utf-8;" }
    );

    const blobURL = URL.createObjectURL(blob);

    const link = document.createElement("a");

    link.href = blobURL;
    link.download = "tradedesk-journal.csv";

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => {
        URL.revokeObjectURL(blobURL);
    }, 1000);
}

// ============================================
// Clear Journal
// ============================================

function clearJournal() {
    const confirmed = window.confirm(
        "Delete all journal entries saved in this browser? This cannot be undone."
    );

    if (!confirmed) {
        return;
    }

    if (saveJournal([])) {
        renderJournal();
    }
}

// ============================================
// Initialize Application
// ============================================

function initializeApp() {
    $("calcButton").addEventListener(
        "click",
        calculatePlan
    );

    $("livePriceButton").addEventListener(
        "click",
        useLivePrice
    );

    $("logTradeButton").addEventListener(
        "click",
        addJournalEntry
    );

    $("exportButton").addEventListener(
        "click",
        exportJournalCSV
    );

    $("clearButton").addEventListener(
        "click",
        clearJournal
    );

    renderJournal();
    calculatePlan();
    loadMarketData();

    // Refresh market prices every 60 seconds.
    window.setInterval(loadMarketData, 60_000);
}

if (document.readyState === "loading") {
    document.addEventListener(
        "DOMContentLoaded",
        initializeApp
    );
} else {
    initializeApp();
}
