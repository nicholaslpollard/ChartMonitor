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
const alertsTxtPath = path.join(__dirname, '..', '..', 'Chart Monitor', 'stock_strat_test', 'alerts.txt');

// Ensure folders exist
if (!fs.existsSync(path.dirname(resultsPath))) fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
if (!fs.existsSync(path.dirname(alertsTxtPath))) fs.mkdirSync(path.dirname(alertsTxtPath), { recursive: true });

// ---- Load Backtester Results ----
let backtesterResults = [];
if (fs.existsSync(backtesterLogPath)) backtesterResults = JSON.parse(fs.readFileSync(backtesterLogPath, 'utf-8'));
else { console.error('Backtester results file missing!'); process.exit(1); }

// ---- Load Optionable Stocks ----
let optionableSymbols = [];
if (fs.existsSync(optionableCsvPath)) {
  const csvData = fs.readFileSync(optionableCsvPath, 'utf-8');
  const records = csvParse(csvData, { columns: true, skip_empty_lines: true });
  optionableSymbols = records.map(r => r.Symbol);
} else { console.error('Optionable stocks CSV missing!'); process.exit(1); }

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

// ---- Rate limiter (55 calls per minute) ----
const wait = ms => new Promise(res => setTimeout(res, ms));
let apiCallCount = 0;
async function rateLimitedCall(fn) {
  if (apiCallCount >= 55) {
    await wait(60000); // wait 1 minute
    apiCallCount = 0;
  }
  apiCallCount++;
  return fn();
}

// ---- Helper: Get Current Price ----
async function getCurrentPrice(symbol) {
  return rateLimitedCall(() => new Promise((resolve, reject) => {
    finnhubClient.quote(symbol, (error, data) => {
      if (error) return reject(error);
      resolve(data.c);
    });
  }));
}

// ---- Helper: Get Historical Data ----
async function getHistoricalData(symbol, resolution = '15', fromDaysAgo = 30) {
  return rateLimitedCall(() => {
    const to = Math.floor(Date.now() / 1000);
    const from = to - fromDaysAgo * 24 * 60 * 60;
    return new Promise((resolve, reject) => {
      finnhubClient.stockCandles(symbol, resolution, from, to, (error, data) => {
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
  });
}

// ---- Helper: Risk Score ----
function calculateRiskScore(atr, currentPrice) {
  let score = (atr / currentPrice) * 100 * 2;
  score = Math.min(100, Math.max(0, score));
  let level = '';
  if (score <= 25) level = 'Low';
  else if (score <= 50) level = 'Medium';
  else if (score <= 75) level = 'High';
  else level = 'Very High';
  return { score: score.toFixed(1), level };
}

// ---- Helper: Interpret Technical Indicators ----
function interpretIndicators({ signal, rsi, adx, trend, atr, expectedMovePercent, stopLoss, takeProfit, currentPrice }) {
  let interpretation = '';
  if (signal === 'long') {
    interpretation += `Bullish momentum detected `;
    interpretation += adx > 25 ? `with strong trend (ADX ${adx.toFixed(1)}). ` : `trend strength moderate (ADX ${adx.toFixed(1)}). `;
  } else if (signal === 'short') {
    interpretation += `Bearish pressure detected `;
    interpretation += adx > 25 ? `with strong downward trend (ADX ${adx.toFixed(1)}). ` : `trend strength moderate (ADX ${adx.toFixed(1)}). `;
  }

  if (rsi > 70) interpretation += `RSI ${rsi.toFixed(1)} overbought. `;
  else if (rsi < 30) interpretation += `RSI ${rsi.toFixed(1)} oversold. `;
  else interpretation += `RSI ${rsi.toFixed(1)} neutral. `;

  interpretation += atr > currentPrice * 0.02 ? `ATR ${atr.toFixed(2)} elevated volatility. ` : `ATR ${atr.toFixed(2)} normal volatility. `;
  interpretation += `Expected movement ~${expectedMovePercent.toFixed(2)}%. `;

  const entries = signal === 'long' ? [currentPrice - atr * 0.5, currentPrice] : [currentPrice, currentPrice + atr * 0.5];
  const positions = ['Full', 'Half', 'Quarter'];
  interpretation += `Entries: `;
  entries.forEach((entry, i) => { interpretation += `${positions[i] || 'Scaled'} at $${entry.toFixed(2)}, `; });
  interpretation = interpretation.slice(0, -2) + '. ';

  const risk = calculateRiskScore(atr, currentPrice);
  interpretation += `Stop: $${stopLoss.toFixed(2)}, Take: $${takeProfit.toFixed(2)}. `;
  interpretation += `Risk: ${risk.level} (${risk.score}/100). `;

  return { text: interpretation.trim(), risk, signal };
}

// ---- Main Stock Monitoring (Multi-Timeframe Summary) ----
const timeframes = ['15', '60', 'D']; // 15-min, 1-hour, daily

async function monitorStocks() {
  console.log(`Monitoring ${backtesterResults.length} stocks across ${timeframes.join(', ')} timeframes...\n`);
  fs.writeFileSync(alertsTxtPath, '');

  for (const stock of backtesterResults) {
    const { symbol, strategy: strategyName } = stock;
    if (!optionableSymbols.includes(symbol)) continue;
    const strategyFunc = strategies[strategyName];
    if (!strategyFunc) { console.warn(`Strategy ${strategyName} not found for ${symbol}`); continue; }

    const currentPrice = await getCurrentPrice(symbol);
    const timeframeResults = [];

    for (const tf of timeframes) {
      try {
        const candles = await getHistoricalData(symbol, tf, tf === 'D' ? 365 : 30);
        if (!candles || candles.length < 20) continue;

        const prices = candles.map(c => c.close);
        const volumes = candles.map(c => c.volume);
        const signal = strategyFunc(prices, candles, volumes);
        if (!signal) continue;

        const atr = ATR(candles);
        const rsiValue = RSI(prices, 14);
        const adxValue = ADX(candles);
        const trend = trendDirection(prices);

        const stopLoss = signal === 'long' ? currentPrice - atr : currentPrice + atr;
        const takeProfit = signal === 'long' ? currentPrice + 2 * atr : currentPrice - 2 * atr;
        const expectedMovePercent = ((takeProfit - currentPrice) / currentPrice) * 100;

        const { text: interpretation, risk } = interpretIndicators({
          signal, rsi: rsiValue, adx: adxValue, trend, atr,
          expectedMovePercent, stopLoss, takeProfit, currentPrice
        });

        timeframeResults.push({ tf, interpretation, risk, signal, stopLoss, takeProfit });

      } catch (err) {
        console.error(`Error processing ${symbol} at ${tf} timeframe: ${err.message}`);
      }
    }

    // ---- Combine timeframe signals to give overall outlook ----
    if (timeframeResults.length === 0) continue;

    // Filter out High/Very High risk
    const filteredResults = timeframeResults.filter(r => r.risk.level === 'Low' || r.risk.level === 'Medium');
    if (filteredResults.length === 0) continue;

    const signals = filteredResults.map(r => r.signal);
    let overallSignal = 'neutral';
    if (signals.every(s => s === 'long')) overallSignal = 'long';
    else if (signals.every(s => s === 'short')) overallSignal = 'short';
    else if (signals.includes('long')) overallSignal = 'mixed bullish';
    else if (signals.includes('short')) overallSignal = 'mixed bearish';

    const summaryText = `Multi-timeframe outlook: ${overallSignal}. Trends per timeframe: ${filteredResults.map(r => `${r.tf}=${r.signal}`).join(', ')}.`;

    // Save alerts per timeframe
    for (const r of filteredResults) {
      const alert = {
        symbol, strategy: strategyName, signal: r.signal, currentPrice,
        stopLoss: Number(r.stopLoss.toFixed(2)), takeProfit: Number(r.takeProfit.toFixed(2)),
        timeframe: r.tf, summary: r.interpretation, riskScore: Number(r.risk.score), riskLevel: r.risk.level,
        overallOutlook: summaryText,
        timestamp: new Date().toISOString()
      };
      alertResults.push(alert);
      fs.appendFileSync(alertsTxtPath, `⚡ ${symbol} | ${r.tf}-timeframe | $${currentPrice.toFixed(2)} | ${r.interpretation}\n`);
    }

    // Append the overall summary
    fs.appendFileSync(alertsTxtPath, `📝 ${symbol} | ${summaryText}\n\n`);
    console.log(`📝 ${symbol} | ${summaryText}\n`);
  }

  fs.writeFileSync(resultsPath, JSON.stringify(alertResults, null, 2));
  console.log('✅ Stock monitoring complete. Alerts saved to JSON and TXT.');
}

// ---- Run Monitor ----
monitorStocks();

