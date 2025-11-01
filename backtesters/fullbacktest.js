// fullbacktest.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const parquet = require('parquets');
const { exec } = require('child_process');
const { SMA, smaSlope, RSI, ATR, trendDirection, BollingerBands, ADX } = require('./helpers');

// ---------------- Results File Setup ----------------
let allResults = [];
const resultsPath = path.join(__dirname, 'log', 'results.json');
if (!fs.existsSync(path.dirname(resultsPath))) fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
if (fs.existsSync(resultsPath)) {
  try { allResults = JSON.parse(fs.readFileSync(resultsPath, 'utf-8')); } 
  catch { allResults = []; }
} else { fs.writeFileSync(resultsPath, JSON.stringify([], null, 2)); }

// ---------------- Create Set of Already Retested Symbols ----------------
const alreadyRetestedSymbols = new Set(
  allResults.filter(r => r.retested === "yes").map(r => r.symbol)
);

// ---------------- Delay Helper ----------------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------------- Fixed Delay / Concurrency ----------------
const dynamicDelay = 1200;
const concurrency = 2;
let retryQueue = [];

// ---------------- Fetch Historical Data from Parquet ----------------
async function fetchHistoricalDataFromParquet(symbol, timeframe) {
  try {
    const basePath = path.join(__dirname, '..', 'Historical', 'data');
    const tfMap = {
      '1day': '1day',
      '1week': '1week',
      '1hour': '1hour',
      '4hour': '4hour',
      '15Min': '15min',
    };
    const parquetPath = path.join(basePath, tfMap[timeframe], `${symbol}.parquet`);
    if (!fs.existsSync(parquetPath)) throw new Error(`Parquet not found: ${parquetPath}`);

    const reader = await parquet.ParquetReader.openFile(parquetPath);
    const cursor = reader.getCursor();
    const rows = [];
    let row = null;
    while (row = await cursor.next()) {
      rows.push({
        time: row.time,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume
      });
    }
    await reader.close();
    return rows;
  } catch (err) {
    console.error(`❌ Failed reading ${symbol} ${timeframe}: ${err.message}`);
    return [];
  }
}

// ---------------- Dynamic Risk Calculation ----------------
function dynamicRisk(entry, setup, atr) {
  const stopLoss = atr * 0.7;
  const takeProfit = atr * 1.1;
  return setup === 'long'
    ? { stop: entry - stopLoss, target: entry + takeProfit }
    : { stop: entry + stopLoss, target: entry - takeProfit };
}

// ---------------- Run Backtest for Single Strategy ----------------
async function runBacktestFromParquet(symbol, timeframe, strategyFunc) {
  try {
    const lower = await fetchHistoricalDataFromParquet(symbol, timeframe);
    const higherTimeframe = (timeframe === '15Min') ? '1hour' : '1day';
    const higher = await fetchHistoricalDataFromParquet(symbol, higherTimeframe);

    const prices = [], volumes = [], candles = [];
    let trades = 0, wins = 0, losses = 0, totalDuration = 0, totalRR = 0;
    let lastTradeIndex = -999;
    const COOLDOWN = 8;
    let balance = 100, investmentGone = false;

    for (let i = 25; i < lower.length; i++) {
      prices.push(lower[i].close);
      volumes.push(lower[i].volume);
      candles.push(lower[i]);

      const subPrices = prices.slice(-30);
      const subCandles = candles.slice(-30);
      const subVolumes = volumes.slice(-30);

      const tradeSignal = strategyFunc(subPrices, subCandles, subVolumes, higher, i, lastTradeIndex, COOLDOWN);

      if (tradeSignal && !investmentGone) {
        const entry = lower[i].close;
        const atrNow = ATR(subCandles);
        const { stop, target } = dynamicRisk(entry, tradeSignal.signal, atrNow);

        lastTradeIndex = i;
        trades++;

        const riskAmount = Math.max(balance * 0.15, 30);
        const stopDistance = Math.max(Math.abs(entry - stop), 0.0001);
        let positionSize = Math.min(riskAmount / stopDistance, balance / entry);

        balance -= positionSize * entry;

        let tradeProfitLoss = 0;
        let duration = 0;
        let tradeLow = entry, tradeHigh = entry, exitPrice = entry;

        for (let j = i + 1; j < Math.min(i + 12, lower.length); j++) {
          const price = lower[j].close;
          duration++;
          if (tradeSignal.signal === 'long') {
            tradeLow = Math.min(tradeLow, price);
            tradeProfitLoss = positionSize * (price - entry);
            exitPrice = price;
            if (price <= stop || tradeProfitLoss >= positionSize * atrNow * 0.35 || price >= target) break;
          } else {
            tradeHigh = Math.max(tradeHigh, price);
            tradeProfitLoss = positionSize * (entry - price);
            exitPrice = price;
            if (price >= stop || tradeProfitLoss >= positionSize * atrNow * 0.35 || price <= target) break;
          }
        }

        balance += positionSize * entry + tradeProfitLoss;
        totalDuration += duration;
        if (tradeProfitLoss >= 0) wins++;
        else losses++;
        if (balance <= 0) { balance = 0; investmentGone = true; }

        let riskPct, rewardPct, rr;
        if (tradeSignal.signal === 'long') {
          riskPct = Math.abs(entry - tradeLow) / entry;
          rewardPct = Math.abs(exitPrice - entry) / entry;
        } else {
          riskPct = Math.abs(tradeHigh - entry) / entry;
          rewardPct = Math.abs(entry - exitPrice) / entry;
        }
        rr = rewardPct / Math.max(riskPct, 0.0001);
        totalRR += rr;
      }
    }

    const avgDuration = trades ? (totalDuration / trades).toFixed(2) : 0;
    const winRate = trades ? (wins / trades) * 100 : 0;
    const avgRR = trades ? parseFloat((totalRR / trades).toFixed(2)) : 0;

    return {
      trades,
      wins,
      losses,
      winRate: parseFloat(winRate.toFixed(2)),
      avgDuration: parseFloat(avgDuration),
      avgRR
    };
  } catch (err) {
    console.error(`Error backtesting ${symbol} ${timeframe}: ${err.message}`);
    return { trades: 0, wins: 0, losses: 0, winRate: 0, avgDuration: 0, avgRR: 0 };
  }
}

// ---------------- Save Partial Results ----------------
function saveResult(symbol, result) {
  const idx = allResults.findIndex(r => r.symbol === symbol);
  const newEntry = {
    symbol,
    name: result.name || '',
    overallWinRate: result.overallWinRate || 0,
    timeframes: result.timeframes || {},
    replaced: "new",
    retested: "yes"
  };

  let replacedStatus = "new";
  if (idx >= 0) {
    const old = allResults[idx];
    if (!old.hasOwnProperty('retested') || old.retested === "no") old.retested = "yes";
    allResults[idx] = newEntry;
    replacedStatus = "yes";
  } else {
    allResults.push(newEntry);
  }

  fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
  return replacedStatus;
}

// ---------------- Update Optionable Stock List ----------------
function updateOptionableList(optionablePath) {
  return new Promise((resolve, reject) => {
    const updateNeeded = !fs.existsSync(optionablePath) ||
      ((Date.now() - fs.statSync(optionablePath).mtimeMs) / (1000 * 60 * 60) > 24);
    if (!updateNeeded) return resolve();

    console.log('Updating optionable stock list asynchronously...');
    exec(`node "${path.join(__dirname, 'update-optionable-list.js')}"`, (err, stdout, stderr) => {
      if (err) return reject(err);
      console.log(stdout);
      if (stderr) console.error(stderr);
      resolve();
    });
  });
}

// ---------------- Run Single Stock with Multiple Strategies ----------------
async function processStockConcurrent(stock, strategies) {
  const timeframes = ['15Min','1Hour','4Hour','1day','1week'];
  const timeframeResults = {};

  for (const tf of timeframes) {
    let bestForTF = { strategy: '', winRate: 0 };
    for (const [strategyName, strategyFunc] of Object.entries(strategies)) {
      const result = await runBacktestFromParquet(stock.symbol, tf, strategyFunc);
      if (result.winRate > bestForTF.winRate) {
        bestForTF = { ...result, strategy: strategyName };
      }
    }
    timeframeResults[tf] = bestForTF;
  }

  const allWinRates = Object.values(timeframeResults).map(r => r.winRate);
  const overallWinRate = allWinRates.reduce((a,b)=>a+b,0)/allWinRates.length;

  const output = {
    symbol: stock.symbol,
    name: stock.name,
    overallWinRate: parseFloat(overallWinRate.toFixed(2)),
    timeframes: timeframeResults
  };

  const replacedStatus = saveResult(stock.symbol, output);

  console.log(`📊 ${stock.symbol} | Overall Win Rate: ${output.overallWinRate}% | Replaced: ${replacedStatus}`);
  return output;
}

// ---------------- Concurrent Backtester ----------------
async function runConcurrentBacktests(tradableStocks, strategies) {
  tradableStocks = tradableStocks.filter(s => !alreadyRetestedSymbols.has(s.symbol));
  console.log(`Skipping ${alreadyRetestedSymbols.size} already-retested stocks`);
  console.log(`Stocks to run: ${tradableStocks.length}`);

  const totalStocks = tradableStocks.length + retryQueue.length;
  let processedCount = 0;
  const startTime = Date.now();

  while (tradableStocks.length > 0 || retryQueue.length > 0) {
    const active = [];
    const batch = [];
    while (batch.length < concurrency && (tradableStocks.length > 0 || retryQueue.length > 0)) {
      const stock = retryQueue.length ? retryQueue.shift() : tradableStocks.shift();
      batch.push(stock);
    }

    for (const stock of batch) {
      const task = processStockConcurrent(stock, strategies)
        .then(() => {
          processedCount++;
          const elapsed = (Date.now() - startTime) / 1000;
          const avgTime = elapsed / processedCount;
          const remaining = totalStocks - processedCount;
          const eta = (avgTime * remaining / 60).toFixed(1);
          console.log(`⏱ Progress: ${processedCount}/${totalStocks} | ETA: ~${eta} min`);
        })
        .catch((err) => {
          console.error(`❌ ${stock.symbol} failed: ${err.message}`);
        });
      active.push(task);
    }

    await Promise.all(active);
    await sleep(dynamicDelay);
  }

  allResults.sort((a, b) => b.overallWinRate - a.overallWinRate);
  fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
}

// ---------------- Main ----------------
(async () => {
  try {
    const strategyDir = path.join(__dirname, 'strategies');
    const strategies = {};
    for (const file of fs.readdirSync(strategyDir).filter((f) => f.endsWith('.js'))) {
      strategies[path.basename(file, '.js')] = require(path.join(strategyDir, file));
    }

    const optionablePath = path.join(__dirname, 'optionable_stocks.csv');
    await updateOptionableList(optionablePath);

    if (!fs.existsSync(optionablePath)) throw new Error('Optionable CSV missing.');

    // ---------------- CSV Parsing Fix ----------------
    const csvData = fs.readFileSync(optionablePath, 'utf-8').trim();
    const lines = csvData.split(/\r?\n/).filter(line => line);
    const optionableSymbols = lines.slice(); // copy of symbols
    const assets = lines.map(symbol => ({ symbol, name: symbol }));
    let tradableStocks = assets.filter(a => optionableSymbols.includes(a.symbol));

    // Ensure SPY is included
    const spyAsset = { symbol: 'SPY', name: 'SPY' };
    if (!tradableStocks.some(s => s.symbol === 'SPY')) tradableStocks.push(spyAsset);

    console.log(`Tradable optionable stocks count: ${tradableStocks.length}`);

    await runConcurrentBacktests(tradableStocks, strategies);

    console.log(`Backtesting complete! Total results: ${allResults.length}`);
  } catch (err) {
    console.error('Fatal error:', err);
  }
})();

