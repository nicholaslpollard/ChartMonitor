/*
Captures breakout moves in low-volume / thinly traded stocks
- Uses a small range of the last 10 bars
- Entry triggered by close outside the recent high/low
- Volume requirement is minimal but looks for at least relative spike
- Works for ETFs, warrants, rights that rarely move
*/
const { SMA } = require('../helpers');

module.exports = function LowVolumeBreakout(prices, candles, volumes, higherCandles, i, lastTradeIndex, cooldownBars) {
  const RANGE_LOOKBACK = 10;
  if (i < RANGE_LOOKBACK) return null;

  const recent = candles.slice(-RANGE_LOOKBACK);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);

  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);

  const candle = candles.at(-1);
  const volNow = volumes.at(-1);
  const avgVol = SMA(volumes, RANGE_LOOKBACK) || 1; // avoid division by zero
  const volSpike = volNow > avgVol * 1.05; // small relative spike
  const cooled = i - lastTradeIndex >= cooldownBars;

  if (!cooled || !volSpike) return null;

  if (candle.close > rangeHigh)
    return { signal: 'long', reasons: `Breakout above ${rangeHigh} in low-volume symbol` };

  if (candle.close < rangeLow)
    return { signal: 'short', reasons: `Breakdown below ${rangeLow} in low-volume symbol` };

  return null;
};
