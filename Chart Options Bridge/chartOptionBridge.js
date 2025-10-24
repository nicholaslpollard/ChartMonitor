// chartOptionBridge.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// ---- Paths ----
const decisionTablePath = path.join(__dirname, 'decisionSheets.json');
const stockAlertsPath = path.join(__dirname, '..', 'stock_strat_test', 'log', 'results.json');

// ---- Load Decision Table ----
const decisionTable = JSON.parse(fs.readFileSync(decisionTablePath, 'utf-8'));

// ---- Helper to pick suggested action from decision table ----
function getSuggestedAction(optData) {
  for (const scenario of decisionTable) {
    if (
      optData.diffPct >= scenario.diffPctMin &&
      optData.diffPct <= scenario.diffPctMax &&
      optData.volRatio >= scenario.volRatioMin &&
      optData.volRatio <= scenario.volRatioMax &&
      optData.spreadPct >= scenario.spreadPctMin &&
      optData.spreadPct <= scenario.spreadPctMax &&
      optData.openInterest >= scenario.liquidityMin &&
      optData.openInterest <= scenario.liquidityMax &&
      scenario.type.toLowerCase() === optData.type.toLowerCase() &&
      scenario.moneyness === optData.moneyness
    ) {
      return scenario.suggestedAction;
    }
  }
  return 'Hold / Review';
}

// ---- Analyze Options ----
async function analyzeOptions(symbol, underlyingPrice, histVol, fetchOptionChain, blackScholes) {
  const chain = await fetchOptionChain(symbol);
  if (!chain) return [];

  const r = 0.05; // risk-free rate
  const Tdays = 30; // default for missing days to expiration
  const flaggedOptions = [];

  const allStrikes = [
    ...(chain.callExpDateMap ? Object.values(chain.callExpDateMap) : []),
    ...(chain.putExpDateMap ? Object.values(chain.putExpDateMap) : [])
  ].flatMap(e => Object.values(e).flat());

  for (const opt of allStrikes) {
    const type = opt.putCall.toLowerCase();
    const strike = parseFloat(opt.strikePrice);
    const lastPrice = parseFloat(opt.last);
    const iv = parseFloat(opt.impliedVolatility) || 0;
    const bid = parseFloat(opt.bid) || 0;
    const ask = parseFloat(opt.ask) || 0;
    const openInterest = parseInt(opt.openInterest) || 0;
    const daysToExp = (opt.daysToExpiration || Tdays);
    const T = daysToExp / 252;

    const sigma = iv || histVol || 0.3;
    const theoPrice = blackScholes(type, underlyingPrice, strike, T, r, sigma);
    if (!theoPrice || lastPrice === 0) continue;

    const diffPct = ((theoPrice - lastPrice) / lastPrice) * 100;
    if (Math.abs(diffPct) < 25) continue;

    const volRatio = histVol ? iv / histVol : null;
    const spreadPct = lastPrice ? ((ask - bid) / lastPrice) * 100 : null;

    let moneyness = 'OTM';
    if ((type === 'call' && underlyingPrice > strike) || (type === 'put' && underlyingPrice < strike)) {
      moneyness = 'ITM';
    } else if (Math.abs(underlyingPrice - strike) / underlyingPrice <= 0.05) {
      moneyness = 'ATM';
    }

    const optionDataForDecision = { type, diffPct, volRatio, spreadPct, openInterest, moneyness };
    const suggestedAction = getSuggestedAction(optionDataForDecision);

    flaggedOptions.push({
      symbol,
      type,
      strike,
      expiration: opt.expirationDate,
      lastPrice,
      theoPrice: parseFloat(theoPrice.toFixed(2)),
      diffPct: parseFloat(diffPct.toFixed(2)),
      status: diffPct > 0 ? 'Undervalued' : 'Overvalued',
      histVol: parseFloat(histVol?.toFixed(4)) || null,
      iv: parseFloat(iv.toFixed(4)),
      volRatio: volRatio ? parseFloat(volRatio.toFixed(4)) : null,
      bid,
      ask,
      spreadPct: spreadPct ? parseFloat(spreadPct.toFixed(2)) : null,
      openInterest,
      suggestedAction
    });
  }

  return flaggedOptions;
}

// ---- Build HTML for Alerts ----
function buildOptionAlertEmail(flaggedOptions) {
  let html = `<h1>Option Alert</h1>`;
  flaggedOptions.forEach(opt => {
    html += `
      <h2>${opt.symbol} - ${opt.type.toUpperCase()} ${opt.strike} (${opt.status})</h2>
      <ul>
        <li>Last Price: ${opt.lastPrice}</li>
        <li>Theoretical Price: ${opt.theoPrice}</li>
        <li>Difference: ${opt.diffPct}%</li>
        <li>Suggested Action: <b>${opt.suggestedAction}</b></li>
        <li>IV: ${opt.iv}, Historical Volatility: ${opt.histVol}</li>
        <li>Vol Ratio (IV/HistVol): ${opt.volRatio}</li>
        <li>Bid: ${opt.bid}, Ask: ${opt.ask}, Spread%: ${opt.spreadPct}</li>
        <li>Open Interest: ${opt.openInterest}</li>
        <li>Expiration: ${opt.expiration}</li>
      </ul>
      <hr>`;
  });
  return html;
}

// ---- Save Alerts to Stock Log ----
function saveAlerts(flaggedOptions) {
  let existingAlerts = [];
  if (fs.existsSync(stockAlertsPath)) {
    try { existingAlerts = JSON.parse(fs.readFileSync(stockAlertsPath, 'utf-8')); }
    catch { existingAlerts = []; }
  }
  const updatedAlerts = existingAlerts.concat(flaggedOptions);
  fs.writeFileSync(stockAlertsPath, JSON.stringify(updatedAlerts, null, 2));
}

module.exports = { analyzeOptions, buildOptionAlertEmail, saveAlerts };
