require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");

const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const BASE_URL = "https://api.polygon.io";
const CONCURRENT_REQUESTS = 100;

if (!POLYGON_API_KEY) {
  console.error("❌ Missing POLYGON_API_KEY in .env");
  process.exit(1);
}

// ------------------- HELPERS -------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Reads a CSV file with headers: Symbol,Name,Exchange
 */
function readCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv({ skipLines: 0, separator: "," }))
      .on("data", (row) => {
        const symbol = (row.Symbol || row["Symbol "] || "").trim();
        const name = (row.Name || "").trim();
        const exchange = (row.Exchange || "").trim();
        if (symbol) rows.push({ Symbol: symbol, Name: name, Exchange: exchange });
      })
      .on("end", () => {
        console.log(`📄 Loaded ${rows.length} symbols from CSV.`);
        if (rows.length === 0)
          console.warn("⚠️ No symbols found! Check CSV headers or file content.");
        resolve(rows);
      })
      .on("error", (err) => {
        console.error("❌ Error reading CSV:", err);
        reject(err);
      });
  });
}

/**
 * Writes updated rows back to CSV, keeping headers intact
 */
function writeCSV(filePath, data) {
  const header = "Symbol,Name,Exchange\n";
  const body = data
    .map(r => `${r.Symbol},"${r.Name.replace(/"/g, '""')}",${r.Exchange}`)
    .join("\n");
  fs.writeFileSync(filePath, header + body);
  console.log(`💾 CSV updated (${data.length} symbols kept)`);
}

// ------------------- DATA FETCH -------------------
async function fetchSymbolData(symbol) {
  try {
    // 1️⃣ Metadata
    const metaRes = await axios.get(`${BASE_URL}/v3/reference/tickers/${symbol}`, {
      headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
    });

    const meta = metaRes.data.results;
    if (!meta) throw new Error("No metadata returned");

    const essentialMeta = {
      type: meta.type,
      primary_exchange: meta.primary_exchange,
      market: meta.market,
    };

    // 2️⃣ OHLCV (previous day's bar)
    let ohlcv = null;
    try {
      const ohlcvRes = await axios.get(`${BASE_URL}/v2/aggs/ticker/${symbol}/prev`, {
        headers: { Authorization: `Bearer ${POLYGON_API_KEY}` },
      });

      const ohlcvData = ohlcvRes.data.results?.[0];
      if (ohlcvData) {
        ohlcv = {
          open: ohlcvData.o,
          high: ohlcvData.h,
          low: ohlcvData.l,
          close: ohlcvData.c,
          volume: ohlcvData.v,
          timestamp: ohlcvData.t,
        };
      }
    } catch (ohlcvErr) {
      console.warn(`⚠️ Failed OHLCV for ${symbol}: ${ohlcvErr.message}`);
    }

    return { symbol, valid: true, meta: essentialMeta, ohlcv };
  } catch (err) {
    const reason = err.response?.data?.error || err.message;
    return { symbol, valid: false, error: reason };
  }
}

/**
 * Process in batches to respect rate limits
 */
async function processInBatches(symbols, batchSize) {
  const results = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(s => fetchSymbolData(s.Symbol)));
    results.push(...batchResults);

    batchResults.forEach((result, idx) => {
      const globalIndex = i + idx + 1;
      if (result.valid) {
        console.log(`${globalIndex}/${symbols.length} ✅ ${result.symbol}`);
      } else {
        console.log(`${globalIndex}/${symbols.length} ❌ ${result.symbol} (${result.error})`);
      }
    });

    await sleep(100); // short pause for API rate limits
  }
  return results;
}

// ------------------- MAIN -------------------
(async () => {
  const startTime = Date.now();

  // ✅ Correct relative path
  const csvPath = path.join(__dirname, "backtesters", "optionable_stocks.csv");

  let rows = [];
  try {
    rows = await readCSV(csvPath);
  } catch (err) {
    console.error("❌ Failed to read CSV:", err);
    process.exit(1);
  }

  if (rows.length === 0) {
    console.error("⚠️ No valid symbols found in CSV. Exiting...");
    process.exit(1);
  }

  console.log(`🚀 Starting validation for ${rows.length} symbols...`);

  const results = await processInBatches(rows, CONCURRENT_REQUESTS);

  const failed = results.filter(r => !r.valid);
  const failedSymbols = failed.map(f => f.symbol);
  const endTime = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n✅ Completed check of ${results.length} symbols in ${endTime}s`);
  console.log(`❌ Failed: ${failedSymbols.length}`);

  // 🔍 Remove only 404s
  if (failedSymbols.length) {
    const toRemove = failed
      .filter(f => f.error && f.error.includes("404"))
      .map(f => f.symbol);

    if (toRemove.length > 0) {
      console.log(`🗑 Removing ${toRemove.length} symbols with 404 errors...`);
      const updated = rows.filter(r => !toRemove.includes(r.Symbol));
      writeCSV(csvPath, updated);
    } else {
      console.log("📄 No 404 symbols found to remove.");
    }
  } else {
    console.log("🎉 No failed symbols!");
  }

  // 💾 Save full results with metadata + OHLCV
  const outputPath = path.join(__dirname, "polygonresults.json");
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`📊 Results saved to ${outputPath}`);
})();
