require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const axios = require('axios');
const parquet = require('parquets');
const tulind = require('tulind'); // for indicators

// -------------------- CONFIG --------------------
if (!process.env.POLYGON_API_KEY) {
  console.error("❌ POLYGON_API_KEY is missing in .env");
  process.exit(1);
}

const TIMEFRAMES = ['15min', '1hour', '4hour', '1day', '1week'];
const OUTPUT_DIR = path.resolve(__dirname, './data');
const PROGRESS_FILE = path.resolve(__dirname, './progress.json');
const STOCKS_FILE = path.resolve(__dirname, '../backtesters/optionable_stocks.csv');

const MAX_CONCURRENT_DOWNLOADS = Math.max(4, os.cpus().length * 2);
let activeDownloads = 0;
let completed = 0;
let totalTasks = 0;

// -------------------- UTILITY --------------------
async function loadProgress() {
  try {
    if (await fs.pathExists(PROGRESS_FILE)) return await fs.readJSON(PROGRESS_FILE);
  } catch (err) {
    console.warn('⚠️ Could not read progress.json, starting fresh.');
  }
  return { completed: {} };
}

async function saveProgress(progress) {
  try {
    await fs.writeJSON(PROGRESS_FILE, progress, { spaces: 2 });
  } catch (err) {
    console.warn('⚠️ Failed to save progress file:', err.message);
  }
}

// -------------------- PARQUET SCHEMA --------------------
const schema = new parquet.ParquetSchema({
  ts: { type: 'TIMESTAMP_MILLIS' },
  o: { type: 'DOUBLE' },
  h: { type: 'DOUBLE' },
  l: { type: 'DOUBLE' },
  c: { type: 'DOUBLE' },
  v: { type: 'INT64' },
  n: { type: 'INT64', optional: true },
  vw: { type: 'DOUBLE', optional: true },

  // Optional fundamentals
  adjClose: { type: 'DOUBLE', optional: true },
  marketCap: { type: 'INT64', optional: true },
  peRatio: { type: 'DOUBLE', optional: true },
  dividendYield: { type: 'DOUBLE', optional: true },
  revenueGrowth: { type: 'DOUBLE', optional: true },
  debtToEquity: { type: 'DOUBLE', optional: true },

  // Technical indicators
  sma20: { type: 'DOUBLE', optional: true },
  sma50: { type: 'DOUBLE', optional: true },
  ema20: { type: 'DOUBLE', optional: true },
  rsi14: { type: 'DOUBLE', optional: true },
  atr14: { type: 'DOUBLE', optional: true },
  bollingerUpper: { type: 'DOUBLE', optional: true },
  bollingerLower: { type: 'DOUBLE', optional: true },
});

// -------------------- API FETCH --------------------
async function fetchOHLCV(symbol, timeframe, from, to) {
  try {
    const timespanMap = { '15min':'minute','1hour':'hour','4hour':'hour','1day':'day','1week':'week' };
    const multiplierMap = { '15min':15,'1hour':1,'4hour':4,'1day':1,'1week':1 };
    const timespan = timespanMap[timeframe], multiplier = multiplierMap[timeframe];

    let allResults = [];
    let nextUrl = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${process.env.POLYGON_API_KEY}`;

    while (nextUrl) {
      const response = await axios.get(nextUrl);
      const results = response.data.results || [];
      allResults = allResults.concat(results);

      if (response.data.next_url) {
        nextUrl = response.data.next_url + `&apiKey=${process.env.POLYGON_API_KEY}`;
      } else {
        nextUrl = null;
      }
    }
    return allResults;
  } catch (err) {
    console.warn(`⚠️ Failed API fetch for ${symbol} ${timeframe}: ${err.message}`);
    return [];
  }
}

// -------------------- FETCH FUNDAMENTALS --------------------
const fundamentalsCache = {};
async function fetchFundamentals(symbol) {
  if (fundamentalsCache[symbol]) return fundamentalsCache[symbol];

  try {
    const url = `https://api.polygon.io/v3/reference/tickers/${symbol}?apiKey=${process.env.POLYGON_API_KEY}`;
    const response = await axios.get(url);
    const data = response.data.results || {};
    const fundamentals = {
      marketCap: data.market_cap || null,
      peRatio: data.pe_ratio || null,
      dividendYield: data.dividend_yield || null,
      revenueGrowth: data.revenue_growth || null,
      debtToEquity: data.debt_to_equity || null
    };
    fundamentalsCache[symbol] = fundamentals;
    return fundamentals;
  } catch (err) {
    console.warn(`⚠️ Failed fundamentals fetch for ${symbol}: ${err.message}`);
    const fallback = { marketCap: null, peRatio: null, dividendYield: null, revenueGrowth: null, debtToEquity: null };
    fundamentalsCache[symbol] = fallback;
    return fallback;
  }
}

// -------------------- COMPUTE INDICATORS --------------------
async function computeIndicators(data) {
  if (!data || data.length < 20) return data.map(d => ({ ...d }));

  const close = data.map(d => d.c);
  const high = data.map(d => d.h);
  const low = data.map(d => d.l);
  const volume = data.map(d => d.v);

  const [sma20] = await tulind.indicators.sma.indicator([close], [20]);
  const [sma50] = await tulind.indicators.sma.indicator([close], [50]);
  const [ema20] = await tulind.indicators.ema.indicator([close], [20]);
  const [rsi14] = await tulind.indicators.rsi.indicator([close], [14]);
  const [atr14] = await tulind.indicators.atr.indicator([high, low, close], [14]);
  const [bbUpper, bbLower] = await tulind.indicators.bbands.indicator([close], [20, 2]);

  const offset = close.length - sma20.length;
  return data.map((d, i) => ({
    ...d,
    sma20: i >= offset ? sma20[i - offset] : null,
    sma50: i >= close.length - sma50.length ? sma50[i - (close.length - sma50.length)] : null,
    ema20: i >= offset ? ema20[i - offset] : null,
    rsi14: i >= close.length - rsi14.length ? rsi14[i - (close.length - rsi14.length)] : null,
    atr14: i >= close.length - atr14.length ? atr14[i - (close.length - atr14.length)] : null,
    bollingerUpper: i >= offset ? bbUpper[i - offset] : null,
    bollingerLower: i >= offset ? bbLower[i - offset] : null
  }));
}

// -------------------- SAVE PARQUET --------------------
async function saveOHLCVParquet(symbol, timeframe, data, fundamentals) {
  if (!data || data.length === 0) return false;
  const localDir = path.join(OUTPUT_DIR, timeframe);
  await fs.ensureDir(localDir);
  const filePath = path.join(localDir, `${symbol}.parquet`);

  data = await computeIndicators(data);

  let writer;
  if (await fs.pathExists(filePath)) {
    writer = await parquet.ParquetWriter.openFile(schema, filePath, { append: true });
  } else {
    writer = await parquet.ParquetWriter.openFile(schema, filePath);
  }

  for (const d of data) {
    await writer.appendRow({
      ts: new Date(d.t),
      o: d.o,
      h: d.h,
      l: d.l,
      c: d.c,
      v: d.v,
      n: d.n,
      vw: d.vw,
      adjClose: d.c,
      marketCap: fundamentals.marketCap,
      peRatio: fundamentals.peRatio,
      dividendYield: fundamentals.dividendYield,
      revenueGrowth: fundamentals.revenueGrowth,
      debtToEquity: fundamentals.debtToEquity,
      sma20: d.sma20,
      sma50: d.sma50,
      ema20: d.ema20,
      rsi14: d.rsi14,
      atr14: d.atr14,
      bollingerUpper: d.bollingerUpper,
      bollingerLower: d.bollingerLower
    });
  }
  await writer.close();
  return true;
}

// -------------------- DOWNLOAD QUEUE --------------------
async function runDownloadQueue(tasks, progress) {
  return new Promise((resolve) => {
    let index = 0;
    const total = tasks.length;
    totalTasks = total;

    const startNext = async () => {
      if (index >= total) { if(activeDownloads===0) resolve(); return; }

      const task = tasks[index++];
      activeDownloads++;
      const { symbol, timeframe, from, to, key } = task;

      const data = await fetchOHLCV(symbol, timeframe, from, to);
      const fundamentals = await fetchFundamentals(symbol); // fetched once per symbol
      const saved = await saveOHLCVParquet(symbol, timeframe, data, fundamentals);

      if (saved) progress.completed[key] = true;
      completed++;

      if (completed % 50 === 0 || saved) {
        console.log(`📊 ${completed}/${total} (${((completed/total)*100).toFixed(2)}%) — ${symbol} ${timeframe}`);
        await saveProgress(progress);
      }
      activeDownloads--;
      startNext();
    };

    for (let i=0;i<MAX_CONCURRENT_DOWNLOADS;i++) startNext();
  });
}

// -------------------- PARQUET READER UTILITIES --------------------
async function readOHLCV(symbols, timeframe) {
  const results = {};
  for (const symbol of symbols) {
    const filePath = path.join(OUTPUT_DIR, timeframe, `${symbol}.parquet`);
    if (!await fs.pathExists(filePath)) continue;

    const reader = await parquet.ParquetReader.openFile(filePath);
    const cursor = reader.getCursor();
    const rows = [];
    let row;
    while (row = await cursor.next()) rows.push(row);
    await reader.close();
    results[symbol] = rows;
  }
  return results;
}

// -------------------- MAIN --------------------
async function main() {
  const progress = await loadProgress();

  if (!await fs.pathExists(STOCKS_FILE)) {
    console.error("❌ Stocks CSV file not found.");
    process.exit(1);
  }

  const csvData = await fs.readFile(STOCKS_FILE, 'utf8');
  const symbols = csvData.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  console.log('Building tasks...');
  const tasks = [];
  const today = new Date();
  const to = today.toISOString().slice(0,10);

  for (const symbol of symbols) {
    for (const timeframe of TIMEFRAMES) {
      const filePath = path.join(OUTPUT_DIR, timeframe, `${symbol}.parquet`);
      let fromDate;

      if (await fs.pathExists(filePath)) {
        const reader = await parquet.ParquetReader.openFile(filePath);
        const cursor = reader.getCursor();
        let row, lastTs;
        while (row = await cursor.next()) lastTs = row.ts;
        fromDate = lastTs ? new Date(lastTs) : new Date(today.getFullYear()-1, today.getMonth(), today.getDate());
        await reader.close();
      } else {
        fromDate = new Date(today.getFullYear()-1, today.getMonth(), today.getDate());
      }

      fromDate.setDate(fromDate.getDate() + 1);
      const from = fromDate.toISOString().slice(0,10);
      const key = `${symbol}_${timeframe}`;
      if (progress.completed[key]) continue;

      tasks.push({ symbol, timeframe, from, to, key });
    }
  }

  console.log(`Total tasks to process: ${tasks.length.toLocaleString()}`);
  const startTime = Date.now();
  await runDownloadQueue(tasks, progress);
  const duration = ((Date.now() - startTime)/1000/60).toFixed(2);
  await saveProgress(progress);
  console.log(`✅ All downloads complete in ${duration} minutes.`);
}

// -------------------- EXPORT READER FOR BACKTESTING --------------------
module.exports = {
  fetchOHLCV,
  saveOHLCVParquet,
  readOHLCV
};

main().catch(err => console.error('❌ Fatal error:', err));
