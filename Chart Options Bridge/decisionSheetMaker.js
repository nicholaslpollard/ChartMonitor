// decisionSheetMaker.js
import fs from 'fs';
import path from 'path';

/**
 * Generates a suggested action for an option based on all factors.
 */
function generateOptionAction(option) {
  const { diffPct, type, moneyness, iv, spread, liquidity } = option;

  let action = "";
  let riskLevel = "Medium";
  let entry = "Evaluate entry";
  let stopLoss = "Evaluate stop-loss";
  let takeProfit = "Evaluate take-profit";

  const diff = parseFloat(diffPct);

  // Base decision logic for diffPct
  if (diff > 50) {
    action = `Strong buy ${type} (extremely undervalued)`;
    riskLevel = "Medium";
  } else if (diff > 25) {
    action = `Buy ${type} (moderately undervalued)`;
    riskLevel = "Medium";
  } else if (diff >= 0) {
    action = `Consider ${type} (slightly undervalued)`;
    riskLevel = "Low";
  } else if (diff < 0) {
    action = `Caution: ${type} may be overpriced`;
    riskLevel = "High";
  }

  // Adjust based on IV
  if (iv === "High") riskLevel = "High";
  if (iv === "Low" && diff >= 0) riskLevel = "Low";

  // Adjust entry, stop-loss, and take-profit based on moneyness
  if (moneyness === "OTM") {
    entry = "Consider entering near market price";
    stopLoss = "Set tight stop-loss, ~25% from premium";
    takeProfit = "Consider taking profit at 50%-100% gain";
  } else if (moneyness === "ATM") {
    entry = "Enter carefully, monitor delta";
    stopLoss = "Set stop-loss ~20% from premium";
    takeProfit = "Target 40%-80% gain";
  } else if (moneyness === "ITM") {
    entry = "Entry is safer, monitor underlying stock trend";
    stopLoss = "Set stop-loss ~15% from premium";
    takeProfit = "Target 30%-60% gain";
  }

  // Consider spread & liquidity
  if (spread === "Wide" || liquidity === "Low") {
    riskLevel = "High";
    action += " (high risk due to liquidity/spread)";
    stopLoss += ", be prepared for slippage";
  }

  return {
    ...option,
    suggestedAction: action,
    riskLevel,
    entry,
    stopLoss,
    takeProfit
  };
}

/**
 * Generates a suggested action for a stock based on signal and trend
 */
function generateStockAction(stock) {
  const { stockSignal, stockTrend, stockRiskLevel, stockExpectedMove } = stock;

  let action = "";
  let riskLevel = stockRiskLevel;
  let entry = "Evaluate entry based on trend";
  let stopLoss = "Set stop-loss based on ATR or % of price";
  let takeProfit = "Set take-profit at expected move";

  if (stockSignal === "Buy") {
    action = `Long position suggested (trend: ${stockTrend})`;
    riskLevel = stockRiskLevel || "Medium";
    entry = `Enter near current spot price`;
    stopLoss = `Stop-loss ${stockExpectedMove ? `~${(stockExpectedMove / 2).toFixed(2)}` : ""} from entry`;
    takeProfit = `Take profit ~${stockExpectedMove ? stockExpectedMove.toFixed(2) : ""} above entry`;
  } else if (stockSignal === "Sell") {
    action = `Short position suggested (trend: ${stockTrend})`;
    riskLevel = stockRiskLevel || "Medium";
    entry = `Enter near current spot price`;
    stopLoss = `Stop-loss ${stockExpectedMove ? `~${(stockExpectedMove / 2).toFixed(2)}` : ""} above entry`;
    takeProfit = `Take profit ~${stockExpectedMove ? stockExpectedMove.toFixed(2) : ""} below entry`;
  } else {
    action = "Hold or monitor";
  }

  return {
    ...stock,
    suggestedAction: action,
    riskLevel,
    entry,
    stopLoss,
    takeProfit
  };
}

/**
 * Main function to generate a full decision tree for multiple stocks and options
 */
function buildDecisionTree(data) {
  return data.map(item => {
    if (item.type === "call" || item.type === "put") {
      return generateOptionAction(item);
    } else if (item.stockSignal) {
      return generateStockAction(item);
    } else {
      return { ...item, suggestedAction: "No recommendation", riskLevel: "Unknown" };
    }
  });
}

// Example placeholder data
const exampleData = [
  {
    symbol: "AAPL",
    spotPrice: "260.00",
    expiration: "2025-11-01",
    type: "call",
    strike: 270,
    marketPrice: "12.50",
    bsPrice: "10.00",
    diffPct: "25.00",
    status: "Overpriced",
    stockSignal: "Buy",
    stockTrend: "Up",
    stockRiskLevel: "Low",
    stockExpectedMove: 3.2
  },
  {
    symbol: "LCID",
    spotPrice: "18.48",
    expiration: "2025-10-31",
    type: "put",
    strike: 18,
    marketPrice: "0.44",
    bsPrice: "0.07",
    diffPct: "563.54",
    status: "Overpriced"
  }
];

// Build the tree
const decisionTree = buildDecisionTree(exampleData);

// Define output path relative to this script
const outputPath = path.join('.', 'decisionSheet.json');

// Save JSON
fs.writeFileSync(outputPath, JSON.stringify(decisionTree, null, 2));
console.log(`Decision tree generated and saved to ${outputPath}`);
