const cron = require("node-cron");
const { getPriceData } = require("./services/dataService");
const { strategyCheck } = require("./services/strategyService");
const { riskManagement } = require("./services/riskService");
const { formatAlert } = require("./services/alertService");

// Symbols to monitor (added NVDA)
const symbols = ["AAPL", "MSFT", "NVDA"];

// In-memory log of all cycles
let signalLog = [];
const lastTradeIndices = {}; // track last trade index per symbol

// Optional: maximum log length
const MAX_LOG_LENGTH = 10000;

// Run trading checks
async function runChecks() {
  const timestamp = new Date().toISOString();
  console.log(`📊 Running strategy checks at ${timestamp}...`);

  try {
    // Fetch both 5-min and 1-hour data
    const data = await getPriceData(symbols, 100, ["5Min", "1Hour"]);

    const cycleResults = [];

    for (const sym of symbols) {
      const lowerCandles = data[sym]["5Min"].candles;
      const lowerPrices = data[sym]["5Min"].prices;
      const higherCandles = data[sym]["1Hour"].candles;

      lastTradeIndices[sym] = lastTradeIndices[sym] || -999;

      // Debug: log last few price points to confirm NVDA data
      console.log(`📈 ${sym} lower prices (last 5):`, lowerPrices.slice(-5));
      console.log(`📈 ${sym} higher candles (last 3):`, higherCandles.slice(-3));

      // Ultra-WR strategy check
      const signal = strategyCheck(
        sym,
        lowerPrices,
        lowerCandles,
        higherCandles,
        lastTradeIndices[sym],
        lowerCandles.length - 1,
        8 // cooldownBars
      );

      if (signal) lastTradeIndices[sym] = lowerCandles.length - 1;

      // Risk management
      const risk = riskManagement(sym, signal);
      if (risk && signal) {
        // Attach reasons and ATR for richer alert
        risk.reasons = signal.reasons;
        risk.atr = signal.atr;
      }
      const alert = formatAlert(risk);

      cycleResults.push({
        symbol: sym,
        signalGenerated: !!alert,
        alert: alert || null,
      });
    }

    // Save full cycle log
    signalLog.push({ timestamp, results: cycleResults });

    // Trim log if too long
    if (signalLog.length > MAX_LOG_LENGTH) {
      signalLog = signalLog.slice(-MAX_LOG_LENGTH);
    }

    // Log summary
    const generatedCount = cycleResults.filter(r => r.signalGenerated).length;
    if (generatedCount > 0) {
      console.log(`✅ Signals generated: ${generatedCount}`, cycleResults);
    } else {
      console.log("❌ No signals this cycle.", cycleResults);
    }
  } catch (err) {
    console.error("Error running strategy checks:", err);
  }
}

// Schedule every 1 minute
cron.schedule("* * * * *", runChecks);

// Export log
function getLog() {
  return signalLog;
}

module.exports = { runChecks, getLog };


