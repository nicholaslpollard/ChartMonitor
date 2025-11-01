// decisionSheetMaker.js
import fs from 'fs';
import path from 'path';
import parquet from 'parquetjs-lite';

/**
 * Helper: categorize RSI
 */
function categorizeRSI(rsi) {
  if (rsi < 30) return 'oversold';
  if (rsi > 70) return 'overbought';
  return 'neutral';
}

/**
 * Helper: categorize Bollinger position
 */
function categorizeBollinger(latestPrice, upper, lower) {
  if (latestPrice < lower) return 'below';
  if (latestPrice > upper) return 'above';
  return 'inside';
}

/**
 * Helper: categorize ATR relative to price
 */
function categorizeATR(atr, price) {
  const pct = (atr / price) * 100;
  if (pct < 0.5) return 'low';
  if (pct < 1.5) return 'medium';
  return 'high';
}

/**
 * Helper: categorize ADX
 */
function categorizeADX(adx) {
  if (adx < 20) return 'weak';
  if (adx < 40) return 'moderate';
  return 'strong';
}

/**
 * Generate option scenarios
 */
function generateOptionScenarios(option) {
  const types = [option.type || 'call'];
  const moneynessLevels = ['ITM', 'ATM', 'OTM'];
  const ivLevels = ['High', 'Medium', 'Low'];
  const statusTypes = ['Overpriced', 'Underpriced', 'Fair Value'];
  const spreadLevels = ['Narrow', 'Wide'];
  const liquidityLevels = ['Low', 'Medium', 'High'];

  const scenarios = [];

  for (const type of types) {
    for (const moneyness of moneynessLevels) {
      for (const iv of ivLevels) {
        for (const status of statusTypes) {
          for (const spread of spreadLevels) {
            for (const liquidity of liquidityLevels) {
              scenarios.push({
                ...option,
                type,
                moneyness,
                iv,
                status,
                spread,
                liquidity,
                diffCategory: parseFloat(option.diffPct),
                suggestedAction: generateOptionAction({
                  ...option,
                  type,
                  moneyness,
                  iv,
                  status,
                  spread,
                  liquidity
                }).suggestedAction
              });
            }
          }
        }
      }
    }
  }

  return scenarios;
}

/**
 * Generate stock scenarios with all technical factors
 */
function generateStockScenarios(stock) {
  const signals = ['LONG', 'SHORT', 'HOLD'];
  const riskLevels = ['Low', 'Medium', 'High'];

  const scenarios = [];

  for (const signal of signals) {
    for (const risk of riskLevels) {
      // Iterate all timeframe trends
      const timeframes = Object.keys(stock.trendInfo || {});
      const trendPermutations = timeframes.map(tf => {
        const info = stock.trendInfo[tf];
        return {
          timeframe: tf,
          trend: info?.trend || 'sideways',
          rsiCategory: categorizeRSI(info?.rsi || 50)
        };
      });

      // ATR, Bollinger, ADX
      const atrCategory = categorizeATR(stock.indicators?.atr || 0.5, stock.indicators?.latestPrice || 1);
      const bollCategory = categorizeBollinger(
        stock.indicators?.latestPrice || 0,
        stock.indicators?.boll?.upper || 0,
        stock.indicators?.boll?.lower || 0
      );
      const adxCategory = categorizeADX(stock.indicators?.adx || 20);

      scenarios.push(generateStockAction({
        ...stock,
        stockSignal: signal,
        stockRiskLevel: risk,
        trendPermutations,
        atrCategory,
        bollCategory,
        adxCategory
      }));
    }
  }

  return scenarios;
}

/**
 * Build full decision tree for all alerts
 */
function buildFullDecisionTree(alerts) {
  let decisionTree = [];

  alerts.forEach(alert => {
    if (alert.type === 'call' || alert.type === 'put') {
      decisionTree = decisionTree.concat(generateOptionScenarios(alert));
    }
    if (alert.stockSignal || alert.indicators) {
      decisionTree = decisionTree.concat(generateStockScenarios(alert));
    }
  });

  return decisionTree;
}

// --- Load alerts ---
const alertsPath = path.join('.', 'log', 'alerts.json');
if (!fs.existsSync(alertsPath)) {
  console.error('❌ alerts.json not found!');
  process.exit(1);
}
const alertsData = JSON.parse(fs.readFileSync(alertsPath, 'utf-8'));

// --- Build tree ---
const decisionTree = buildFullDecisionTree(alertsData);
console.log(`✅ Total decision nodes generated: ${decisionTree.length}`);

// --- Save as JSON ---
const jsonPath = path.join('.', 'decisionSheet.json');
fs.writeFileSync(jsonPath, JSON.stringify(decisionTree, null, 2));
console.log(`✅ Saved JSON decision sheet to ${jsonPath}`);

// --- Save as Parquet for large dataset ---
(async () => {
  const schema = new parquet.ParquetSchema({
    symbol: { type: 'UTF8' },
    type: { type: 'UTF8', optional: true },
    strike: { type: 'DOUBLE', optional: true },
    expiration: { type: 'UTF8', optional: true },
    diffPct: { type: 'DOUBLE', optional: true },
    status: { type: 'UTF8', optional: true },
    moneyness: { type: 'UTF8', optional: true },
    iv: { type: 'UTF8', optional: true },
    spread: { type: 'UTF8', optional: true },
    liquidity: { type: 'UTF8', optional: true },
    suggestedAction: { type: 'UTF8', optional: true },
    stockSignal: { type: 'UTF8', optional: true },
    stockTrend: { type: 'UTF8', optional: true },
    stockRiskLevel: { type: 'UTF8', optional: true },
    stockExpectedMove: { type: 'DOUBLE', optional: true },
    entry: { type: 'UTF8', optional: true },
    stopLoss: { type: 'UTF8', optional: true },
    takeProfit: { type: 'UTF8', optional: true },
    atrCategory: { type: 'UTF8', optional: true },
    bollCategory: { type: 'UTF8', optional: true },
    adxCategory: { type: 'UTF8', optional: true },
    trendPermutations: { type: 'UTF8', optional: true }
  });

  const parquetPath = path.join('.', 'decisionSheet.parquet');
  const writer = await parquet.ParquetWriter.openFile(schema, parquetPath);

  for (const node of decisionTree) {
    await writer.appendRow({
      ...node,
      trendPermutations: JSON.stringify(node.trendPermutations || [])
    });
  }

  await writer.close();
  console.log(`✅ Saved Parquet decision sheet to ${parquetPath}`);
})();
