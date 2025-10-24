// stockmonitor.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const csvParse = require('csv-parse/lib/sync');
const Finnhub = require('finnhub');

// ---- Finnhub API Setup ----
const apiKey = process.env.FINNHUB_API_KEY;
if (!apiKey) throw new Error('FINNHUB_API_KEY not set in .env');

const finnhubClient = new Finnhub.DefaultApi();
finnhubClient.apiClient.authentications['apiKey'].apiKey = apiKey;

// ---- Paths ----
const backtesterLogPath = path.join(__dirname, '..', 'backtester', 'log', 'results.json');
const optionableCsvPath = path.join(__dirname, '..', 'backtester', 'optionable_stocks.csv');
const resultsPath = path.join(__dirname, 'log', 'results.json');

// Ensure log folder exists
if (!fs.existsSync(path.dirname(resultsPath))) {
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
}

// ---- Load Backtester Results ----
let backtesterResults = [];
if (fs.existsSync(backtesterLogPath)) {
  backtesterResults = JSON.parse(fs.readFileSync(backtesterLogPath, 'utf-8'));
} else {
  console.error('Backtester results file missing!');
  process.exit(1);
}

// ---- Load Optionable Stocks ----
let optionableSymbols = [];
if (fs.existsSync(optionableCsvPath)) {
  const csvData = fs.readFileSync(optionableCsvPath, 'utf-8');
  const records = csvParse(csvData, { columns: true, skip_empty_lines: true });
  optionableSymbols = records.map(r => r.Symbol);
} else {
  console.error('Optionable stocks CSV missing!');
  process.exit(1);
}

// ---- Load Strategies ----
const strategyDir = path.join(__dirname, '..', 'backtester', 'strategies');
const strategies = {};
for (const file of fs.readdirSync(strategyDir).filter(f => f.endsWith('.js'))) {
  strategies[path.basename(file, '.js')] = require(path.join(strategyDir, file));
}

// ---- Load Helper Functions ----
const { SMA, smaSlope, RSI, ATR, trendDirection, BollingerBands, ADX } = require(path.join(__dirname, '..', 'backtester', 'helper.js'));

// ---- Results Storage ----
let alertResults = [];
if (fs.existsSync(resultsPath)) {
  try { alertResults = JSON.parse(fs.readFileSync(resultsPath, 'utf-8')); } 
  catch { alertResults = []; }
}

// ---- Helper: Get Current Price ----
async function getCurrentPrice(symbol) {
  return new Promise((resolve, reject) => {
    finnhubClient.quote(symbol, (error, data, response) => {
      if (error) return reject(error);
      resolve(data.c); // Current price
    });
  });
}

// ---- Helper: Get Historical Data ----
async function getHistoricalData(symbol, resolution = '15', fromDaysAgo = 30) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - fromDaysAgo * 24 * 60 * 60;
  return new Promise((resolve, reject) => {
    finnhubClient.stockCandles(symbol, resolution, from, to, (error, data, response) => {
      if (error) return reject(error);
      if (data.s !== 'ok') return reject(new Error(`Failed to get candles for ${symbol}`));
      const candles = data.t.map((time, idx) => ({
        time: new Date(time * 1000),
        open: data.o[idx],
        high: data.h[idx],
        low: data.l[idx],
        close: data.c[idx],
        volume: data.v[idx]
      }));
      resolve(candles);
    });
  });
}

// ---- Main Stock Monitoring ----
async function monitorStocks() {
  console.log(`Monitoring ${backtesterResults.length} stocks for entry signals...`);

  for (const stock of backtesterResults) {
    const { symbol, strategy: strategyName } = stock;

    if (!optionableSymbols.includes(symbol)) continue;
    const strategyFunc = strategies[strategyName];
    if (!strategyFunc) {
      console.warn(`Strategy ${strategyName} not found for ${symbol}`);
      continue;
    }

    try {
      const candles = await getHistoricalData(symbol, '15', 30); // last 30 days, 15 min bars
      if (!candles || candles.length < 20) continue; // skip if insufficient data

      const prices = candles.map(c => c.close);
      const volumes = candles.map(c => c.volume);

      // Run the strategy function (assume it returns 'long', 'short', or null)
      const signal = strategyFunc(prices, candles, volumes);

      if (signal) {
        const currentPrice = await getCurrentPrice(symbol);
        const alert = {
          symbol,
          strategy: strategyName,
          signal,
          price: currentPrice,
          timestamp: new Date().toISOString()
        };
        alertResults.push(alert);
        console.log(`⚡ ${symbol} | Strategy: ${strategyName} | Signal: ${signal} | Price: ${currentPrice}`);
      }

    } catch (err) {
      console.error(`Error processing ${symbol}: ${err.message}`);
    }
  }

  fs.writeFileSync(resultsPath, JSON.stringify(alertResults, null, 2));
  console.log('Stock monitoring complete. Alerts saved.');
}

// ---- Run Monitor ----
monitorStocks();
