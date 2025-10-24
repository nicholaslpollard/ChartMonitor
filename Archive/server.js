const express = require("express");
const cors = require("cors");
const path = require("path");

// Import backend services
const { getPriceData, strategyCheck, riskManagement, formatAlert } = require("./backend/services");
const { getLog } = require("./backend/scheduler");

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve frontend static files
const publicPath = path.join(__dirname, "frontend/public");
app.use(express.static(publicPath));

// Serve index.html at root
app.get("/", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

// Track last trade index per symbol
const lastTradeIndices = {};

// === API Endpoints ===
app.get("/api/signals", async (req, res) => {
  const symbols = ["AAPL", "MSFT", "NVDA"];
  const results = [];

  try {
    const data = await getPriceData(symbols, 100, ["5Min", "1Hour"]);

    for (let sym of symbols) {
      const lowerCandles = data[sym]["5Min"].candles;
      const lowerPrices = data[sym]["5Min"].prices;
      const higherCandles = data[sym]["1Hour"].candles;

      lastTradeIndices[sym] = lastTradeIndices[sym] || -999;

      const signal = strategyCheck(
        sym,
        lowerPrices,
        lowerCandles,
        higherCandles,
        lastTradeIndices[sym],
        lowerCandles.length - 1,
        8
      );

      if (signal) {
        lastTradeIndices[sym] = lowerCandles.length - 1;
        const risk = riskManagement(sym, signal);
        if (risk) {
          risk.reasons = signal.reasons;
          risk.atr = signal.atr;
        }
        const alert = formatAlert(risk);
        if (alert) results.push(alert);
      }
    }

    res.json({ signals: results });
  } catch (err) {
    console.error("Error generating signals:", err);
    res.status(500).json({ error: "Failed to fetch signals" });
  }
});

app.get("/api/logs", (req, res) => {
  res.json({ log: getLog() });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});




