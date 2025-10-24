/*
Captures breakouts from recent consolidation.
- Looks for tight ranges in last N bars (low volatility)
- Confirms breakout by closing above/below the range
- Uses volume spike to validate breakout
- Works for stocks missing momentum entries in tight ranges
*/
const { SMA, ATR, RSI } = require('../helpers');

module.exports = function BreakoutRange(prices, candles, volumes, higherCandles, i, lastTradeIndex, cooldownBars) {
  const RANGE_LOOKBACK = 20;
  const VOL_MULT = 1.3;

  if (i < RANGE_LOOKBACK) return null;

  const recent = candles.slice(-RANGE_LOOKBACK);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);

  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);

  const candle = candles.at(-1);
  const volNow = volumes.at(-1);
  const avgVol = SMA(volumes, RANGE_LOOKBACK);
  const volSpike = volNow > avgVol * VOL_MULT;
  const cooled = i - lastTradeIndex >= cooldownBars;

  if (!cooled || !volSpike) return null;

  // Long breakout
  if (candle.close > rangeHigh) return { signal: 'long', reasons: `Breakout above ${rangeHigh}, Volume Spike` };

  // Short breakout
  if (candle.close < rangeLow) return { signal: 'short', reasons: `Breakdown below ${rangeLow}, Volume Spike` };

  return null;
};
