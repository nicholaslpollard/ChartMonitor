require('dotenv').config();
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

// Import the option analysis function
const { runOptionAnalysis } = require(path.join(__dirname, '..', 'option-chain-test', 'optionchaintest.js'));

// ---- Paths ----
const decisionTablePath = path.join(__dirname, 'decisionSheets.json');
const stockResultsPath = path.join(__dirname, '..', 'stock_strat_test', 'log', 'results.json');

const logDir = path.join(__dirname, 'log');
const logTxtPath = path.join(logDir, 'alerts.txt');
const logJsonPath = path.join(logDir, 'results.json');

// Ensure log folder exists
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// ---- Load Decision Table ----
const decisionTable = JSON.parse(fs.readFileSync(decisionTablePath, 'utf-8'));

// ---- Utility: get suggested action ----
function getSuggestedAction(opt) {
  for (const scenario of decisionTable) {
    if (scenario.type.toLowerCase() !== opt.type.toLowerCase()) continue;
    if (scenario.moneyness !== opt.moneyness) continue;

    let diffCategory = '';
    const diff = opt.diffPct;
    if (diff > 50) diffCategory = '>50';
    else if (diff > 25) diffCategory = '25-50';
    else if (diff > 0) diffCategory = '0-25';
    else if (diff > -25) diffCategory = '0-25';
    else if (diff > -50) diffCategory = '<-25';
    else diffCategory = '<-50';

    if (scenario.diffPct.includes(diffCategory)) return scenario.suggestedAction;
  }
  return 'Hold / Review';
}

// ---- Merge Stock & Option Data ----
function mergeStockOptionData(stockAlerts, optionAlerts) {
  const merged = [];
  const batchTimestamp = new Date().toISOString();
  for (const opt of optionAlerts) {
    const stock = stockAlerts.find(s => s.symbol === opt.symbol);
    if (!stock) continue;

    merged.push({
      ...opt,
      stockSignal: stock.signal,
      stockTrend: stock.trend,
      stockRiskLevel: stock.riskLevel,
      stockExpectedMove: stock.expectedMovePercent,
      suggestedAction: getSuggestedAction(opt),
      timestamp: new Date().toISOString(),
      batchTimestamp
    });
  }
  return merged;
}

// ---- Build HTML Email ----
function buildAlertEmail(mergedAlerts) {
  if (mergedAlerts.length === 0) return '';
  const batchTime = mergedAlerts[0].batchTimestamp;
  let html = `<h1>Stock & Option Alerts</h1>`;
  html += `<p><b>Batch Generated:</b> ${batchTime}</p><hr>`;
  mergedAlerts.forEach(alert => {
    html += `
      <h2>${alert.symbol} - ${alert.type.toUpperCase()} ${alert.strike} (${alert.status})</h2>
      <ul>
        <li>Alert Timestamp: ${alert.timestamp}</li>
        <li>Stock Signal: ${alert.stockSignal}</li>
        <li>Trend: ${alert.stockTrend}</li>
        <li>Risk Level: ${alert.stockRiskLevel}</li>
        <li>Expected Move: ${alert.stockExpectedMove}%</li>
        <li>Option Last Price: ${alert.marketPrice}</li>
        <li>Black-Scholes Price: ${alert.bsPrice}</li>
        <li>Difference %: ${alert.diffPct}%</li>
        <li>Type: ${alert.type}, Strike: ${alert.strike}, Expiration: ${alert.expiration}</li>
        <li>Status: ${alert.status}</li>
        <li>Suggested Action: <b>${alert.suggestedAction}</b></li>
      </ul>
      <hr>`;
  });
  return html;
}

// ---- Save Alerts to Logs ----
function saveAlertsToLogs(mergedAlerts) {
  let existingAlerts = [];
  if (fs.existsSync(logJsonPath)) {
    try { existingAlerts = JSON.parse(fs.readFileSync(logJsonPath, 'utf-8')); }
    catch { existingAlerts = []; }
  }
  const updatedAlerts = existingAlerts.concat(mergedAlerts);
  fs.writeFileSync(logJsonPath, JSON.stringify(updatedAlerts, null, 2));

  let txtContent = '';
  mergedAlerts.forEach(alert => {
    txtContent += `⚡ [${alert.timestamp}] ${alert.symbol} | ${alert.type.toUpperCase()} ${alert.strike} (${alert.status})\n`;
    txtContent += `Stock Signal: ${alert.stockSignal}, Trend: ${alert.stockTrend}, Risk: ${alert.stockRiskLevel}, Expected Move: ${alert.stockExpectedMove}%\n`;
    txtContent += `Option Last Price: ${alert.marketPrice}, BS Price: ${alert.bsPrice}, Diff%: ${alert.diffPct}%\n`;
    txtContent += `Suggested Action: ${alert.suggestedAction}\n`;
    txtContent += `Expiration: ${alert.expiration}\n`;
    txtContent += `-------------------------------------------\n`;
  });
  fs.writeFileSync(logTxtPath, txtContent);
}

// ---- Send Email ----
async function sendEmail(htmlContent) {
  if (!htmlContent) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER || 'nlpChartMonitor@gmail.com',
      pass: process.env.EMAIL_PASS
    }
  });

  const mailOptions = {
    from: 'nlpChartMonitor@gmail.com',
    to: 'nlpChartMonitor@gmail.com',
    subject: 'Stock & Option Alerts',
    html: htmlContent
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('✅ Alert email sent successfully!');
  } catch (err) {
    console.error('❌ Error sending email:', err.message);
  }
}

// ---- Queue System for Stock Alerts ----
const stockQueue = [];
let processing = false;

async function processQueue() {
  if (processing) return;
  processing = true;

  while (stockQueue.length > 0) {
    const stock = stockQueue.shift();
    console.log(`🔔 Processing stock: ${stock.symbol}`);
    try {
      const { allResults: optionResults, allAlerts: optionAlerts } = await runOptionAnalysis(stock.symbol);

      const merged = mergeStockOptionData([stock], optionAlerts);
      if (merged.length > 0) {
        saveAlertsToLogs(merged);
        const html = buildAlertEmail(merged);
        await sendEmail(html);
      }
    } catch (err) {
      console.error(`Error processing ${stock.symbol}:`, err.message);
    }

    // Respect 55 calls/min (~1.1s per stock)
    await new Promise(r => setTimeout(r, 1200));
  }

  processing = false;
}

// ---- Watch Stock Results ----
let processedSymbols = new Set();
fs.watch(stockResultsPath, async (eventType) => {
  if (eventType !== 'change') return;
  try {
    const allStockAlerts = JSON.parse(fs.readFileSync(stockResultsPath, 'utf-8'));
    const newAlerts = allStockAlerts.filter(a => (a.riskLevel === 'Low' || a.riskLevel === 'Medium') && !processedSymbols.has(a.symbol));
    for (const stock of newAlerts) {
      processedSymbols.add(stock.symbol);
      stockQueue.push(stock);
    }
    processQueue(); // Trigger processing if not already running
  } catch (err) {
    console.error('Error reading stock results:', err.message);
  }
});

console.log('📡 Chart Option Bridge listening for stock alerts...');
