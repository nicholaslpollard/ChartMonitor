//MomentumPullback Strategy
/*
SMA (Fast & Slow): Detects short-term and trend direction.
RSI: Confirms price is not overbought/oversold.
ATR: Measures volatility for stops and targets.
trendDirection: Confirms trend alignment on multiple timeframes.
Volumes & VolSpike: Ensures momentum recovery is supported by volume.
Cooldown: Prevents overtrading by spacing trades.
Candle & Prev Candle: Checks price action recovery after pullback.
*/
const { SMA, smaSlope, RSI, ATR, trendDirection, BollingerBands, ADX } = require('../helpers');

module.exports = function strategy(prices, candles, volumes, higherCandles, i, lastTradeIndex, cooldownBars) {
  const lowerTrend = trendDirection(candles);
  const higherTrend = trendDirection(higherCandles.slice(0, Math.floor(i / 12) + 1));

  // Ensure trend alignment
  if (!lowerTrend || !higherTrend || lowerTrend !== higherTrend) return null;

  const fastSMA = SMA(prices, 9);
  const slowSMA = SMA(prices, 21);
  const rsiValue = RSI(prices);
  const atrNow = ATR(candles);
  const volNow = volumes.at(-1);
  const prevVol = volumes.at(-2) || volNow;
  const avgVol = SMA(volumes, 20);
  const volSpike = volNow > avgVol * 1.2;
  const cooled = i - lastTradeIndex >= cooldownBars;

  if (!fastSMA || !slowSMA || !rsiValue || !atrNow || !cooled) return null;

  const candle = candles.at(-1);
  const prev = candles.at(-2);

  // Entry rules for uptrend
  if (lowerTrend === 'up' &&
      candle.close > slowSMA &&              // Price above long SMA
      candle.close > prev.close &&           // Momentum returning after pullback
      rsiValue > 45 && rsiValue < 70 &&      // RSI within trend confirmation zone
      volSpike) {                             // Volume confirms move
    return { signal: 'long', reasons: 'Uptrend pullback recovered, RSI neutral, volume spike' };
  }

  // Entry rules for downtrend
  if (lowerTrend === 'down' &&
      candle.close < slowSMA &&
      candle.close < prev.close &&
      rsiValue > 30 && rsiValue < 55 &&
      volSpike) {
    return { signal: 'short', reasons: 'Downtrend pullback recovered, RSI neutral, volume spike' };
  }

  return null;
};
