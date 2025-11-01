// singlebacktest.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const parquet = require('parquets');
const readline = require('readline');
const { SMA, smaSlope, RSI, ATR, trendDirection, BollingerBands, ADX } = require('./helpers');

// ---------------- Delay Helper ----------------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

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

// ---------------- Run Single Stock with Multiple Strategies ----------------
async function runSingleBacktest(symbol, strategies, selectedTimeframes) {
  const allTimeframes = ['15Min','1Hour','4Hour','1day','1week'];
  const timeframes = selectedTimeframes && selectedTimeframes.length ? selectedTimeframes : allTimeframes;
  const timeframeResults = {};

  for (const tf of timeframes) {
    let bestForTF = { strategy: '', winRate: 0 };
    for (const [strategyName, strategyFunc] of Object.entries(strategies)) {
      const result = await runBacktestFromParquet(symbol, tf, strategyFunc);
      if (result.winRate > bestForTF.winRate) {
        bestForTF = { ...result, strategy: strategyName };
      }
    }
    timeframeResults[tf] = bestForTF;
  }

  const allWinRates = Object.values(timeframeResults).map(r => r.winRate);
  const overallWinRate = allWinRates.reduce((a,b)=>a+b,0)/allWinRates.length;

  const output = {
    symbol,
    overallWinRate: parseFloat(overallWinRate.toFixed(2)),
    timeframes: timeframeResults
  };

  console.log('================ Single Backtest Result ================');
  console.log(JSON.stringify(output, null, 2));
}

// ---------------- Main ----------------
(async () => {
  try {
    const strategyDir = path.join(__dirname, 'strategies');
    const strategies = {};
    for (const file of fs.readdirSync(strategyDir).filter((f) => f.endsWith('.js'))) {
      strategies[path.basename(file, '.js')] = require(path.join(strategyDir, file));
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.question('Enter the stock symbol to test: ', (symbolInput) => {
      const symbol = symbolInput.trim().toUpperCase();

      const timeframeMenu = `
Select timeframes to test (comma-separated numbers) or press Enter for all:
1) 15Min
2) 1Hour
3) 4Hour
4) 1day
5) 1week
> `;

      rl.question(timeframeMenu, async (choiceInput) => {
        rl.close();

        const tfMap = {
          '1': '15Min',
          '2': '1Hour',
          '3': '4Hour',
          '4': '1day',
          '5': '1week'
        };

        let selectedTimeframes = choiceInput
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
          .map(num => tfMap[num])
          .filter(Boolean);

        if (selectedTimeframes.length === 0) selectedTimeframes = null;

        await runSingleBacktest(symbol, strategies, selectedTimeframes);
        console.log('Single backtest complete!');
      });
    });
  } catch (err) {
    console.error('Fatal error:', err);
  }
})();
