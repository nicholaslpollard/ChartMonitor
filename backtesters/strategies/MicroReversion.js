/*
Targets small bounces or pullbacks in thinly traded stocks
- Uses short-term RSI extremes (oversold/overbought)
- Confirms with price vs short SMA (5-bar)
- Allows small trades even in sideways or choppy conditions
*/
const { RSI, SMA } = require('../helpers');

module.exports = function MicroReversion(prices, candles, volumes, higherCandles, i, lastTradeIndex, cooldownBars) {
  if (i < 5) return null;

  const rsiValue = RSI(prices, 5);
  const sma5 = SMA(prices, 5);
  const candle = candles.at(-1);
  const cooled = i - lastTradeIndex >= cooldownBars;

  if (!cooled || !rsiValue || !sma5) return null;

  // Small bounce long
  if (rsiValue < 35 && candle.close < sma5) {
    return { signal: 'long', reasons: `RSI ${rsiValue.toFixed(2)} oversold, potential micro-bounce` };
  }

  // Small pullback short
  if (rsiValue > 65 && candle.close > sma5) {
    return { signal: 'short', reasons: `RSI ${rsiValue.toFixed(2)} overbought, potential micro-pullback` };
  }

  return null;
};
