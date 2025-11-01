require("dotenv").config();
const fs = require("fs");
const path = require("path");
const parquet = require("parquetjs-lite");

// ---- Paths ----
const HISTORICAL_BASE = path.join(__dirname, "..", "..", "Chart Monitor", "Historical", "data");
const TODAY_PARQUET = path.join(HISTORICAL_BASE, "today_15min");
const RESULTS_PATH = path.join(__dirname, "..", "backtesters", "log", "results.json");
const ALERTS_PATH = path.join(__dirname, "..", "..", "Chart Monitor", "stock_strat_test", "log", "alerts.json");

// ---- Utility to load parquet data ----
async function loadParquetFile(filepath) {
  if (!fs.existsSync(filepath)) return [];
  const reader = await parquet.ParquetReader.openFile(filepath);
  const cursor = reader.getCursor();
  const records = [];
  let record = null;
  while ((record = await cursor.next())) records.push(record);
  await reader.close();
  return records;
}

// ---- Load historical and today data for a stock ----
async function loadStockData(symbol) {
  const timeframes = ["15min", "1hour", "4hour", "1day", "1week"];
  const data = {};

  for (const tf of timeframes) {
    const histPath = path.join(HISTORICAL_BASE, tf, `${symbol}.parquet`);
    const todayPath = tf === "15min" ? path.join(TODAY_PARQUET, `${symbol}.parquet`) : null;
    const histData = await loadParquetFile(histPath);
    const todayData = todayPath && fs.existsSync(todayPath) ? await loadParquetFile(todayPath) : [];
    data[tf] = histData.concat(todayData).sort((a, b) => a.ts - b.ts);
  }
  return data;
}

// ---- Load highest win-rate strategies ----
function loadStrategies() {
  if (!fs.existsSync(RESULTS_PATH)) return {};
  const results = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf-8"));
  const strategies = {};
  results.forEach(r => { strategies[r.symbol] = r.strategy; });
  return strategies;
}

// ---- Compute trend direction based on SMA slope ----
function getTrend(candles) {
  if (!candles.length) return "neutral";
  const n = Math.min(5, candles.length);
  const first = candles[candles.length - n].c;
  const last = candles[candles.length - 1].c;
  if (last > first) return "up";
  if (last < first) return "down";
  return "neutral";
}

// ---- Compute expected move % using multiple ATR timeframes ----
function computeExpectedMoveMultiTF(stockData, days = 5) {
  const timeframes = ["15min", "1hour", "4hour", "1day", "1week"];
  const moves = [];

  for (const tf of timeframes) {
    const candles = stockData[tf];
    if (!candles || !candles.length) continue;
    const lastATR = candles[candles.length - 1].atr14;
    if (!lastATR) continue;

    let multiplier = 1;
    switch (tf) {
      case "15min": multiplier = Math.sqrt(days * 26); break;
      case "1hour": multiplier = Math.sqrt(days * 6.5); break;
      case "4hour": multiplier = Math.sqrt(days * 1.625); break;
      case "1day": multiplier = Math.sqrt(days); break;
      case "1week": multiplier = 1; break;
    }

    const movePct = (lastATR * multiplier / candles[candles.length - 1].c) * 100;
    moves.push(movePct);
  }

  if (!moves.length) return null;
  return moves.reduce((a, b) => a + b, 0) / moves.length;
}

// ---- Evaluate strategy and generate alert ----
function evaluateStrategy(stockData, strategy) {
  if (!strategy) return null;

  const latest15 = stockData["15min"].slice(-1)[0];
  if (!latest15) return null;

  const entry = latest15.c;
  const trendInfo = {};
  for (const tf of Object.keys(stockData)) {
    trendInfo[tf] = {
      trend: getTrend(stockData[tf]),
      rsi: stockData[tf].slice(-1)[0]?.rsi14 || null
    };
  }

  // Determine importance & risk
  const trends = Object.values(trendInfo).map(t => t.trend);
  const upCount = trends.filter(t => t === "up").length;
  const downCount = trends.filter(t => t === "down").length;
  let importance = "Low";
  let risk = "Medium";
  let signal = null;

  if (upCount >= 4) {
    signal = "LONG"; importance = "High"; risk = "Low";
  } else if (downCount >= 4) {
    signal = "SHORT"; importance = "High"; risk = "Low";
  } else if (upCount >= 2) {
    signal = "LONG"; importance = "Medium"; risk = "Medium";
  } else if (downCount >= 2) {
    signal = "SHORT"; importance = "Medium"; risk = "Medium";
  } else {
    return null;
  }

  // Expected % move using multi-timeframe ATR
  const expectedMovePercent = computeExpectedMoveMultiTF(stockData, 5);

  // ---- Adaptive SL/TP based on volatility & importance ----
  const importanceMultiplier = { High: 1.0, Medium: 0.75, Low: 0.5 };
  const slVolFactor = 0.5; // fraction of expected move for SL
  const tpVolFactor = 1.0; // fraction of expected move for TP

  // Compute recent volatility (ATR / close)
  const lastATR = latest15.atr14 || (latest15.c * 0.02); // fallback 2%
  const volatilityFactor = lastATR / latest15.c;

  let stopLoss, takeProfit;
  if (expectedMovePercent) {
    if (signal === "LONG") {
      stopLoss = entry - entry * expectedMovePercent / 100 * slVolFactor * importanceMultiplier[importance] * (1 + volatilityFactor);
      takeProfit = entry + entry * expectedMovePercent / 100 * tpVolFactor * importanceMultiplier[importance] * (1 + volatilityFactor);
    } else {
      stopLoss = entry + entry * expectedMovePercent / 100 * slVolFactor * importanceMultiplier[importance] * (1 + volatilityFactor);
      takeProfit = entry - entry * expectedMovePercent / 100 * tpVolFactor * importanceMultiplier[importance] * (1 + volatilityFactor);
    }
  } else {
    // fallback to fixed 2% SL / 5% TP
    stopLoss = signal === "LONG" ? entry * 0.98 : entry * 1.02;
    takeProfit = signal === "LONG" ? entry * 1.05 : entry * 0.95;
  }

  return {
    symbol: latest15.symbol || "UNKNOWN",
    signal,
    importance,
    riskLevel: risk,
    entry,
    stopLoss: stopLoss.toFixed(2),
    takeProfit: takeProfit.toFixed(2),
    expectedDuration: "3-5 days",
    expectedMovePercent: expectedMovePercent ? expectedMovePercent.toFixed(2) : null,
    trendInfo,
    timestamp: new Date().toISOString()
  };
}

// ---- Main runner ----
async function runStratTest(symbols) {
  const strategies = loadStrategies();
  const allAlerts = [];

  for (const symbol of symbols) {
    const stockData = await loadStockData(symbol);
    const strategy = strategies[symbol] || null;
    const alert = evaluateStrategy(stockData, strategy);
    if (alert) allAlerts.push(alert);
  }

  // Save alerts to JSON
  let existing = [];
  if (fs.existsSync(ALERTS_PATH)) {
    existing = JSON.parse(fs.readFileSync(ALERTS_PATH, "utf-8"));
  }
  fs.writeFileSync(ALERTS_PATH, JSON.stringify(existing.concat(allAlerts), null, 2));

  console.log(`✅ Strat test complete. ${allAlerts.length} alerts generated.`);
  return allAlerts;
}

// ---- Example usage ----
(async () => {
  const optionablePath = path.join(__dirname, "..", "backtesters", "optionable_stocks.csv");
  const symbols = fs.existsSync(optionablePath)
    ? fs.readFileSync(optionablePath, "utf-8").split(/\r?\n/).map(l => l.trim()).filter(l => l.length)
    : [];
  if (!symbols.length) {
    console.error("❌ No symbols found.");
    return;
  }
  await runStratTest(symbols);
})();
