// backend/services/dataService.js
const { getBars } = require("../config/alpaca");

/**
 * Fetch price data and OHLC candles from Alpaca
 * Supports multiple timeframes for the same symbol
 * @param {Array<string>} symbols
 * @param {number} length - number of historical bars
 * @param {string|Array<string>} timeframe - '1Min', '5Min', '1Day', etc. or array of timeframes
 * @returns {Promise<Object>} { symbol: { timeframe: { prices: [], candles: [] } } }
 */
async function getPriceData(symbols, length = 50, timeframe = "1Min") {
  const results = {};

  // Ensure timeframe is array
  const timeframes = Array.isArray(timeframe) ? timeframe : [timeframe];

  for (const sym of symbols) {
    results[sym] = {};

    for (const tf of timeframes) {
      try {
        const bars = await getBars(tf, sym, { limit: length });

        // Build prices array and OHLC candles array
        const prices = bars.map(bar => bar.closePrice);
        const candles = bars.map(bar => ({
          open: bar.openPrice,
          high: bar.highPrice,
          low: bar.lowPrice,
          close: bar.closePrice,
          volume: bar.volume,
          time: bar.startTime || bar.time, // keep timestamp if available
        }));

        results[sym][tf] = { prices, candles };
      } catch (err) {
        console.error(`Error fetching data for ${sym} (${tf}):`, err);
        results[sym][tf] = { prices: [], candles: [] };
      }
    }
  }

  return results;
}

module.exports = { getPriceData };

