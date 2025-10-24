// TrendSpike Strategy
/*
Trend Alignment: Requires short-term and higher timeframe trends to agree.
Momentum: Fast SMA slope and RSI confirm strong directional momentum.
Volatility & Strength: ATR and ADX ensure sufficient movement and trend strength.
Price & Volume Spike: Price breaking Bollinger Bands with a volume surge signals entries.
Cooldown: Limits repeated signals by enforcing a minimum bar gap between trades.
Long Entry: Uptrend alignment, RSI > 66, ADX > 30, price > BB upper, volume spike.
Short Entry: Downtrend alignment, RSI < 34, ADX > 30, price < BB lower, volume spike.
*/
// Exported as a function for backtester import

const { SMA, smaSlope, RSI, ATR, trendDirection, BollingerBands, ADX } = require('../helpers');

module.exports = function TrendSpike(prices, candles, volumes, higherCandles, i, lastTradeIndex, cooldownBars) {
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
  const volSpike = volNow > prevVol * 1.25 && volNow > avgVol;
  const cooled = i - lastTradeIndex >= cooldownBars;

  const lowerTrend = trendDirection(candles);
  const higherTrend = trendDirection(higherCandles.slice(0, Math.floor(i / 12) + 1));

  if (!fast || !slow || !rsiValue || !bb || !atrNow || !adxVal || !lowerTrend || !higherTrend || !cooled) return null;
  if (lowerTrend === 'up' && fastSlope <= atrNow * 0.05) return null;
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
};
