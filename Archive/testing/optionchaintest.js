//tests popular and random stocks,
//saved for testing all stocks and returning info

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
const SECRET_KEY = process.env.PUBLIC_API_KEY;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const ACCOUNT_ID = process.env.PUBLIC_API_ID;
const PUBLIC_API_BASE = process.env.PUBLIC_API_BASE || 'https://api.public.com';
const FINNHUB_BASE = process.env.FINNHUB_BASE_URL || 'https://finnhub.io/api/v1';
const RISK_FREE_RATE = 0.035;

// === Checks ===
if (!SECRET_KEY) throw new Error('PUBLIC_API_KEY missing');
if (!FINNHUB_KEY) throw new Error('FINNHUB_API_KEY missing');
if (!ACCOUNT_ID) throw new Error('PUBLIC_API_ID missing');

// === Logging ===
const LOG_DIR = path.join(__dirname, 'log');
const LOG_FILE = path.join(LOG_DIR, 'optionchains.txt');
const RESULTS_JSON = path.join(LOG_DIR, 'results.json');
const ALERTS_CSV = path.join(LOG_DIR, 'alerts.csv');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const append = text => fs.appendFileSync(LOG_FILE, text + '\n', 'utf8');

// === Stocks to Analyze ===
const popularStocks = [
  'AAPL','MSFT','AMZN','GOOG','FB','TSLA','NVDA','BRK.B','JPM','JNJ',
  'V','PG','UNH','HD','MA','DIS','PYPL','NFLX','ADBE','CMCSA',
  'INTC','PFE','KO','T','PEP','CSCO','XOM','CVX','ABBV','ABT',
  'CRM','ACN','AVGO','COST','QCOM','NKE','WMT','TXN','MDT','NEE',
  'BMY','LIN','MCD','LOW','HON','PM','ORCL','UPS','IBM','CVS'
];

const randomStocks = [
  'SPY','DOCU','SQ','ROKU','SNAP','SPOT','CRWD','OKTA','TWLO','FUBO',
  'PLTR','ETSY','UBER','LYFT','COIN','AFRM','F','GM','RBLX','LCID',
  'NVAX','BIDU','TME','JD','PDD','NTES','BABA','XPEV','NIO','LI',
  'PLUG','BLNK','NKLA','FSLR','ENPH','SEDG','SPWR','RUN','TSM','ASML',
  'ORLY','REGN','VRTX','BIIB','GILD','AMAT','LRCX','MU','SWKS','ON'
];

const MIN_OPTION_PRICE = 0.01;
const DIFF_THRESHOLD = 10; // 10% difference
const MAX_MARKET_PRICE = 0.50;

// === Helper ===
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

// === Finnhub Spot ===
let lastFinnhubCall = 0;
const FINNHUB_CALL_INTERVAL = 1091;

async function fetchSpot(symbol) {
  try {
    const now = Date.now();
    const wait = FINNHUB_CALL_INTERVAL - (now - lastFinnhubCall);
    if (wait > 0) await sleep(wait);
    const res = await axios.get(`${FINNHUB_BASE}/quote`, { params: { symbol, token: FINNHUB_KEY } });
    lastFinnhubCall = Date.now();
    const spot = parseFloat(res.data.c);
    console.log(`${symbol} Spot Price: $${spot}`);
    return spot;
  } catch (err) {
    console.error(`Error fetching spot price for ${symbol}:`, err.message);
    append(`\n=== ${symbol} ===`);
    append('Failed to fetch spot price.');
    return null;
  }
}

// === Public.com Access Token ===
async function getAccessToken() {
  const res = await axios.post(
    `${PUBLIC_API_BASE}/userapiauthservice/personal/access-tokens`,
    { validityInMinutes: 120, secret: SECRET_KEY, scopes: ['marketdata'] },
    { headers: { 'Content-Type': 'application/json' } }
  );
  console.log('✅ Access Token retrieved');
  return res.data.accessToken;
}

async function getAccountInfo(token) {
  const res = await axios.get(`${PUBLIC_API_BASE}/userapigateway/trading/account`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  console.log('Account Info:', JSON.stringify(res.data, null, 2));
  return res.data;
}

// === Fetch Option Chain via POST ===
async function fetchOptionChain(symbol, expirationDate, token) {
  const url = `${PUBLIC_API_BASE}/userapigateway/marketdata/${ACCOUNT_ID}/option-chain`;
  try {
    const body = { instrument: { symbol: symbol.toUpperCase(), type: 'EQUITY' }, expirationDate };
    const res = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });

    const calls = res.data.calls || [];
    const puts = res.data.puts || [];
    return [...calls, ...puts];
  } catch (err) {
    console.error(`Error fetching option chain for ${symbol}:`, err.response?.data || err.message);
    append(`\n=== ${symbol} ===`);
    append('Failed to fetch option chain.');
    return [];
  }
}

// === Analyzer with Filters ===
async function analyzeSymbol(symbol, token) {
  const spot = await fetchSpot(symbol);
  if (spot === null) return { symbol, results: [], alerts: [] };

  const now = new Date();
  const nextFriday = new Date(now);
  nextFriday.setDate(now.getDate() + ((12 - now.getDay()) % 7 || 7));
  const expISO = nextFriday.toISOString().split('T')[0];

  const options = await fetchOptionChain(symbol, expISO, token);
  const results = [];
  const alerts = [];

  if (!options || options.length === 0) {
    append(`\n=== ${symbol} (Spot: $${spot}) ===`);
    append('No processed options data.');
    console.log(`No data for ${symbol}.`);
    return { symbol, results, alerts };
  }

  const T = Math.max((new Date(expISO) - now) / (365 * 24 * 3600 * 1000), 0);

  for (const opt of options) {
    const sym = opt.instrument?.symbol || opt.symbol;
    const parsed = parseOptionSymbol(sym);
    if (!parsed) continue;

    const { type, strike: K } = parsed;
    const mid =
      opt.bid && opt.ask
        ? (parseFloat(opt.bid) + parseFloat(opt.ask)) / 2
        : parseFloat(opt.lastPrice || opt.last || 0);

    if (!mid || mid < MIN_OPTION_PRICE) continue;

    const sigma = parseFloat(opt.impliedVolatility || opt.iv || 0.25);
    const bs = bsPrice({ S: spot, K, T, r: RISK_FREE_RATE, sigma, type });
    if (bs < 0.01) continue;

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

  append(`\n=== ${symbol} (Spot: $${spot}) ===`);
  if (results.length === 0) append('No filtered options data.');
  else for (const r of results) append(JSON.stringify(r, null, 2));

  console.log(`Processed ${symbol}: ${results.length} filtered options.`);
  return { symbol, results, alerts };
}

// === MAIN ===
(async () => {
  fs.writeFileSync(LOG_FILE, '', 'utf8');
  const token = await getAccessToken();
  await getAccountInfo(token);

  const allSymbols = [...popularStocks, ...randomStocks];
  let allResults = [];
  let allAlerts = [];

  for (const sym of allSymbols) {
    console.log(`\n📈 Processing ${sym}...`);
    try {
      const { results, alerts } = await analyzeSymbol(sym, token);
      allResults.push(...results);
      allAlerts.push(...alerts);
    } catch (err) {
      console.error(`Failed processing ${sym}:`, err.message);
      append(`\n=== ${sym} ===`);
      append('Error during analysis.');
    }
  }

  // Save results.json
  fs.writeFileSync(RESULTS_JSON, JSON.stringify(allResults, null, 2), 'utf8');

  // Save alerts.csv
  const csvHeader = 'symbol,spotPrice,expiration,type,strike,marketPrice,bsPrice,diffPct,status\n';
  const csvRows = allAlerts.map(r =>
    [r.symbol, r.spotPrice, r.expiration, r.type, r.strike, r.marketPrice, r.bsPrice, r.diffPct, r.status].join(',')
  );
  fs.writeFileSync(ALERTS_CSV, csvHeader + csvRows.join('\n'), 'utf8');

  console.log(`\n✅ Analysis complete.`);
  console.log(`Filtered JSON saved to ${RESULTS_JSON}`);
  console.log(`CSV alerts saved to ${ALERTS_CSV}`);
})();

