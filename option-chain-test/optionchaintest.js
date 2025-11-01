import * as math from 'mathjs';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

// === Path Setup ===
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === Load .env ===
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// === CONFIG ===
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const FINNHUB_BASE = process.env.FINNHUB_BASE_URL || 'https://finnhub.io/api/v1';
const POLYGON_KEY = process.env.POLYGON_API_KEY;
const RISK_FREE_RATE = 0.035;

if (!FINNHUB_KEY) throw new Error('FINNHUB_API_KEY missing');
if (!POLYGON_KEY) throw new Error('POLYGON_API_KEY missing');

// === Logging ===
const LOG_DIR = path.join(__dirname, 'log');
const LOG_FILE = path.join(LOG_DIR, 'optionchains.txt');
const RESULTS_JSON = path.join(LOG_DIR, 'results.json');
const ALERTS_CSV = path.join(LOG_DIR, 'alerts.csv');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const append = text => fs.appendFileSync(LOG_FILE, text + '\n', 'utf8');

const MIN_OPTION_PRICE = 0.01;
const DIFF_THRESHOLD = 10;
const MAX_MARKET_PRICE = 0.50;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// === Black-Scholes ===
function bsPrice({ S, K, T, r, sigma, type }) {
  const normCdf = x => 0.5 * (1 + math.erf(x / Math.sqrt(2)));
  if (T <= 0 || sigma <= 0)
    return type === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return type === 'call'
    ? S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2)
    : K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

// === Option Symbol Parser ===
function parseOptionSymbol(sym) {
  if (!sym) return null;
  const m = sym.match(/^([A-Z]+)(\d{6})([CP])(\d+)$/);
  if (!m) return null;
  const [, , , typeChar, strikeRaw] = m;
  return { type: typeChar === 'C' ? 'call' : 'put', strike: parseInt(strikeRaw, 10) / 1000 };
}

// === Polygon Spot Price ===
async function fetchSpot(symbol) {
  try {
    const res = await axios.get(`https://api.polygon.io/v3/reference/tickers/${symbol}`, {
      params: { apiKey: POLYGON_KEY }
    });
    const spot = parseFloat(res.data.results.last_quote?.price || res.data.results.day?.c);
    console.log(`${symbol} Spot Price: $${spot}`);
    return spot;
  } catch (err) {
    console.error(`Error fetching spot price for ${symbol}:`, err.message);
    append(`\n=== ${symbol} ===`);
    append('Failed to fetch spot price.');
    return null;
  }
}

// === Failed Calls Cache ===
let failedPolygonCalls = [];

// === Finnhub Option Chain Fetch with Polygon Fallback ===
let lastFinnhubCall = 0;
const FINNHUB_CALL_INTERVAL = 1091; // ms
async function fetchOptionChain(symbol, expirationDate) {
  try {
    const now = Date.now();
    const wait = FINNHUB_CALL_INTERVAL - (now - lastFinnhubCall);
    if (wait > 0) await sleep(wait);

    const res = await axios.get(`${FINNHUB_BASE}/option-chain`, {
      params: { symbol, expiration: expirationDate, token: FINNHUB_KEY }
    });
    lastFinnhubCall = Date.now();
    return [...(res.data.calls || []), ...(res.data.puts || [])];
  } catch (err) {
    console.warn(`Finnhub fetch failed for ${symbol}: ${err.message}, caching for retry`);
    failedPolygonCalls.push({ symbol, expirationDate });
    return [];
  }
}

// === Polygon Option Chain Fallback ===
async function fetchPolygonOptionChain(symbol, expirationDate) {
  try {
    const res = await axios.get(`https://api.polygon.io/v3/snapshot/options/${symbol}`, {
      params: { expiration_date: expirationDate, apiKey: POLYGON_KEY, limit: 250 }
    });
    return res.data.results || [];
  } catch (err) {
    console.warn(`Polygon fetch failed for ${symbol}: ${err.message}, caching for retry`);
    failedPolygonCalls.push({ symbol, expirationDate });
    return [];
  }
}

// === Retry Cached Calls ===
async function retryFailedCalls() {
  if (!failedPolygonCalls.length) return;
  console.log(`\n🔁 Retrying ${failedPolygonCalls.length} failed option chain calls...`);
  const retryCalls = [...failedPolygonCalls];
  failedPolygonCalls = [];

  for (const { symbol, expirationDate } of retryCalls) {
    let options = await fetchOptionChain(symbol, expirationDate);
    if (!options.length) options = await fetchPolygonOptionChain(symbol, expirationDate);
    // Save or log results from retry if needed
    if (options.length) append(`\n✅ Retry success for ${symbol} ${expirationDate}`);
    else append(`\n❌ Retry failed for ${symbol} ${expirationDate}`);
  }
}

// === Generate Expiration Dates for Next 2 Months ===
function getNextTwoMonthsExpirations() {
  const expirations = [];
  const now = new Date();
  const end = new Date(now);
  end.setMonth(end.getMonth() + 2);
  let date = new Date(now);
  while (date <= end) {
    if (date.getDay() !== 0 && date.getDay() !== 6) {
      expirations.push(new Date(date).toISOString().split('T')[0]);
    }
    date.setDate(date.getDate() + 1);
  }
  return expirations;
}

// === Analyze Symbol ===
async function analyzeSymbol(symbol) {
  const spot = await fetchSpot(symbol);
  if (spot === null) return { symbol, results: [], alerts: [] };

  const expirations = getNextTwoMonthsExpirations();
  const results = [];
  const alerts = [];

  for (const expISO of expirations) {
    let options = await fetchOptionChain(symbol, expISO);
    if (!options.length) options = await fetchPolygonOptionChain(symbol, expISO);
    if (!options.length) continue;

    const T = Math.max((new Date(expISO) - new Date()) / (365 * 24 * 3600 * 1000), 0);

    for (const opt of options) {
      const sym = opt.instrument?.symbol || opt.symbol;
      const parsed = parseOptionSymbol(sym);
      if (!parsed) continue;

      const { type, strike: K } = parsed;
      const mid = opt.bid && opt.ask
        ? (parseFloat(opt.bid) + parseFloat(opt.ask)) / 2
        : parseFloat(opt.lastPrice || opt.last || 0);

      if (!mid || mid < MIN_OPTION_PRICE) continue;

      const sigma = parseFloat(opt.impliedVolatility || opt.iv || 0.25);
      const bs = bsPrice({ S: spot, K, T, r: RISK_FREE_RATE, sigma, type });
      if (bs < 0.01 || bs > 0.5) continue;

      const diffPct = (((mid - bs) / bs) * 100).toFixed(2);
      if (Math.abs(diffPct) < DIFF_THRESHOLD || mid > MAX_MARKET_PRICE) continue;

      const status = mid > bs ? 'Overpriced' : 'Underpriced';
      const record = {
        symbol,
        spotPrice: spot.toFixed(2),
        expiration: expISO,
        type,
        strike: K,
        marketPrice: mid.toFixed(2),
        bsPrice: bs.toFixed(2),
        diffPct,
        status
      };
      results.push(record);
      alerts.push(record);
    }
  }

  append(`\n=== ${symbol} (Spot: $${spot}) ===`);
  if (!results.length) append('No filtered options data.');
  else for (const r of results) append(JSON.stringify(r, null, 2));

  return { symbol, results, alerts };
}

// === MAIN ENTRY POINT ===
export async function runOptionAnalysis(stockSymbol = null) {
  fs.writeFileSync(LOG_FILE, '', 'utf8');

  const symbolsToProcess = stockSymbol ? [stockSymbol] : [...popularStocks, ...randomStocks];
  let allResults = [];
  let allAlerts = [];

  for (const sym of symbolsToProcess) {
    console.log(`\n📈 Processing ${sym}...`);
    try {
      const { results, alerts } = await analyzeSymbol(sym);
      allResults.push(...results);
      allAlerts.push(...alerts);
    } catch (err) {
      console.error(`Failed processing ${sym}:`, err.message);
      append(`\n=== ${sym} ===`);
      append('Error during analysis.');
    }
  }

  // Retry any cached failed calls
  await retryFailedCalls();

  fs.writeFileSync(RESULTS_JSON, JSON.stringify(allResults, null, 2), 'utf8');

  const csvHeader = 'symbol,spotPrice,expiration,type,strike,marketPrice,bsPrice,diffPct,status\n';
  const csvRows = allAlerts.map(r =>
    [r.symbol, r.spotPrice, r.expiration, r.type, r.strike, r.marketPrice, r.bsPrice, r.diffPct, r.status].join(',')
  );
  fs.writeFileSync(ALERTS_CSV, csvHeader + csvRows.join('\n'), 'utf8');

  console.log(`\n✅ Analysis complete. ${allResults.length} results, ${allAlerts.length} alerts.`);
  return { allResults, allAlerts };
}

// === CLI SUPPORT ===
if (process.argv[1].endsWith('optionchaintest.js')) {
  const symbolArg = process.argv[2];
  runOptionAnalysis(symbolArg).then(res => console.log(JSON.stringify(res.allAlerts, null, 2)));
}
