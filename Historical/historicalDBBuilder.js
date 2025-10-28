// Chart Monitor/Historical/historicalDBBuilder.js

const axios = require("axios");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

// === CONFIGURATION ===
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;

// === FILE PATHS ===
const DB_PATH = path.join(__dirname, "6monthDB.json");

// === TEST SYMBOLS (50 popular tickers) ===
const testTickers = [
  "AAPL","MSFT","AMZN","GOOG","META","TSLA","NVDA","AMD","NFLX","INTC",
  "BABA","PYPL","CSCO","PEP","KO","WMT","DIS","NKE","XOM","CVX",
  "JPM","BAC","GS","V","MA","UNH","PFE","MRNA","ABNB","UBER",
  "SQ","SHOP","ADBE","CRM","ORCL","T","VZ","QCOM","MCD","COST",
  "TGT","SBUX","BA","GE","CAT","DE","HON","MMM","AMAT","INTU"
];

// === TIMEFRAMES ===
const timeframes = [
  { name: "15m", multiplier: 15, timespan: "minute" },
  { name: "1h", multiplier: 1, timespan: "hour" },
  { name: "4h", multiplier: 4, timespan: "hour" },
  { name: "1d", multiplier: 1, timespan: "day" }
];

// === CREATE 6monthDB.json IF NOT EXISTS ===
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, JSON.stringify({}, null, 2), "utf-8");
}

// === HELPER FUNCTIONS ===
function getDateRange() {
  const end = new Date();
  const start = new Date();
  start.setMonth(end.getMonth() - 6); // last 6 months
  return {
    start: start.toISOString().split("T")[0],
    end: end.toISOString().split("T")[0]
  };
}

async function fetchCandles(symbol, multiplier, timespan, start, end) {
  const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${start}/${end}?adjusted=true&sort=asc&apiKey=${POLYGON_API_KEY}`;
  try {
    const response = await axios.get(url);
    const data = response.data.results || [];
    return data.map(bar => ({
      symbol,                   // Added symbol
      timeframe: `${multiplier}${timespan}`, // Added timeframe
      t: bar.t,
      o: bar.o,
      h: bar.h,
      l: bar.l,
      c: bar.c,
      v: bar.v,
      dateUTC: new Date(bar.t).toUTCString(),
      dateLocal: new Date(bar.t).toLocaleString()
    }));
  } catch (err) {
    if (err.response?.status === 429) {
      const elapsed = ((Date.now() - globalStartTime) / 1000).toFixed(2);
      console.error(`❌ 429 Rate Limit hit for ${symbol} (${multiplier}${timespan}) after ${elapsed} seconds`);
      process.exit(1); // stop execution immediately
    } else {
      console.error(`❌ ${symbol} (${multiplier}${timespan}) - ${err.message}`);
    }
    return [];
  }
}

function saveData(symbol, timeframe, candles) {
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  if (!db[symbol]) db[symbol] = {};
  db[symbol][timeframe] = candles;
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

// === MAIN EXECUTION ===
let globalStartTime;

async function run() {
  globalStartTime = Date.now();
  const { start, end } = getDateRange();
  console.log(`🚀 Fetching 6-month history (${start} → ${end}) for ${testTickers.length} symbols...\n`);

  // Calculate delay for 5 requests per minute
  const delayMs = 12_000; // 12 seconds per request

  for (const symbol of testTickers) {
    console.log(`📈 Processing ${symbol}...`);
    for (const tf of timeframes) {
      const candles = await fetchCandles(symbol, tf.multiplier, tf.timespan, start, end);
      if (candles.length > 0) {
        saveData(symbol, tf.name, candles);
        console.log(`✅ ${symbol} (${tf.name}) — ${candles.length} bars`);
      } else {
        console.log(`⚠️ No data for ${symbol} (${tf.name})`);
      }

      // --- Enforce 5 calls per minute ---
      await new Promise(r => setTimeout(r, delayMs));
    }
    console.log(`--- Finished ${symbol} ---\n`);
  }

  console.log("🎯 All done! Data stored in 6monthDB.json");
}

run().catch(console.error);




