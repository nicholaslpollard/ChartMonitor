// fullbacktest.js
require('dotenv').config();
const Alpaca = require('@alpacahq/alpaca-trade-api');
const fs = require('fs');
const path = require('path');

// Alpaca setup
const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: true,
  baseUrl: process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets',
});

// Ensure results.json exists
const resultsPath = path.join(__dirname, 'results.json');
let allResults = [];
if (fs.existsSync(resultsPath)) {
  try { allResults = JSON.parse(fs.readFileSync(resultsPath, 'utf-8')); } catch { allResults = []; }
} else {
  fs.writeFileSync(resultsPath, JSON.stringify([], null, 2));
}

// ---------------- Helper Functions ----------------
function SMA(arr, period) { if (!arr || arr.length < period) return null; return arr.slice(-period).reduce((a, b) => a + b, 0) / period; }
function smaSlope(arr, period = 3) { if (!arr || arr.length < period + 1) return null; let slope = 0; for (let i = arr.length - period; i < arr.length; i++) slope += arr[i] - arr[i - 1]; return slope; }
function RSI(prices, period = 14) { if (!prices || prices.length < period + 1) return null; let gains = 0, losses = 0; for (let i = prices.length - period; i < prices.length; i++) { const diff = prices[i] - prices[i - 1]; if (diff > 0) gains += diff; else losses -= diff; } if (losses === 0) return 100; return 100 - 100 / (1 + gains / losses); }
function ATR(candles, period = 14) { if (!candles || candles.length < period + 1) return null; const trs = []; for (let i = candles.length - period; i < candles.length; i++) { const curr = candles[i], prev = candles[i - 1]; trs.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close))); } return trs.reduce((a, b) => a + b, 0) / trs.length; }
function trendDirection(candles) { if (!candles || candles.length < 21) return null; const closes = candles.map(c => c.close); const sma9 = SMA(closes, 9); const sma21 = SMA(closes, 21); if (sma9 === null || sma21 === null) return null; return sma9 > sma21 ? 'up' : 'down'; }
function BollingerBands(prices, period = 20, mult = 2) { if (!prices || prices.length < period) return null; const sma = SMA(prices, period); const variance = prices.slice(-period).reduce((sum, p) => sum + Math.pow(p - sma, 2), 0) / period; const stdDev = Math.sqrt(variance); return { upper: sma + mult * stdDev, lower: sma - mult * stdDev }; }
function ADX(candles, period = 14) { if (!candles || candles.length < period + 1) return null; const trList = [], plusDM = [], minusDM = []; for (let i = 1; i < candles.length; i++) { const curr = candles[i], prev = candles[i - 1]; const highDiff = curr.high - prev.high; const lowDiff = prev.low - curr.low; plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0); minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0); trList.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close))); } const smTR = SMA(trList, period); const smPlus = SMA(plusDM, period); const smMinus = SMA(minusDM, period); const plusDI = (smPlus / smTR) * 100; const minusDI = (smMinus / smTR) * 100; return (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100; }

// ---------------- Fetch Data with Retry & Delay ----------------
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchHistoricalData(symbol, timeframe, start, end, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await alpaca.getBarsV2(
        symbol,
        { start: new Date(start).toISOString(), end: new Date(end).toISOString(), timeframe },
        alpaca.configuration
      );
      const bars = [];
      for await (let bar of resp) bars.push({ time: bar.Timestamp, open: bar.OpenPrice, high: bar.HighPrice, low: bar.LowPrice, close: bar.ClosePrice, volume: bar.Volume });
      return bars;
    } catch (err) {
      if (err.code === 429) { console.log(`429 for ${symbol}, retry in ${2000*(i+1)}ms`); await delay(2000*(i+1)); } else throw err;
    }
  }
  throw new Error(`Failed fetching data for ${symbol} after ${retries} retries`);
}

// ---------------- Dynamic Risk ----------------
function dynamicRisk(entry, setup, atr) {
  const stopLoss = atr * 0.7, takeProfit = atr * 1.1;
  return setup === 'long' ? { stop: entry - stopLoss, target: entry + takeProfit } : { stop: entry + stopLoss, target: entry - takeProfit };
}

// ---------------- Run Backtest with Any Strategy ----------------
async function runBacktest(symbol, timeframe, start, end, strategyFunc) {
  try {
    const lower = await fetchHistoricalData(symbol, timeframe === '15Min' ? '5Min' : '4Hour', start, end);
    const higher = await fetchHistoricalData(symbol, timeframe === '15Min' ? '1Hour' : '1Day', start, end);

    const prices = [], volumes = [], candles = [];
    let trades = 0, wins = 0, lastTradeIndex = -999;
    const COOLDOWN = 8;
    let balance = 100, investmentGone = false;

    for (let i = 25; i < lower.length; i++) {
      prices.push(lower[i].close); volumes.push(lower[i].volume); candles.push(lower[i]);
      const subPrices = prices.slice(-30), subCandles = candles.slice(-30), subVolumes = volumes.slice(-30);

      const tradeSignal = strategyFunc(subPrices, subCandles, subVolumes, higher, i, lastTradeIndex, COOLDOWN);

      if (tradeSignal && !investmentGone) {
        const entry = lower[i].close, atrNow = ATR(subCandles);
        const { stop, target } = dynamicRisk(entry, tradeSignal.signal, atrNow);
        lastTradeIndex = i; trades++;
        const riskAmount = Math.max(balance * 0.15, 30);
        const stopDistance = Math.max(Math.abs(entry - stop), 0.0001);
        let positionSize = Math.min(riskAmount / stopDistance, balance / entry);
        balance -= positionSize * entry;

        let tradeProfitLoss = 0;
        for (let j = i + 1; j < Math.min(i + 12, lower.length); j++) {
          const price = lower[j].close;
          if (tradeSignal.signal === 'long') {
            tradeProfitLoss = positionSize * (price - entry);
            if (price <= stop || tradeProfitLoss >= positionSize * atrNow * 0.35 || price >= target) break;
          } else {
            tradeProfitLoss = positionSize * (entry - price);
            if (price >= stop || tradeProfitLoss >= positionSize * atrNow * 0.35 || price <= target) break;
          }
        }

        balance += positionSize * entry + tradeProfitLoss;
        if (tradeProfitLoss >= 0) wins++;
        if (balance <= 0) { balance = 0; investmentGone = true; }
      }
    }

    return trades ? (wins / trades) * 100 : 0;

  } catch (err) {
    console.error(`Error backtesting ${symbol}:`, err);
    return 0;
  }
}

// ---------------- Main ----------------
(async () => {
  try {
    const strategyDir = path.join(__dirname, 'strategies');
    const strategyFiles = fs.readdirSync(strategyDir).filter(f => f.endsWith('.js'));
    const strategies = {};
    for (const file of strategyFiles) strategies[path.basename(file, '.js')] = require(path.join(strategyDir, file));

    const assets = await alpaca.getAssets({ status: 'active' });
    const tradableStocks = assets.filter(a => a.tradable && a.symbol && a.exchange !== 'OTC');
    console.log(`Tradable stocks count: ${tradableStocks.length}`);

    const start = '2024-10-10', end = '2025-10-10';
    const concurrency = 2;

    for (let i = 0; i < tradableStocks.length; i += concurrency) {
      const batch = tradableStocks.slice(i, i + concurrency);

      for (const stock of batch) {
        console.log(`Starting ${stock.symbol}...`);

        for (const [strategyName, strategyFunc] of Object.entries(strategies)) {
          const wr15 = await runBacktest(stock.symbol, '15Min', start, end, strategyFunc);
          const wr4h = await runBacktest(stock.symbol, '4Hour', start, end, strategyFunc);
          const avgWR = ((wr15 + wr4h) / 2).toFixed(2);

          const existingIndex = allResults.findIndex(r => r.symbol === stock.symbol && r.strategy === strategyName);
          const newResult = { name: stock.name, symbol: stock.symbol, strategy: strategyName, winRate: parseFloat(avgWR) };

          if (existingIndex >= 0) allResults[existingIndex] = newResult;
          else allResults.push(newResult);

          console.log(`Finished ${stock.symbol} | Strategy: ${strategyName} | Avg WR: ${avgWR}%`);
        }

        await delay(1000); // avoid 429
      }

      fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
    }

    console.log(`Backtesting complete! Total results: ${allResults.length}`);
  } catch (err) {
    console.error('Error in main backtest loop:', err);
  }
})();

