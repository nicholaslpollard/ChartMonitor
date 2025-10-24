// singlebacktest.js
require('dotenv').config();
const Alpaca = require('@alpacahq/alpaca-trade-api');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { ATR } = require('./helpers');

// ---------------- Alpaca API Setup ----------------
const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: true,
  baseUrl: process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets',
});

// ---------------- Helper Functions ----------------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const dynamicDelay = 1200;

// ---------------- Fetch Historical Data ----------------
async function fetchHistoricalData(symbol, timeframe, start, end, retries = 5) {
  for (let attempt = 0; attempt < retries; attempt++) {
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

// ---------------- Run Backtest ----------------
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
    console.error(`Error backtesting ${symbol}: ${err.message}`);
    return { trades: 0, wins: 0, losses: 0, winRate: 0, avgDuration: 0, avgRR: 0 };
  }
}

// ---------------- Prompt Helper ----------------
function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans.trim()); }));
}

// ---------------- Main ----------------
(async () => {
  try {
    const strategyDir = path.join(__dirname, 'strategies');
    const strategies = {};
    const strategyFiles = fs.readdirSync(strategyDir).filter((f) => f.endsWith('.js'));

    for (const file of strategyFiles) {
      strategies[path.basename(file, '.js')] = require(path.join(strategyDir, file));
    }

    const symbol = (await askQuestion('Enter the stock symbol to test (e.g. AAPL): ')).toUpperCase();

    console.log('\nAvailable strategies:');
    Object.keys(strategies).forEach((s, i) => console.log(`${i + 1}. ${s}`));
    console.log(`${Object.keys(strategies).length + 1}. Run ALL strategies`);

    const chosenIndex = await askQuestion('\nEnter the number of the strategy you want to use: ');
    const chosenNum = parseInt(chosenIndex);

    const start = '2025-04-10';
    const end = '2025-10-09';

    if (chosenNum === Object.keys(strategies).length + 1) {
      console.log(`\nRunning ${symbol} against ALL strategies...\n`);
      const results = [];

      for (const [key, strategy] of Object.entries(strategies)) {
        console.log(`\n▶ Running strategy "${key}"...`);
        const result15 = await runBacktest(symbol, '15Min', start, end, strategy);
        const result1h = await runBacktest(symbol, '1Hour', start, end, strategy);

        const avgWinRate = (result15.winRate + result1h.winRate) / 2;
        const combined = {
          strategy: key,
          winRate: parseFloat(avgWinRate.toFixed(2)),
          trades: result15.trades + result1h.trades,
          wins: result15.wins + result1h.wins,
          losses: result15.losses + result1h.losses,
          avgDuration: ((result15.avgDuration + result1h.avgDuration) / 2).toFixed(2),
          avgRR: ((result15.avgRR + result1h.avgRR) / 2).toFixed(2),
        };

        console.log(`📊 ${symbol} | Strategy: ${key}`);
        console.log(`   Win Rate: ${combined.winRate}%`);
        console.log(`   Trades: ${combined.trades} | Wins: ${combined.wins} | Losses: ${combined.losses}`);
        console.log(`   Avg Duration: ${combined.avgDuration} | Avg RR: ${combined.avgRR}\n`);

        results.push(combined);
      }

      console.log('\n===== SUMMARY =====');
      results.sort((a, b) => b.winRate - a.winRate);
      results.forEach(r => {
        console.log(`${r.strategy.padEnd(20)} | Win Rate: ${r.winRate}% | Trades: ${r.trades} | Avg RR: ${r.avgRR}`);
      });
      console.log('\n✅ Completed all strategy backtests.\n');
      return;
    }

    const chosenKey = Object.keys(strategies)[chosenNum - 1];
    if (!chosenKey) {
      console.error('❌ Invalid selection. Please enter a valid strategy number.');
      return;
    }

    const chosenStrategy = strategies[chosenKey];
    console.log(`\nRunning backtest for ${symbol} with strategy "${chosenKey}"...\n`);

    const result15 = await runBacktest(symbol, '15Min', start, end, chosenStrategy);
    const result1h = await runBacktest(symbol, '1Hour', start, end, chosenStrategy);
    const avgWinRate = (result15.winRate + result1h.winRate) / 2;

    const finalResult = {
      symbol,
      strategy: chosenKey,
      winRate: parseFloat(avgWinRate.toFixed(2)),
      trades: result15.trades + result1h.trades,
      wins: result15.wins + result1h.wins,
      losses: result15.losses + result1h.losses,
      avgDuration: ((result15.avgDuration + result1h.avgDuration) / 2).toFixed(2),
      avgRR: ((result15.avgRR + result1h.avgRR) / 2).toFixed(2)
    };

    console.log(`📊 ${symbol} | Strategy: ${chosenKey}`);
    console.log(`   Win Rate: ${finalResult.winRate}%`);
    console.log(`   Trades: ${finalResult.trades} | Wins: ${finalResult.wins} | Losses: ${finalResult.losses}`);
    console.log(`   Avg Duration: ${finalResult.avgDuration} | Avg RR: ${finalResult.avgRR}`);
    console.log('\n✅ Single backtest complete.\n');

  } catch (err) {
    console.error('Fatal error:', err);
  }
})();



