/**
 * Calculate Simple Moving Average (SMA)
 * @param {Array<number>} prices - array of closing prices
 * @param {number} period - number of periods for SMA
 * @returns {number} SMA value
 */
function SMA(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const sum = slice.reduce((acc, val) => acc + val, 0);
  return sum / period;
}

/**
 * Calculate Exponential Moving Average (EMA)
 * @param {Array<number>} prices - array of closing prices
 * @param {number} period - number of periods for EMA
 * @returns {number} EMA value
 */
function EMA(prices, period) {
  if (prices.length < period) return null;

  const k = 2 / (period + 1);
  let ema = SMA(prices.slice(0, period), period); // start with SMA
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Calculate Relative Strength Index (RSI)
 * @param {Array<number>} prices - array of closing prices
 * @param {number} period - number of periods for RSI
 * @returns {number} RSI value
 */
function RSI(prices, period = 14) {
  if (prices.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Calculate Average True Range (ATR)
 * @param {Array<Object>} candles - array of OHLC objects {high, low, close}
 * @param {number} period - number of periods for ATR
 * @returns {number} ATR value
 */
function ATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  let trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }

  // Simple moving average of TRs
  const slice = trs.slice(-period);
  const sum = slice.reduce((acc, val) => acc + val, 0);
  return sum / period;
}

/**
 * Calculate ADX (Average Directional Index)
 * @param {Array<Object>} candles - array of OHLC objects
 * @param {number} period - number of periods for ADX
 * @returns {number} ADX value
 */
function ADX(candles, period = 14) {
  if (candles.length < period + 1) return null;

  let plusDM = [];
  let minusDM = [];
  let TRs = [];

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    TRs.push(tr);
  }

  const smoothPlusDM = SMA(plusDM.slice(-period), period);
  const smoothMinusDM = SMA(minusDM.slice(-period), period);
  const smoothTR = SMA(TRs.slice(-period), period);

  const plusDI = (smoothPlusDM / smoothTR) * 100;
  const minusDI = (smoothMinusDM / smoothTR) * 100;

  const dx = (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
  return dx; // simplified ADX approximation for now
}

/**
 * Calculate Bollinger Bands
 * @param {Array<number>} prices - array of closing prices
 * @param {number} period - SMA period
 * @param {number} stdDevMult - number of standard deviations
 * @returns {Object} { upper, middle, lower }
 */
function BollingerBands(prices, period = 20, stdDevMult = 2) {
  if (prices.length < period) return null;

  const slice = prices.slice(-period);
  const middle = SMA(slice, period);
  const variance = slice.reduce((acc, val) => acc + (val - middle) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: middle + stdDevMult * stdDev,
    middle,
    lower: middle - stdDevMult * stdDev,
  };
}

module.exports = {
  SMA,
  EMA,
  RSI,
  ATR,
  ADX,
  BollingerBands,
};

