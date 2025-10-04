// backend/config/alpaca.js
const Alpaca = require("@alpacahq/alpaca-trade-api");
require("dotenv").config(); // for API keys stored in .env

const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY,      // your Alpaca API key
  secretKey: process.env.ALPACA_SECRET_KEY, // your Alpaca secret
  paper: true,                             // use paper trading environment
  usePolygon: false                        // set to true if you use Polygon
});

/**
 * Helper function to fetch historical bars
 * @param {string} timeframe - '1Min', '5Min', '1Day', etc.
 * @param {string} symbol
 * @param {Object} options - { limit: number, start, end }
 * @returns {Promise<Array>} Array of bar objects
 */
async function getBars(timeframe, symbol, options = {}) {
  try {
    const bars = await alpaca.getBarsV2(
      symbol,
      {
        timeframe: timeframe,
        limit: options.limit || 50,
        start: options.start,
        end: options.end
      },
      alpaca.configuration
    );

    // Convert bars iterator to array
    const result = [];
    for await (let bar of bars) {
      result.push({
        openPrice: bar.OpenPrice,
        highPrice: bar.HighPrice,
        lowPrice: bar.LowPrice,
        closePrice: bar.ClosePrice,
        volume: bar.Volume,
        timestamp: bar.Timestamp
      });
    }
    return result;
  } catch (err) {
    console.error(`Error fetching bars for ${symbol}:`, err);
    return [];
  }
}

module.exports = { alpaca, getBars };
