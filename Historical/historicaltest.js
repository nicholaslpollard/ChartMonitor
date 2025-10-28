// historicaltest.js
const fs = require('fs');
const path = require('path');
const yf = require('yahoo-finance2').default; // Use .default
require('dotenv').config();

// Output file
const DATA_PATH = path.join(__dirname, 'yahooTestData.json');

// Popular stocks to test
const symbols = ['AAPL', 'MSFT', 'TSLA', 'GOOGL', 'AMZN'];

// Intervals to fetch
const intervals = ['15m', '60m', '1d']; // 15m & 60m: intraday, 1d: daily

// Helper: write JSON safely
function writeJSONSafe(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// Sleep helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch historical data for one symbol & interval
async function fetchHistorical(symbol, interval) {
  try {
    let data = [];
    if (interval === '1d') {
      // Daily data: use start/end dates (last 6 months)
      const end = new Date();
      const start = new Date();
      start.setMonth(end.getMonth() - 6);

      const options = {
        period1: start,
        period2: end,
        interval: interval
      };
      data = await yf.historical(symbol, options);
    } else {
      // Intraday data (15m, 60m) uses 'chart' method with range
      // Yahoo limits intraday data to ~60 days
      const range = '60d';
      const chartInterval = interval; // '15m' or '60m'
      const result = await yf.chart(symbol, { interval: chartInterval, range });
      data = result.timestamp.map((ts, idx) => ({
        date: new Date(ts * 1000),
        open: result.indicators.quote[0].open[idx],
        high: result.indicators.quote[0].high[idx],
        low: result.indicators.quote[0].low[idx],
        close: result.indicators.quote[0].close[idx],
        volume: result.indicators.quote[0].volume[idx]
      }));
    }

    return data.map(c => ({
      symbol,
      interval,
      timestamp: c.date.getTime() / 1000,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume
    }));
  } catch (err) {
    console.log(`${symbol} (${interval}) - Error: ${err.message}`);
    return [];
  }
}

// Main test runner
async function runTest() {
  const allData = {};

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    console.log(`Processing ${i + 1}/${symbols.length}: ${symbol}`);
    allData[symbol] = {};

    for (const interval of intervals) {
      console.log(`Fetching ${symbol} (${interval})`);
      const candles = await fetchHistorical(symbol, interval);
      allData[symbol][interval] = candles;
      console.log(`Stored ${candles.length} candles for ${symbol} (${interval})`);

      // Delay 1s between requests to be gentle
      await sleep(1000);
    }
  }

  writeJSONSafe(DATA_PATH, allData);
  console.log('Test run complete! Data saved to yahooTestData.json');
}

runTest().catch(console.error);

