/*
Catches reversals from extreme RSI or Bollinger deviations.
- Good for stocks that go sideways or slightly trending
- Uses RSI extremes (overbought/oversold) for entries
- Confirms with small ATR-based stop to limit risk
- Allows multiple small trades that MomentumPullback/TrendSpike might miss
*/
const { RSI, ATR, SMA } = require('../helpers');

module.exports = function MeanReversionRebound(prices, candles, volumes, higherCandles, i, lastTradeIndex, cooldownBars) {
  if (i < 14) return null; // need RSI lookback
  const rsiValue = RSI(prices, 14);
  const atrNow = ATR(candles);
  const cooled = i - lastTradeIndex >= cooldownBars;

  if (!rsiValue || !atrNow || !cooled) return null;

  const candle = candles.at(-1);

  // Oversold rebound → long
  if (rsiValue < 30 && candle.close < candle.open && candle.close < SMA(prices, 20)) {
    return { signal: 'long', reasons: `RSI ${rsiValue.toFixed(2)} oversold, potential rebound` };
  }

  // Overbought rebound → short
  if (rsiValue > 70 && candle.close > candle.open && candle.close > SMA(prices, 20)) {
    return { signal: 'short', reasons: `RSI ${rsiValue.toFixed(2)} overbought, potential reversal` };
  }

  return null;
};

