//backtest.js with 57.57% win rate with nvidia - stocks
// wr: anything breakeven or profit is win, any loss is lose

// backtest_ultra_wr.js - ultra-high win rate
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

// Log Setup
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, 'ultraWRLog.txt');
fs.writeFileSync(logPath, `Ultra WR Backtest Log - ${new Date().toLocaleString()}\n========================\n\n`);

// Helper Functions
function SMA(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function smaSlope(arr, period = 3) {
  if (arr.length < period + 1) return null;
  let slope = 0;
  for (let i = arr.length - period; i < arr.length; i++) slope += arr[i] - arr[i - 1];
  return slope;
}

function RSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function ATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const curr = candles[i], prev = candles[i - 1];
    const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function trendDirection(candles) {
  if (candles.length < 21) return null;
  const closes = candles.map(c => c.close);
  const smaFast = SMA(closes, 9);
  const smaSlow = SMA(closes, 21);
  return smaFast > smaSlow ? 'up' : 'down';
}

function BollingerBands(prices, period = 20, mult = 2) {
  if (prices.length < period) return null;
  const sma = SMA(prices, period);
  const variance = prices.slice(-period).reduce((sum, p) => sum + Math.pow(p - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return { upper: sma + mult * stdDev, lower: sma - mult * stdDev, mid: sma, width: 2 * mult * stdDev };
}

function ADX(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let trList = [], plusDM = [], minusDM = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i], prev = candles[i - 1];
    const highDiff = curr.high - prev.high;
    const lowDiff = prev.low - curr.low;
    plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
    trList.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)));
  }
  const smTR = SMA(trList, period);
  const smPlus = SMA(plusDM, period);
  const smMinus = SMA(minusDM, period);
  const plusDI = (smPlus / smTR) * 100;
  const minusDI = (smMinus / smTR) * 100;
  return (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
}

// Fetch Historical Data
async function fetchHistoricalData(symbol, timeframe, start, end) {
  const resp = await alpaca.getBarsV2(symbol, { start: new Date(start).toISOString(), end: new Date(end).toISOString(), timeframe }, alpaca.configuration);
  const bars = [];
  for await (let bar of resp) bars.push({ time: bar.Timestamp, open: bar.OpenPrice, high: bar.HighPrice, low: bar.LowPrice, close: bar.ClosePrice, volume: bar.Volume });
  return bars;
}

// Ultra-High Win Rate Strategy
function strategy(prices, candles, volumes, higherCandles, i, lastTradeIndex, cooldownBars) {
  const fast = SMA(prices, 9);
  const slow = SMA(prices, 21);
  const fastSlope = smaSlope(prices, 3);
  const rsiValue = RSI(prices);
  const atrNow = ATR(candles);
  const bb = BollingerBands(prices);
  const adxVal = ADX(candles);
  const volNow = volumes.at(-1);
  const prevVol = volumes.at(-2) || volNow;
  const avgVol = SMA(volumes, 20);
  const volSpike = volNow > prevVol * 1.25 && volNow > avgVol; // tighter
  const cooled = i - lastTradeIndex >= cooldownBars;

  const lowerTrend = trendDirection(candles);
  const higherTrend = trendDirection(higherCandles.slice(0, Math.floor(i / 12) + 1));
  if (!fast || !slow || !rsiValue || !bb || !atrNow || !adxVal || !lowerTrend || !higherTrend || !cooled) return null;
  if (lowerTrend === 'up' && fastSlope <= atrNow * 0.05) return null; // only strong slopes
  if (lowerTrend === 'down' && fastSlope >= -atrNow * 0.05) return null;

  const candle = candles.at(-1);
  const prev = candles.at(-2);

  const reasons = [];
  if (lowerTrend === 'up') reasons.push('5-min Trend Up');
  if (lowerTrend === 'down') reasons.push('5-min Trend Down');
  if (higherTrend === 'up') reasons.push('1-hr Trend Up');
  if (higherTrend === 'down') reasons.push('1-hr Trend Down');
  if (fast > slow) reasons.push('Fast SMA > Slow SMA');
  if (fast < slow) reasons.push('Fast SMA < Slow SMA');
  if (rsiValue > 66) reasons.push('RSI > 66');
  if (rsiValue < 34) reasons.push('RSI < 34');
  if (adxVal > 30) reasons.push('ADX > 30');
  if (candle.close > bb.upper) reasons.push('Price > BB Upper');
  if (candle.close < bb.lower) reasons.push('Price < BB Lower');
  if (volSpike) reasons.push('Volume Spike');
  if (cooled) reasons.push('Cooldown passed');

  if (lowerTrend === 'up' && higherTrend === 'up' && fast > slow && candle.close > prev.high && rsiValue > 66 && adxVal > 30 && candle.close > bb.upper && volSpike)
    return { signal: 'long', reasons: reasons.join(', ') };
  if (lowerTrend === 'down' && higherTrend === 'down' && fast < slow && candle.close < prev.low && rsiValue < 34 && adxVal > 30 && candle.close < bb.lower && volSpike)
    return { signal: 'short', reasons: reasons.join(', ') };

  return null;
}

// Dynamic Risk
function dynamicRisk(entry, setup, atr) {
  const stopLoss = atr * 0.7; // tighter stop
  const takeProfit = atr * 1.1; // tighter target
  if (setup === 'long') return { stop: +(entry - stopLoss).toFixed(2), target: +(entry + takeProfit).toFixed(2) };
  else return { stop: +(entry + stopLoss).toFixed(2), target: +(entry - takeProfit).toFixed(2) };
}

// Backtest Runner
async function runBacktest(symbol = 'NVDA', start = '2024-10-01', end = '2025-09-30') {
  try {
    console.log(`Running ultra-high WR backtest on ${symbol} from ${start} to ${end}`);
    const [lower, higher] = await Promise.all([
      fetchHistoricalData(symbol, '5Min', start, end),
      fetchHistoricalData(symbol, '1Hour', start, end),
    ]);

    const prices = [], volumes = [], candles = [];
    let trades = 0, wins = 0, losses = 0, lastTradeIndex = -999;
    const COOLDOWN = 8; // extended for ultra-high WR
    let balance = 100, investmentGone = false;

    for (let i = 25; i < lower.length; i++) {
      prices.push(lower[i].close);
      volumes.push(lower[i].volume);
      candles.push(lower[i]);
      const subPrices = prices.slice(-30), subCandles = candles.slice(-30), subVolumes = volumes.slice(-30);

      const tradeSignal = strategy(subPrices, subCandles, subVolumes, higher, i, lastTradeIndex, COOLDOWN);
      if (tradeSignal && !investmentGone) {
        const { signal, reasons } = tradeSignal;
        const entry = lower[i].close;
        const atrNow = ATR(subCandles);
        const { stop, target } = dynamicRisk(entry, signal, atrNow);

        lastTradeIndex = i;
        trades++;

        let riskAmount = balance * 0.15; // smaller risk per trade
        if (riskAmount < 30) riskAmount = 30;
        const stopDistance = Math.max(Math.abs(entry - stop), 0.0001);
        let positionSize = Math.min(riskAmount / stopDistance, balance / entry);
        balance -= positionSize * entry;

        let exited = false, tradeProfitLoss = 0, exitPrice = entry;
        for (let j = i + 1; j < Math.min(i + 12, lower.length); j++) {
          const price = lower[j].close;
          exitPrice = price;
          // very tight trailing exit
          if (signal === 'long') {
            tradeProfitLoss = positionSize * (price - entry);
            if (price <= stop || tradeProfitLoss >= positionSize * atrNow * 0.35 || price >= target) { exited = true; break; }
          } else {
            tradeProfitLoss = positionSize * (entry - price);
            if (price >= stop || tradeProfitLoss >= positionSize * atrNow * 0.35 || price <= target) { exited = true; break; }
          }
        }

        balance += positionSize * entry + tradeProfitLoss;
        const tradeResult = tradeProfitLoss >= 0 ? 'Win' : 'Loss';
        if (tradeProfitLoss >= 0) wins++; else losses++;
        if (balance <= 0) { balance = 0; investmentGone = true; }

        const tradeLog = `Trade #${trades}\nSignal: ${signal}\nReason: ${reasons}\nEntry: ${entry}, Exit: ${exitPrice}, Stop: ${stop}, Target: ${target}\nPosition Size: ${positionSize.toFixed(4)}, Money Used: ${(positionSize * entry).toFixed(2)}\nTimeframe: 5Min\nResult: ${tradeResult}, P/L: ${tradeProfitLoss.toFixed(2)}\nBalance after trade: ${balance.toFixed(2)}\n-------------------------------\n`;
        fs.appendFileSync(logPath, tradeLog);
      }
    }

    const winRate = trades ? ((wins / trades) * 100).toFixed(2) : 0;
    console.log(`--- Ultra WR Backtest Summary ---`);
    console.log(`Total trades: ${trades}`);
    console.log(`Wins: ${wins}, Losses: ${losses}`);
    console.log(`Win rate: ${winRate}%`);
    console.log(investmentGone ? "Investment gone: $0" : `Ending balance: $${balance.toFixed(2)}`);

  } catch (err) {
    console.error('Backtest error:', err);
  }
}

runBacktest();
