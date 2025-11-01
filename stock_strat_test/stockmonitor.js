require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const parquet = require("parquetjs-lite");
const { SMA, RSI, ATR, BollingerBands, ADX } = require(path.join(__dirname, "..", "backtesters", "helpers.js"));

const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const BASE_URL = "https://api.polygon.io";
const CONCURRENT_REQUESTS = 100;

const todayParquetDir = path.join(__dirname, "..", "..", "Chart Monitor", "Historical", "today_15min");
const liveDataPath = path.join(__dirname, "..", "..", "Chart Monitor", "stock_strat_test", "log", "livedata.json");
const resultsPath = path.join(__dirname, "..", "backtesters", "log", "results.json");

// Ensure necessary folders exist
for (const p of [todayParquetDir, path.dirname(liveDataPath)] ) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// Load backtester highest win-rate strategies
function loadHighestWinRateStrategies() {
  if (!fs.existsSync(resultsPath)) return {};
  const results = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
  const strategies = {};
  results.forEach(r => { strategies[r.symbol] = r.strategy; });
  return strategies;
}

// Fetch today’s 15-min candles
async function fetch15MinCandles(symbol) {
  const today = new Date().toISOString().split("T")[0];
  const url = `${BASE_URL}/v2/aggs/ticker/${symbol}/range/15/min/${today}/${today}?adjusted=true&sort=asc&apiKey=${POLYGON_API_KEY}`;
  const res = await axios.get(url);
  return res.data.results || [];
}

// Compute indicators for a candle array
function computeIndicators(candles) {
  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  return {
    sma20: SMA(closes, 20).pop(),
    rsi: RSI(closes, 14).pop(),
    atr: ATR(highs, lows, closes, 14).pop(),
    boll: BollingerBands(closes, 20).pop(),
    adx: ADX(highs, lows, closes, 14).pop(),
    latestPrice: closes[closes.length - 1]
  };
}

// Append new candles to parquet (one file per symbol)
async function appendToParquet(filepath, newCandles) {
  if (!newCandles.length) return;

  const schema = new parquet.ParquetSchema({
    ts: { type: "TIMESTAMP_MILLIS" },
    o: { type: "DOUBLE" },
    h: { type: "DOUBLE" },
    l: { type: "DOUBLE" },
    c: { type: "DOUBLE" },
    v: { type: "DOUBLE" },
    sma20: { type: "DOUBLE", optional: true },
    rsi14: { type: "DOUBLE", optional: true },
    atr14: { type: "DOUBLE", optional: true },
    bollingerUpper: { type: "DOUBLE", optional: true },
    bollingerLower: { type: "DOUBLE", optional: true }
  });

  let existingCandles = [];
  if (fs.existsSync(filepath)) {
    const reader = await parquet.ParquetReader.openFile(filepath);
    const cursor = reader.getCursor();
    let record = null;
    while ((record = await cursor.next())) existingCandles.push(record);
    await reader.close();
  }

  const existingTimestamps = new Set(existingCandles.map(c => new Date(c.ts).getTime()));
  const toAdd = newCandles.filter(c => !existingTimestamps.has(new Date(c.t).getTime()));
  if (!toAdd.length) return;

  const writer = await parquet.ParquetWriter.openFile(schema, filepath, { append: fs.existsSync(filepath) });
  for (const c of toAdd) {
    await writer.appendRow({
      ts: new Date(c.t),
      o: c.o,
      h: c.h,
      l: c.l,
      c: c.c,
      v: c.v,
      sma20: c.sma20 || null,
      rsi14: c.rsi14 || null,
      atr14: c.atr14 || null,
      bollingerUpper: c.bollingerUpper || null,
      bollingerLower: c.bollingerLower || null
    });
  }
  await writer.close();
}

// Main fetch + update
async function update15MinData(symbols) {
  const startTime = Date.now();
  const liveSnapshot = {};
  const highestStrategies = loadHighestWinRateStrategies();
  let totalUpdated = 0;

  for (let i = 0; i < symbols.length; i += CONCURRENT_REQUESTS) {
    const batch = symbols.slice(i, i + CONCURRENT_REQUESTS);

    await Promise.all(batch.map(async sym => {
      try {
        const filepath = path.join(todayParquetDir, `${sym}.parquet`);
        let existingCandles = [];
        if (fs.existsSync(filepath)) {
          const reader = await parquet.ParquetReader.openFile(filepath);
          const cursor = reader.getCursor();
          let record = null;
          while ((record = await cursor.next())) existingCandles.push(record);
          await reader.close();
        }

        const latestTime = existingCandles.length ? existingCandles[existingCandles.length - 1].ts.getTime() : null;
        const candles = await fetch15MinCandles(sym);
        if (!candles.length) throw new Error("No 15-min data");

        // Skip if latest candle already exists
        if (latestTime && new Date(candles[candles.length - 1].t).getTime() === latestTime) {
          liveSnapshot[sym] = {
            symbol: sym,
            ohlcv: existingCandles[existingCandles.length - 1],
            indicators: computeIndicators(existingCandles),
            strategy: highestStrategies[sym] || null
          };
          return;
        }

        // Compute indicators for 15-min candles
        const indicators = computeIndicators(candles);
        candles.forEach(c => {
          c.sma20 = indicators.sma20;
          c.rsi14 = indicators.rsi;
          c.atr14 = indicators.atr;
          c.bollingerUpper = indicators.boll.upper;
          c.bollingerLower = indicators.boll.lower;
        });

        // Append to parquet
        await appendToParquet(filepath, candles);

        liveSnapshot[sym] = {
          symbol: sym,
          ohlcv: candles[candles.length - 1],
          indicators,
          strategy: highestStrategies[sym] || null
        };
        totalUpdated++;
        console.log(`${i + 1}/${symbols.length} ✅ ${sym} — Price $${indicators.latestPrice}`);
      } catch (err) {
        console.log(`${i + 1}/${symbols.length} ❌ ${sym} (${err.message})`);
      }
    }));
  }

  // Save live snapshot for quick access
  fs.writeFileSync(liveDataPath, JSON.stringify(liveSnapshot, null, 2));

  const endTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n🚀 Fetch complete. ${totalUpdated} stocks updated. Total runtime: ${endTime}s`);
}

// ------------------- MAIN -------------------
(async () => {
  const optionablePath = path.join(__dirname, "..", "backtesters", "optionable_stocks.csv");
  if (!fs.existsSync(optionablePath)) {
    console.error(`❌ Missing ${optionablePath}`);
    process.exit(1);
  }
  const symbols = fs.readFileSync(optionablePath, "utf-8")
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  console.log(`📄 Loaded ${symbols.length} symbols`);
  await update15MinData(symbols);
})();
