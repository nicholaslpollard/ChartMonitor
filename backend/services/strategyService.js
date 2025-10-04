const { SMA, EMA, RSI, ATR, ADX, BollingerBands } = require("../utils/indicators");

/**
 * strategyCheck
 * Ultra-High Win Rate Strategy (adapted from backtest_ultra_wr.js)
 * @param {string} symbol
 * @param {Array<number>} prices - array of historical closing prices
 * @param {Array<Object>} candles - array of OHLC objects (for ATR)
 * @param {Array<Object>} higherCandles - higher timeframe candles (optional, e.g., 1-hour)
 * @param {number} lastTradeIndex - index of last trade for cooldown
 * @param {number} currentIndex - current candle index
 * @param {number} cooldownBars - number of bars to wait between trades
 * @returns {Object|null} signal {direction, entry, atr, reasons}
 */
function strategyCheck(symbol, prices, candles, higherCandles = [], lastTradeIndex = -999, currentIndex = 0, cooldownBars = 8) {
  if (!prices || prices.length < 25 || !candles || candles.length < 2) return null;

  // --- Indicators ---
  const fastSMA = SMA(prices, 9);
  const slowSMA = SMA(prices, 21);
  const rsiVal = RSI(prices, 14);
  const atrVal = ATR(candles, 14) || 1; // fallback if ATR not available
  const adxVal = ADX(candles, 14) || 20;
  const bb = BollingerBands(prices);

  if (!fastSMA || !slowSMA || !rsiVal || !bb) return null;

  const cooled = currentIndex - lastTradeIndex >= cooldownBars;
  if (!cooled) return null;

  const latestCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];

  // --- Trend Determination ---
  const lowerTrend = fastSMA > slowSMA ? 'up' : 'down';
  let higherTrend = lowerTrend;
  if (higherCandles && higherCandles.length >= 50) {
    const higherCloses = higherCandles.map(c => c.close);
    const fastHTF = SMA(higherCloses, 21);
    const slowHTF = SMA(higherCloses, 50);
    if (fastHTF && slowHTF) higherTrend = fastHTF > slowHTF ? 'up' : 'down';
  }

  const reasons = [];
  if (lowerTrend === 'up') reasons.push('5-min Trend Up');
  if (lowerTrend === 'down') reasons.push('5-min Trend Down');
  if (higherTrend === 'up') reasons.push('Higher TF Trend Up');
  if (higherTrend === 'down') reasons.push('Higher TF Trend Down');
  if (fastSMA > slowSMA) reasons.push('Fast SMA > Slow SMA');
  if (fastSMA < slowSMA) reasons.push('Fast SMA < Slow SMA');
  if (rsiVal > 66) reasons.push('RSI > 66');
  if (rsiVal < 34) reasons.push('RSI < 34');
  if (adxVal > 30) reasons.push('ADX > 30');
  if (latestCandle.close > bb.upper) reasons.push('Price > BB Upper');
  if (latestCandle.close < bb.lower) reasons.push('Price < BB Lower');

  // --- Ultra-WR Entry Conditions ---
  if (
    lowerTrend === 'up' &&
    higherTrend === 'up' &&
    fastSMA > slowSMA &&
    latestCandle.close > prevCandle.high &&
    rsiVal > 66 &&
    adxVal > 30 &&
    latestCandle.close > bb.upper
  ) {
    return { direction: 'long', entry: latestCandle.close, atr: atrVal, reasons: reasons.join(', ') };
  }

  if (
    lowerTrend === 'down' &&
    higherTrend === 'down' &&
    fastSMA < slowSMA &&
    latestCandle.close < prevCandle.low &&
    rsiVal < 34 &&
    adxVal > 30 &&
    latestCandle.close < bb.lower
  ) {
    return { direction: 'short', entry: latestCandle.close, atr: atrVal, reasons: reasons.join(', ') };
  }

  return null;
}

module.exports = { strategyCheck };

