// ---- CONFIG ----
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const axios = require('axios');
const { parse: csvParse } = require('csv-parse/sync'); // updated import

// ------------------- USER CONFIG -------------------
const DELAY_MS = 200; // per-request delay

// Public API keys from .env
const SECRET_KEY_1 = process.env.PUBLIC_API_KEY;
const ACCOUNT_ID_1 = process.env.PUBLIC_API_ID;
const BASE_1 = process.env.PUBLIC_API_BASE || "https://api.public.com";

const SECRET_KEY_2 = process.env.PUBLIC_API_KEY_2;
const ACCOUNT_ID_2 = process.env.PUBLIC_API_ID_2;
const BASE_2 = process.env.PUBLIC_API_BASE_2 || "https://api.public.com";

// ------------------- PATHS -------------------
const backtesterLogPath = path.join(__dirname, '..', 'backtesters', 'log', 'results.json');
const optionableCsvPath = path.join(__dirname, '..', 'backtesters', 'optionable_stocks.csv');
const resultsPath = path.join(__dirname, 'log', 'results.json');
const alertsTxtPath = path.join(__dirname, '..', '..', 'Chart Monitor', 'stock_strat_test', 'alerts.txt');
const liveDataPath = path.join(__dirname, '..', '..', 'Chart Monitor', 'stock_strat_test', 'log', 'livedata.json');

// Ensure folders exist
for (const dir of [path.dirname(resultsPath), path.dirname(alertsTxtPath), path.dirname(liveDataPath)]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---- Initialize liveData file if missing ----
if (!fs.existsSync(liveDataPath)) {
  fs.writeFileSync(liveDataPath, JSON.stringify({}, null, 2), 'utf-8');
}

// ---- Load Backtester Results ----
let backtesterResults = [];
if (fs.existsSync(backtesterLogPath)) backtesterResults = JSON.parse(fs.readFileSync(backtesterLogPath, 'utf-8'));
else { console.error('Backtester results file missing!'); process.exit(1); }

// ---- Load Optionable Stocks ----
let optionableSymbols = [];
if (fs.existsSync(optionableCsvPath)) {
  const csvData = fs.readFileSync(optionableCsvPath, 'utf-8');
  const records = csvParse(csvData, { columns: true, skip_empty_lines: true });
  optionableSymbols = records.map(r => r.Symbol);
} else { console.error('Optionable stocks CSV missing!'); process.exit(1); }

// ---- Load Strategies ----
const strategyDir = path.join(__dirname, '..', 'backtesters', 'strategies');
const strategies = {};
for (const file of fs.readdirSync(strategyDir).filter(f => f.endsWith('.js'))) {
  strategies[path.basename(file, '.js')] = require(path.join(strategyDir, file));
}

// ---- Load Helper Functions ----
const { SMA, smaSlope, RSI, ATR, trendDirection, BollingerBands, ADX } = require(path.join(__dirname, '..', 'backtesters', 'helpers.js'));

// ---- Utility ----
const wait = ms => new Promise(res => setTimeout(res, ms));

// ---- PUBLIC API AUTH ----
async function getAccessToken(secretKey, base) {
  try {
    const res = await axios.post(
      `${base}/userapiauthservice/personal/access-tokens`,
      { validityInMinutes: 60, secret: secretKey },
      { headers: { "Content-Type": "application/json" } }
    );
    return res.data.accessToken;
  } catch (err) {
    console.error('Error fetching access token:', err.response ? err.response.data : err.message);
    return null;
  }
}

// ---- Append/Update liveData file ----
function logLiveData(symbolData) {
  let currentData = {};
  if (fs.existsSync(liveDataPath)) {
    try { currentData = JSON.parse(fs.readFileSync(liveDataPath, 'utf-8')); } 
    catch (e) { console.error('Failed to read livedata.json, resetting file.'); currentData = {}; }
  }
  for (const sym in symbolData) currentData[sym] = symbolData[sym];
  fs.writeFileSync(liveDataPath, JSON.stringify(currentData, null, 2), 'utf-8');
}

// ---- FETCH LIVE QUOTES ----
async function fetchLiveQuotes(symbols, token, accountId, base, label) {
  const liveData = {};
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    try {
      const res = await axios.post(
        `${base}/userapigateway/marketdata/${accountId}/quotes`,
        { instruments: [{ symbol, type: 'EQUITY' }] },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const quote = res.data?.[0]?.quote || res.data;
      liveData[symbol] = {
        symbol,
        lastPrice: quote.last ?? null,
        bid: quote.bid ?? null,
        ask: quote.ask ?? null,
        time: new Date().toISOString(),
      };

      // Save immediately after fetching
      logLiveData({ [symbol]: liveData[symbol] });
      console.log(`✅ ${symbol} live price retrieved and logged (${label})`);
    } catch (err) {
      console.log(`❌ ${symbol} error (${label}):`, err.response ? err.response.data : err.message);
    }
    await wait(DELAY_MS);
  }
  return liveData;
}

// ---- RUN TWO KEYS IN PARALLEL ----
async function getAllLiveData(symbols, tokens, accountIds, bases) {
  const half = Math.ceil(symbols.length / 2);
  const list1 = symbols.slice(0, half);
  const list2 = symbols.slice(half);

  const [data1, data2] = await Promise.all([
    fetchLiveQuotes(list1, tokens[0], accountIds[0], bases[0], "key 1"),
    fetchLiveQuotes(list2, tokens[1], accountIds[1], bases[1], "key 2"),
  ]);

  return { ...data1, ...data2 };
}

// ---- Risk Score Helper ----
function calculateRiskScore(atr, currentPrice) {
  let score = (atr / currentPrice) * 100 * 2;
  score = Math.min(100, Math.max(0, score));
  let level = '';
  if (score <= 25) level = 'Low';
  else if (score <= 50) level = 'Medium';
  else if (score <= 75) level = 'High';
  else level = 'Very High';
  return { score: score.toFixed(1), level };
}

// ---- Interpret Indicators ----
function interpretIndicators({ signal, rsi, adx, trend, atr, expectedMovePercent, stopLoss, takeProfit, currentPrice }) {
  let interpretation = '';
  if (signal === 'long') {
    interpretation += `Bullish momentum detected `;
    interpretation += adx > 25 ? `with strong trend (ADX ${adx.toFixed(1)}). ` : `trend strength moderate (ADX ${adx.toFixed(1)}). `;
  } else if (signal === 'short') {
    interpretation += `Bearish pressure detected `;
    interpretation += adx > 25 ? `with strong downward trend (ADX ${adx.toFixed(1)}). ` : `trend strength moderate (ADX ${adx.toFixed(1)}). `;
  }

  if (rsi > 70) interpretation += `RSI ${rsi.toFixed(1)} overbought. `;
  else if (rsi < 30) interpretation += `RSI ${rsi.toFixed(1)} oversold. `;
  else interpretation += `RSI ${rsi.toFixed(1)} neutral. `;

  interpretation += atr > currentPrice * 0.02 ? `ATR ${atr.toFixed(2)} elevated volatility. ` : `ATR ${atr.toFixed(2)} normal volatility. `;
  interpretation += `Expected movement ~${expectedMovePercent.toFixed(2)}%. `;

  const entries = signal === 'long' ? [currentPrice - atr * 0.5, currentPrice] : [currentPrice, currentPrice + atr * 0.5];
  const positions = ['Full', 'Half', 'Quarter'];
  interpretation += `Entries: `;
  entries.forEach((entry, i) => { interpretation += `${positions[i] || 'Scaled'} at $${entry.toFixed(2)}, `; });
  interpretation = interpretation.slice(0, -2) + '. ';

  const risk = calculateRiskScore(atr, currentPrice);
  interpretation += `Stop: $${stopLoss.toFixed(2)}, Take: $${takeProfit.toFixed(2)}. `;
  interpretation += `Risk: ${risk.level} (${risk.score}/100). `;

  return { text: interpretation.trim(), risk, signal };
}

// ---- MAIN MONITOR FUNCTION ----
async function monitorStocks() {
  console.log(`Fetching live market data via Public API...`);
  const token1 = await getAccessToken(SECRET_KEY_1, BASE_1);
  const token2 = await getAccessToken(SECRET_KEY_2, BASE_2);

  if (!token1 || !token2) {
    console.error("❌ Failed to get access tokens.");
    process.exit(1);
  }

  const allSymbols = backtesterResults.map(s => s.symbol).filter(sym => optionableSymbols.includes(sym));
  await getAllLiveData(allSymbols, [token1, token2], [ACCOUNT_ID_1, ACCOUNT_ID_2], [BASE_1, BASE_2]);

  console.log("✅ Live data fetch complete — all stocks logged in livedata.json");
}

monitorStocks();
