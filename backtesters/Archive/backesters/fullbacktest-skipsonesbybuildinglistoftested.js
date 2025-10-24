// fullbacktest.js
require('dotenv').config();
const Alpaca = require('@alpacahq/alpaca-trade-api');
const fs = require('fs');
const path = require('path');
const { parse: csvParse } = require('csv-parse/sync');
const { exec } = require('child_process');
const { SMA, smaSlope, RSI, ATR, trendDirection, BollingerBands, ADX } = require('./helpers');

// ---------------- Alpaca API Setup ----------------
const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: true,
  baseUrl: process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets',
});

// ---------------- Results File Setup ----------------
let allResults = [];
const resultsPath = path.join(__dirname, 'log', 'results.json');
if (!fs.existsSync(path.dirname(resultsPath))) fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
if (fs.existsSync(resultsPath)) {
  try { allResults = JSON.parse(fs.readFileSync(resultsPath, 'utf-8')); } 
  catch { allResults = []; }
} else { fs.writeFileSync(resultsPath, JSON.stringify([], null, 2)); }

// ---------------- Create Set of Completed Symbols ----------------
const completedSymbols = new Set(allResults.map(r => r.symbol)); // ✅ Added: fast lookup for skipping stocks

// ---------------- Delay Helper ----------------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------------- Fixed Delay / Concurrency ----------------
const dynamicDelay = 1200;
const concurrency = 2;
let retryQueue = [];
let globalPause = false;

// ---------------- Global Throttle Pause ----------------
async function globalThrottlePause(reason = '') {
  if (globalPause) return;
  globalPause = true;
  console.log(`🛑 Global pause triggered (${reason}) — waiting 25 seconds...`);
  await sleep(25000);
  console.log(`Resuming...`);
  globalPause = false;
}

// ---------------- Fetch Historical Data ----------------
async function fetchHistoricalData(symbol, timeframe, start, end, retries = 5) {
  for (let attempt = 0; attempt < retries; attempt++) {
    if (globalPause) await sleep(dynamicDelay);
    await sleep(dynamicDelay);
    try {
      const resp = await alpaca.getBarsV2(
        symbol,
        { start: new Date(start).toISOString(), end: new Date(end).toISOString(), timeframe },
        alpaca.configuration
      );
      const bars = [];
      for await (let bar of resp) {
        bars.push({
          time: bar.Timestamp,
          open: bar.OpenPrice,
          high: bar.HighPrice,
          low: bar.LowPrice,
          close: bar.ClosePrice,
          volume: bar.Volume,
        });
      }
      return bars;
    } catch (err) {
      if (err.code === 429) { await globalThrottlePause(`${symbol} ${timeframe}`); continue; }
      if (attempt === retries - 1) throw err;
      await sleep(dynamicDelay * 2);
    }
  }
  throw new Error(`Failed fetching ${symbol} after ${retries} retries`);
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
async function runBacktest(symbol, timeframe, start, end, strategyFunc) {
  try {
    const lower = await fetchHistoricalData(symbol, timeframe === '15Min' ? '15Min' : '1Hour', start, end);
    const higher = await fetchHistoricalData(symbol, timeframe === '15Min' ? '1Hour' : '1Day', start, end);

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
    if (err.code === 429) throw err;
    console.error(`Error backtesting ${symbol}: ${err.message}`);
    return { trades: 0, wins: 0, losses: 0, winRate: 0, avgDuration: 0, avgRR: 0 };
  }
}

// ---------------- Save Partial Results ----------------
function saveResult(symbol, result) {
  const idx = allResults.findIndex(r => r.symbol === symbol);
  const newEntry = {
    symbol: symbol,
    name: result.name || '',
    strategy: result.strategy || '',
    winRate: result.winRate || 0,
    trades: result.trades || 0,
    wins: result.wins || 0,
    losses: result.losses || 0,
    avgDuration: result.avgDuration || 0,
    avgRR: result.avgRR || 0
  };

  if (idx >= 0) allResults[idx] = newEntry;
  else allResults.push(newEntry);

  completedSymbols.add(symbol); // ✅ Added: keep Set updated for runtime
  fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
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
async function processStockConcurrent(stock, strategies, start, end) {
  // ✅ Skip stock if already exists in results.json
  if (completedSymbols.has(stock.symbol)) {
    console.log(`⏭️ Skipping ${stock.symbol} (already in results.json)`);
    return;
  }

  let best = {
    symbol: stock.symbol,
    name: stock.name,
    strategy: '',
    winRate: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    avgDuration: 0,
    avgRR: 0
  };

  for (const [strategyName, strategyFunc] of Object.entries(strategies)) {
    const result15 = await runBacktest(stock.symbol, '15Min', start, end, strategyFunc);
    const result1h = await runBacktest(stock.symbol, '1Hour', start, end, strategyFunc);
    const avgWinRate = (result15.winRate + result1h.winRate) / 2;

    if (avgWinRate > best.winRate) {
      best = {
        symbol: stock.symbol,
        name: stock.name,
        strategy: strategyName,
        winRate: parseFloat(avgWinRate.toFixed(2)),
        trades: result15.trades + result1h.trades,
        wins: result15.wins + result1h.wins,
        losses: result15.losses + result1h.losses,
        avgDuration: ((result15.avgDuration + result1h.avgDuration) / 2).toFixed(2),
        avgRR: ((result15.avgRR + result1h.avgRR) / 2).toFixed(2)
      };
    }
  }

  console.log(`📊 ${best.symbol} | Strategy: ${best.strategy} | Win Rate: ${best.winRate}% | Trades: ${best.trades} | Wins: ${best.wins}`);
  saveResult(stock.symbol, best);
  return best;
}

// ---------------- Concurrent Backtester (Fixed Settings) ----------------
async function runConcurrentBacktests(tradableStocks, strategies, start, end) {
  const rerunQueue = [];

  while (tradableStocks.length > 0 || retryQueue.length > 0) {
    const active = [];
    const batch = [];

    while (batch.length < concurrency && (tradableStocks.length > 0 || retryQueue.length > 0)) {
      const stock = retryQueue.length ? retryQueue.shift() : tradableStocks.shift();
      batch.push(stock);
    }

    for (const stock of batch) {
      const task = processStockConcurrent(stock, strategies, start, end)
        .then((result) => {
          if (result && result.winRate === 0 && !result.rerunOnce) {
            rerunQueue.push({ ...stock, rerunOnce: true });
          }
        })
        .catch((err) => {
          if (err.code === 429) retryQueue.push(stock);
          else console.error(`❌ ${stock.symbol} failed: ${err.message}`);
        });
      active.push(task);
    }

    await Promise.all(active);
    await sleep(dynamicDelay);
  }

  if (rerunQueue.length > 0) {
    console.log(`Rerunning ${rerunQueue.length} 0% stocks for 1-year timeframe...`);
    const safeDelay = 200;
    for (const stock of rerunQueue) {
      await sleep(safeDelay);
      const oneYearStart = '2024-10-10';
      const oneYearEnd = end;

      let best = {
        symbol: stock.symbol,
        name: stock.name,
        strategy: '',
        winRate: 0,
        trades: 0,
        wins: 0,
        losses: 0,
        avgDuration: 0,
        avgRR: 0
      };

      for (const [strategyName, strategyFunc] of Object.entries(strategies)) {
        const result15 = await runBacktest(stock.symbol, '15Min', oneYearStart, oneYearEnd, strategyFunc);
        const result1h = await runBacktest(stock.symbol, '1Hour', oneYearStart, oneYearEnd, strategyFunc);
        const avgWinRate = (result15.winRate + result1h.winRate) / 2;

        if (avgWinRate > best.winRate) {
          best = {
            symbol: stock.symbol,
            name: stock.name,
            strategy: strategyName,
            winRate: parseFloat(avgWinRate.toFixed(2)),
            trades: result15.trades + result1h.trades,
            wins: result15.wins + result1h.wins,
            losses: result15.losses + result1h.losses,
            avgDuration: ((result15.avgDuration + result1h.avgDuration) / 2).toFixed(2),
            avgRR: ((result15.avgRR + result1h.avgRR) / 2).toFixed(2)
          };
        }
      }

      console.log(`1-Year Rerun ${best.symbol} | Strategy: ${best.strategy} | Win Rate: ${best.winRate}% | Trades: ${best.trades} | Wins: ${best.wins}`);
      saveResult(stock.symbol, best);
    }
  }

  allResults.sort((a, b) => b.winRate - a.winRate);
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
    const csvData = fs.readFileSync(optionablePath, 'utf-8').trim();
    const records = csvParse(csvData, { columns: true, skip_empty_lines: true });
    const optionableSymbols = records.map((r) => r.Symbol);

    const assets = await alpaca.getAssets({ status: 'active' });
    let tradableStocks = assets.filter(
      (a) => a.tradable && ['NASDAQ', 'NYSE', 'AMEX'].includes(a.exchange) && optionableSymbols.includes(a.symbol)
    );

    // ✅ Filter out already-completed stocks before starting
    tradableStocks = tradableStocks.filter(a => !completedSymbols.has(a.symbol));

    const spyAsset = assets.find(a => a.symbol === 'SPY');
    if (spyAsset && !tradableStocks.some(s => s.symbol === 'SPY')) {
      tradableStocks.push(spyAsset);
      console.log('SPY added to tradableStocks');
    }

    console.log(`Tradable optionable stocks count: ${tradableStocks.length}`);

    const start = '2025-04-10';
    const end = '2025-10-09';
    await runConcurrentBacktests(tradableStocks, strategies, start, end);

    console.log(`Backtesting complete! Total results: ${allResults.length}`);
  } catch (err) {
    console.error('Fatal error:', err);
  }
})();

