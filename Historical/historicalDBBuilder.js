// historicalDBBuilder.js

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const rateLimit = require('axios-rate-limit');
const { parse } = require('csv-parse');
require('dotenv').config();

// Initialize API Key and Set Rate Limiter
const API_KEY = process.env.FINNHUB_API_KEY;
const api = rateLimit(axios.create(), { maxRequests: 55, perMilliseconds: 60 * 1000, maxRPS: 55 });

// Paths for storing data
const DATA_PATH = path.join(__dirname, '6monthDB.json');
const PROGRESS_PATH = path.join(__dirname, 'progress.json');
const OPTIONABLE_PATH = path.join(__dirname, '../backtesters/optionable_stocks.csv'); // Adjusted relative path

// Timeframe options
const timeframes = ['15', '60', '240', 'D']; // 15 min, 1 hr, 4 hr, 1 day

// Load progress
let progress = {};
if (fs.existsSync(PROGRESS_PATH)) {
  progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
}

// Initialize JSON database structure
if (!fs.existsSync(DATA_PATH)) {
  fs.writeFileSync(DATA_PATH, JSON.stringify({}), 'utf-8');
}

// Fetch historical data (from optional start timestamp)
async function fetchHistoricalData(symbol, timeframe, start, end) {
  try {
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=${timeframe}&from=${start}&to=${end}&token=${API_KEY}`;
    const response = await api.get(url);
    const data = response.data;

    if (data.s === 'no_data') {
      console.log(`No data for ${symbol} on ${timeframe}`);
      return [];
    }

    return data.t.map((timestamp, i) => ({
      symbol,
      timeframe,
      timestamp,
      open: data.o[i],
      high: data.h[i],
      low: data.l[i],
      close: data.c[i],
      volume: data.v[i],
    }));
  } catch (err) {
    console.error(`Error fetching data for ${symbol} (${timeframe}): ${err.message}`);
    return [];
  }
}

// Save progress
function saveProgress() {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), 'utf-8');
}

// Insert data into JSON DB
function insertData(candles) {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  candles.forEach(candle => {
    if (!data[candle.symbol]) data[candle.symbol] = {};
    if (!data[candle.symbol][candle.timeframe]) data[candle.symbol][candle.timeframe] = [];
    // Avoid duplicates
    if (!data[candle.symbol][candle.timeframe].some(c => c.timestamp === candle.timestamp)) {
      data[candle.symbol][candle.timeframe].push(candle);
    }
  });
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// Load active symbols from CSV
async function getActiveSymbols() {
  return new Promise((resolve, reject) => {
    const symbols = [];
    fs.createReadStream(OPTIONABLE_PATH)
      .pipe(parse({ columns: true, skip_empty_lines: true }))
      .on('data', row => {
        if (row.Symbol) symbols.push(row.Symbol);
      })
      .on('end', () => resolve(symbols))
      .on('error', err => reject(err));
  });
}

// Get timestamps for last 6 months
function getTimestamps() {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 6 * 30 * 24 * 60 * 60;
  return { start, end };
}

// Process one symbol with full resume support
async function processSymbol(symbol, start, end) {
  for (const timeframe of timeframes) {
    let timeframeStart = start;

    // Resume from last timestamp if available
    if (
      progress[symbol] &&
      progress[symbol][timeframe] &&
      progress[symbol][timeframe].lastTimestamp
    ) {
      timeframeStart = progress[symbol][timeframe].lastTimestamp + 1; // Start after last candle
      console.log(`Resuming ${symbol} (${timeframe}) from timestamp ${timeframeStart}`);
    }

    const candles = await fetchHistoricalData(symbol, timeframe, timeframeStart, end);

    if (candles.length > 0) {
      insertData(candles);

      // Update progress per symbol & timeframe
      if (!progress[symbol]) progress[symbol] = {};
      progress[symbol][timeframe] = {
        lastTimestamp: candles[candles.length - 1].timestamp
      };
      saveProgress();

      console.log(`Stored ${candles.length} candles for ${symbol} (${timeframe})`);
    }
  }
}

// Main runner
async function run() {
  const { start, end } = getTimestamps();
  const symbols = await getActiveSymbols();

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    console.log(`Processing symbol ${i + 1}/${symbols.length}: ${symbol}`);
    await processSymbol(symbol, start, end);
    console.log(`Finished processing ${symbol}`);
  }

  console.log('All data fetched and saved successfully!');
}

run().catch(console.error);
