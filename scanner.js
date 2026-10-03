/**
 * Crypto Futures Scanner — Node.js headless version (Bybit)
 * Scans Bybit USDT perpetual futures for:
 *   - Candle close above upper regression line (1H, 40-period, +2σ)
 *   - Green/up slope
 *   - Distance ≥ 3% above upper band
 * Sends push notifications via ntfy.sh
 */

const BYBIT_BASE = 'https://api.bybit.com';
const NTFY_URL = 'https://ntfy.sh/crypto-signals-ashir-x7k2';
const TOTAL_COINS_TO_SCAN = 500;
const MIN_DISTANCE_PCT = 3;
const BATCH_SIZE = 5;
const REGRESSION_PERIOD = 40;
const CANDLE_LIMIT = 100;

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ------------------------------------------------------------------
// Fetch all USDT perpetual symbols from Bybit
// ------------------------------------------------------------------
async function fetchFuturesSymbols() {
    try {
        const res = await fetch(`${BYBIT_BASE}/v5/market/instruments-info?category=linear&limit=1000`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.retCode !== 0) throw new Error(`Bybit error: ${data.retMsg}`);

        const symbols = data.result.list
            .filter(s => s.quoteCoin === 'USDT' && s.status === 'Trading' && s.contractType === 'LinearPerpetual')
            .sort((a, b) => b.symbol.localeCompare(a.symbol))
            .slice(0, TOTAL_COINS_TO_SCAN)
            .map(s => s.symbol);

        log(`Fetched ${symbols.length} symbols from Bybit`);
        return symbols;
    } catch (err) {
        log(`ERROR fetching symbols: ${err.message}`);
        return [];
    }
}

// ------------------------------------------------------------------
// Fetch candles (1H) for one symbol — Bybit V5 kline endpoint
// ------------------------------------------------------------------
async function fetchCandles(symbol, interval = '60', limit = CANDLE_LIMIT) {
    try {
        const url = `${BYBIT_BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const res = await fetch(url);
        if (!res.ok) {
            if (res.status === 429 || res.status === 418) {
                log(`Rate limited on ${symbol} — sleeping 3s`);
                await new Promise(r => setTimeout(r, 3000));
            }
            return null;
        }
        const data = await res.json();
        if (data.retCode !== 0) return null;
        // Bybit returns newest first — reverse to oldest first
        return data.result.list.slice().reverse();
    } catch (err) {
        log(`ERROR fetching candles for ${symbol}: ${err.message}`);
        return null;
    }
}

// ------------------------------------------------------------------
// Linear regression (last 40 closes) with ±2σ bands
// ------------------------------------------------------------------
function calcRegression(closes) {
    const n = Math.min(closes.length, REGRESSION_PERIOD);
    const prices = closes.slice(-n);
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += prices[i];
        sumXY += i * prices[i];
        sumXX += i * i;
    }
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return null;
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;

    let ssRes = 0;
    for (let i = 0; i < n; i++) {
        const pred = slope * i + intercept;
        ssRes += Math.pow(prices[i] - pred, 2);
    }
    const stdDev = Math.sqrt(ssRes / n);
    const current = slope * (n - 1) + intercept;

    return {
        current,
        upper: current + 2 * stdDev,
        lower: current - 2 * stdDev,
        slope,
        stdDev,
        period: n
    };
}

// ------------------------------------------------------------------
// Analyze one symbol
// Bybit kline format: [startTime, open, high, low, close, volume, turnover]
// ------------------------------------------------------------------
async function analyzeSymbol(symbol) {
    const candles = await fetchCandles(symbol, '60', CANDLE_LIMIT);
    if (!candles || candles.length < REGRESSION_PERIOD) return null;

    const closes = candles.map(c => parseFloat(c[4]));
    const currentPrice = closes[closes.length - 1];
    const lastCandle = candles[candles.length - 1];
    const lastClose = parseFloat(lastCandle[4]);
    const volume = parseFloat(lastCandle[6] || lastCandle[5]); // turnover or volume

    const regression = calcRegression(closes);
    if (!regression) return null;

    const isAboveUpper = lastClose > regression.upper;
    const distancePercent = ((currentPrice - regression.upper) / regression.upper) * 100;

    return {
        symbol,
        signal: isAboveUpper ? 'SELL' : 'NO_SIGNAL',
        currentPrice,
        volume,
        distancePercent,
        slope: regression.slope,
        upper: regression.upper,
        lower: regression.lower
    };
}

// ------------------------------------------------------------------
// Strict criteria
// ------------------------------------------------------------------
function qualifiesForAlert(signal) {
    if (!signal) return false;
    if (signal.signal !== 'SELL') return false;
    if (signal.slope <= 0) return false;
    if (Math.abs(signal.distancePercent) < MIN_DISTANCE_PCT) return false;
    return true;
}

// ------------------------------------------------------------------
// Send ntfy push
// ------------------------------------------------------------------
async function sendPush(signal) {
    const symbol = signal.symbol;
    const tvUrl = `https://www.tradingview.com/chart/?symbol=BYBIT%3A${symbol}.P`;

    const title = `${symbol} SELL Signal`;
    const body =
        `Price: $${signal.currentPrice.toFixed(4)}\n` +
        `Distance: ${signal.distancePercent.toFixed(2)}% above upper band\n` +
        `Slope: UP Green (${signal.slope.toFixed(6)})\n` +
        `Volume: ${formatVolume(signal.volume)}\n` +
        `Time: ${new Date().toLocaleTimeString()}\n` +
        `\n` +
        `Open on TradingView:\n${tvUrl}`;

    try {
        const res = await fetch(NTFY_URL, {
            method: 'POST',
            headers: {
                'Title': title,
                'Priority': 'high',
                'Tags': 'warning',
                'Click': tvUrl
            },
            body: body
        });
        log(`PUSH ${symbol} -> HTTP ${res.status}`);
    } catch (err) {
        log(`PUSH FAILED for ${symbol}: ${err.message}`);
    }
}

function formatVolume(v) {
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
    return `$${v.toFixed(2)}`;
}

// ------------------------------------------------------------------
// Main scan
// ------------------------------------------------------------------
async function main() {
    log('===== SCAN START =====');
    const startTime = Date.now();

    const symbols = await fetchFuturesSymbols();
    if (symbols.length === 0) {
        log('No symbols to scan — exiting');
        return;
    }

    let sellCount = 0;
    let qualifyingCount = 0;
    let scanned = 0;

    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const batch = symbols.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(s => analyzeSymbol(s)));

        for (const r of results) {
            if (!r) { scanned++; continue; }
            scanned++;

            if (r.signal === 'SELL') sellCount++;

            if (qualifiesForAlert(r)) {
                qualifyingCount++;
                log(`SIGNAL: ${r.symbol} | dist=${r.distancePercent.toFixed(2)}% | slope=${r.slope.toFixed(6)}`);
                await sendPush(r);
            }
        }

        // Polite delay between batches
        await new Promise(r => setTimeout(r, 150));
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`===== SCAN DONE in ${duration}s =====`);
    log(`Scanned: ${scanned} | SELL signals: ${sellCount} | Qualified alerts sent: ${qualifyingCount}`);
}

main().catch(err => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
});
