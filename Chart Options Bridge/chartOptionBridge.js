require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ---- Paths ----
const stockLivePath = path.join(__dirname, '..', 'stock_strat_test', 'log', 'livedata.json');
const stockAlertPath = path.join(__dirname, '..', 'stock_strat_test', 'log', 'alerts.json');
const optionAlertPath = path.join(__dirname, '..', 'option-chain-test', 'log', 'alerts.json');

// ---- Output Paths ----
const bridgeDir = path.join(__dirname, '..', 'Chart Options Bridge', 'log');
const urgentAlertPath = path.join(bridgeDir, 'urgentAlert.json');
const stockOnlyPath = path.join(bridgeDir, 'stockAlert.json');
const optionOnlyPath = path.join(bridgeDir, 'optionAlert.json');

if (!fs.existsSync(bridgeDir)) fs.mkdirSync(bridgeDir, { recursive: true });

// ---- Helper: Categorization ----
function categorizeRSI(rsi) {
  if (rsi < 30) return 'oversold';
  if (rsi > 70) return 'overbought';
  return 'neutral';
}
function categorizeADX(adx) {
  if (adx < 20) return 'weak';
  if (adx < 40) return 'moderate';
  return 'strong';
}

// ---- Fetch News & Sentiment from Polygon.io ----
async function fetchNewsSentiment(ticker) {
  try {
    const apiKey = process.env.POLYGON_API_KEY;
    if (!apiKey) return [];
    const res = await axios.get('https://api.polygon.io/v2/reference/news', {
      params: { ticker, limit: 5, sort: 'published_utc', apiKey },
    });
    return (
      res.data.results?.map((n) => ({
        title: n.title,
        sentiment: n.sentiment || 'neutral',
        published: n.published_utc,
      })) || []
    );
  } catch (err) {
    console.error(`❌ News fetch failed for ${ticker}:`, err.message);
    return [];
  }
}

// ---- Compute confidence score ----
function computeConfidence({ stock, option, indicators, news }) {
  let score = 0;

  // --- Trend alignment ---
  if (stock && option && stock.signal && option.type) {
    const bothUp =
      (stock.signal === 'LONG' || stock.signal === 'BUY') && option.type === 'call';
    const bothDown =
      (stock.signal === 'SHORT' || stock.signal === 'SELL') && option.type === 'put';
    if (bothUp || bothDown) score += 0.5;
  }

  // --- Indicators ---
  if (indicators) {
    const { rsi, adx } = indicators;
    if (rsi && ((rsi > 55 && stock?.signal === 'LONG') || (rsi < 45 && stock?.signal === 'SHORT')))
      score += 0.2;
    if (adx && adx > 25) score += 0.1;
  }

  // --- News sentiment ---
  if (news.length > 0) {
    const pos = news.filter((n) => n.sentiment === 'positive').length;
    const neg = news.filter((n) => n.sentiment === 'negative').length;
    if (pos > neg && stock?.signal === 'LONG') score += 0.2;
    if (neg > pos && stock?.signal === 'SHORT') score += 0.2;
  }

  return Math.min(score, 1);
}

// ---- Decision Builder ----
function buildDecision(symbol, stock, option, indicators, news) {
  const confidence = computeConfidence({ stock, option, indicators, news });
  const aligned =
    stock &&
    option &&
    ((stock.signal === 'LONG' && option.type === 'call') ||
      (stock.signal === 'SHORT' && option.type === 'put'));

  let suggestedAction = 'HOLD / REVIEW';
  if (aligned && confidence > 0.7)
    suggestedAction =
      stock.signal === 'LONG'
        ? 'BUY STOCK + BUY CALL OPTION'
        : 'SHORT STOCK + BUY PUT OPTION';
  else if (stock && !option)
    suggestedAction = stock.signal === 'LONG' ? 'BUY STOCK' : 'SHORT STOCK';
  else if (option && !stock)
    suggestedAction =
      option.type === 'call'
        ? 'BUY CALL OPTION'
        : option.type === 'put'
        ? 'BUY PUT OPTION'
        : 'HOLD OPTION';

  // ---- Additional info for review ----
  const currentPrice = indicators?.latestPrice || null;
  const tradeDuration = stock?.durationMinutes || null;
  const stopLoss = stock?.stopLoss || null;
  const takeProfit = stock?.takeProfit || null;
  const percentMove = stock?.percentMove || null;
  const newsHeadlines = news.map(n => ({ title: n.title, sentiment: n.sentiment }));
  const optionContracts =
    option?.contracts?.map(c => ({
      expiration: c.expiration,
      strike: c.strike,
      status: c.status,
      bid: c.bid,
      ask: c.ask,
    })) || [];

  return {
    symbol,
    alignment: aligned ? 'STRONG' : 'PARTIAL',
    stockSignal: stock?.signal || null,
    optionType: option?.type || null,
    optionStatus: option?.status || null,
    rsi: indicators?.rsi,
    adx: indicators?.adx,
    currentPrice,
    tradeDuration,
    stopLoss,
    takeProfit,
    percentMove,
    newsSentiment:
      newsHeadlines.reduce((acc, n) => acc + (n.sentiment === 'positive' ? 1 : n.sentiment === 'negative' ? -1 : 0), 0) > 0
        ? 'positive'
        : newsHeadlines.reduce((acc, n) => acc + (n.sentiment === 'positive' ? 1 : n.sentiment === 'negative' ? -1 : 0), 0) < 0
        ? 'negative'
        : 'neutral',
    newsHeadlines,
    optionContracts,
    confidence: confidence.toFixed(2),
    suggestedAction,
    timestamp: new Date().toISOString(),
  };
}

// ---- Main Processor ----
async function processAllAlerts() {
  const stockLive = fs.existsSync(stockLivePath)
    ? JSON.parse(fs.readFileSync(stockLivePath, 'utf-8'))
    : {};
  const stockAlerts = fs.existsSync(stockAlertPath)
    ? JSON.parse(fs.readFileSync(stockAlertPath, 'utf-8'))
    : [];
  const optionAlerts = fs.existsSync(optionAlertPath)
    ? JSON.parse(fs.readFileSync(optionAlertPath, 'utf-8'))
    : [];

  const urgent = [];
  const stockOnly = [];
  const optionOnly = [];

  const symbols = new Set([
    ...stockAlerts.map((s) => s.symbol),
    ...optionAlerts.map((o) => o.symbol),
  ]);

  for (const symbol of symbols) {
    const stock = stockAlerts.find((s) => s.symbol === symbol);
    const option = optionAlerts.find((o) => o.symbol === symbol);
    const indicators = stockLive[symbol]?.indicators || {};
    const news = await fetchNewsSentiment(symbol);
    const decision = buildDecision(symbol, stock, option, indicators, news);

    if (stock && option && decision.alignment === 'STRONG' && decision.confidence > 0.7) {
      urgent.push(decision);
    } else if (stock && !option) {
      stockOnly.push(decision);
    } else if (option && !stock) {
      optionOnly.push(decision);
    }
  }

  // ---- Write results ----
  fs.writeFileSync(urgentAlertPath, JSON.stringify(urgent, null, 2));
  fs.writeFileSync(stockOnlyPath, JSON.stringify(stockOnly, null, 2));
  fs.writeFileSync(optionOnlyPath, JSON.stringify(optionOnly, null, 2));

  console.log(`✅ Urgent Alerts: ${urgent.length}`);
  console.log(`📈 Stock Alerts: ${stockOnly.length}`);
  console.log(`📊 Option Alerts: ${optionOnly.length}`);
  console.log('Finished writing to Chart Options Bridge/log/');
}

// ---- Run ----
processAllAlerts();
