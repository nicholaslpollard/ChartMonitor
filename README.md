# Automated Stock–Option Strategy System  
**Full Daily Workflow Overview**

---

## 🕓 1. Early Morning Pre-Market Preparation

### **(A) historicalDBUpdater.js**
**Purpose:**  
Fetches and updates all historical data in the local database with the latest OHLCVNVW (Open, High, Low, Close, Volume, Number of trades, VWAP) and indicator data for all tracked stocks.

**Time Frame:**  
- **Start:** ~4:00 AM  
- **End:** ~4:30 AM  

**Functionality:**  
- Pulls 1 year of data for each timeframe:  
  - 15-minute  
  - 1-hour  
  - 4-hour  
  - 1-day  
  - 1-week  
- Ensures that all timeframes are up to date with the previous day’s data and includes up to the current pre-market data.  
- Stores this data in the **`/data/historical/`** directory, organized by timeframe.  
- Uses **Polygon.io API** (or other source) for data retrieval.  
- Writes parquet files per timeframe for efficient retrieval and compression.  
- Updates the database tables (or file-based cache) used by downstream scripts.

**Output:**  
- `/data/historical/15min/*.parquet`  
- `/data/historical/1hour/*.parquet`  
- `/data/historical/4hour/*.parquet`  
- `/data/historical/1day/*.parquet`  
- `/data/historical/1week/*.parquet`

**Next Step Trigger:**  
When complete, automatically starts `fullbacktest.js`.

---

## 🧠 2. Strategy Calibration and Testing

### **(B) fullbacktest.js**
**Purpose:**  
Runs all available strategies on the freshly updated 1-year historical dataset to determine which performs best per stock.

**Time Frame:**  
- **Start:** ~4:30 AM (after `historicalDBUpdater.js`)  
- **End:** ~6:30–7:00 AM (depending on stock volume and system performance)

**Functionality:**  
- Executes **`update-optionable-list.js`** internally.  
  - Updates the list of all stocks with available options (`optionable-stocks.csv`).  
- Runs every strategy (from `/strategies/`) on each stock’s historical data.  
- Calculates metrics such as:
  - Win rate  
  - Average gain/loss  
  - Max drawdown  
  - Volatility-adjusted return  
- Logs the **best performing strategy per stock** in:  
  `/logs/strategy_performance.json`  
- Replaces outdated strategies when a new one performs better.  

**Output:**  
- `/logs/strategy_performance.json` (updated)  
- `/data/optionable-stocks.csv` (updated)

**Next Step Trigger:**  
When finished, system waits until **market open (9:30 AM)** to begin live monitoring.

---

## 📈 3. Market Hours Operations

### **(C) stockmonitor.js**
**Purpose:**  
Continuously monitors live market data during open hours and updates live OHLCVNVW + indicator parquet files.

**Time Frame:**  
- **Start:** 9:30 AM (Market Open)  
- **End:** 4:00 PM (Market Close)  

**Functionality:**  
- Fetches and appends **real-time live data** every 15 minutes for all tracked stocks.  
- Covers all 5 timeframes (15min, 1h, 4h, 1d, 1w).  
- Stores today’s live data in `/data/today_15min/` folder.  
- Uses asynchronous batch fetches to minimize latency.  
- Runs continuously until market close.  

**Output:**  
- `/data/today_15min/*.parquet`  
- `/logs/live_fetch_log.txt`  

**Next Step Trigger:**  
Every 15-minute update triggers `strat_test.js` on the latest live data.

---

## 🔍 4. Strategy Testing on Live Data

### **(D) strat_test.js**
**Purpose:**  
Evaluates each stock using its best strategy (from `/logs/strategy_performance.json`) against both **historical** and **current live data** to generate actionable alerts.

**Triggered:**  
Every 15 minutes after `stockmonitor.js` updates data.  

**Functionality:**  
- Loads:
  - Historical data (from `/data/historical/`)  
  - Live data (from `/data/today_15min/`)  
- Runs the stock’s best strategy to predict short-term trend direction.  
- Generates alerts when conditions are met for:
  - Strong bullish signals (High Importance)  
  - Moderate trend confirmation (Medium Importance)  
- Saves alerts with metadata (strategy used, timeframe, probability score, etc.)  

**Output:**  
- `/alerts/stock_alerts.json`  
- `/logs/strat_test_log.txt`  

**Next Step Trigger:**  
Any **High Importance** alert automatically calls `optionchaintest.js` for those stocks.

---

## 💹 5. Option Chain Analysis

### **(E) optionchaintest.js**
**Purpose:**  
Analyzes the option chain for alerted stocks and identifies **underpriced or overvalued options** using the Black–Scholes model.

**Triggered By:**  
`strat_test.js` high importance (bullish or bearish) alerts.  

**Functionality:**  
- Fetches the latest option chain for the symbol (2 months forward).  
- Calculates fair value using the **Black–Scholes** formula for each strike/expiration.  
- Flags any options that are significantly **undervalued** or **overvalued**.  
- Saves results to disk for use by the bridge program.  

**Output:**  
- `/alerts/option_alerts.json`  
- `/logs/optionchaintest_log.txt`  

**Next Step Trigger:**  
When a matching stock alert is found, triggers `chartoptionbridge.js`.

---

## 🔗 6. Cross-Alert Matching and Decision Output

### **(F) chartoptionbridge.js**
**Purpose:**  
Correlates alerts from both `strat_test.js` and `optionchaintest.js` to produce actionable trade recommendations.

**Functionality:**  
- Reads:
  - `/alerts/stock_alerts.json`  
  - `/alerts/option_alerts.json`  
- Matches:
  - Bullish stock alerts → Undervalued call options  
  - Bearish stock alerts → Undervalued put options  
- Runs all data through the **DecisionSheet** (a logic model/decision tree) to:
  - Evaluate the probability of success  
  - Assess trade risk/reward ratio  
  - Determine action type (Buy Call, Buy Put, Hold, Ignore)  
- Prepares final trade recommendation package.

**Output:**  
- `/alerts/final_trade_alerts.json`  
- `/logs/chartoptionbridge_log.txt`  

**Next Step Trigger:**  
Immediately sends data to the **email alert system**.

---

## 📬 7. Alert Delivery System

### **(G) Email/Notification Sender**
**Purpose:**  
Sends email alerts containing all relevant data from the combined decision process.

**Functionality:**  
- Summarizes:
  - Stock symbol, current price, and trend  
  - Strategy performance metrics  
  - Black–Scholes valuation  
  - Recommended strike/expiration  
  - Action type and confidence level  
- Categorizes alerts by priority:
  - **High Importance:** Immediate actionable trades  
  - **Medium Importance:** Potential watchlist candidates  
  - **Low Importance:** Informational summaries  
- Supports batch alert emails at set intervals.

**Output:**  
- `/logs/email_sent_log.txt`  
- `/emails/sent/YYYY-MM-DD/*.eml` (optional archive)

---

## 💤 8. End of Day and Restart

At **4:00 PM**, `stockmonitor.js` stops, and all scripts finish their final runs.  
Logs and alerts are archived, and the system resets for the next day’s 4:00 AM cycle.

---

## 🗂 Directory Layout Overview

```
/root_project/
│
├── /data/
│   ├── /historical/
│   │   ├── /15min/
│   │   ├── /1hour/
│   │   ├── /4hour/
│   │   ├── /1day/
│   │   └── /1week/
│   ├── /today_15min/
│   ├── optionable-stocks.csv
│   └── historicalDB.sqlite (optional DB file)
│
├── /strategies/
│   ├── mean_reversion.js
│   ├── momentum.js
│   ├── breakout.js
│   └── ...
│
├── /alerts/
│   ├── stock_alerts.json
│   ├── option_alerts.json
│   └── final_trade_alerts.json
│
├── /logs/
│   ├── historical_update_log.txt
│   ├── fullbacktest_log.txt
│   ├── live_fetch_log.txt
│   ├── strat_test_log.txt
│   ├── optionchaintest_log.txt
│   ├── chartoptionbridge_log.txt
│   └── email_sent_log.txt
│
├── historicalDBUpdater.js
├── fullbacktest.js
├── update-optionable-list.js
├── stockmonitor.js
├── strat_test.js
├── optionchaintest.js
├── chartoptionbridge.js
├── decisionSheet.js
└── emailer.js
```

---

## 🔄 Summary of Execution Flow

| Time (EST) | Program | Description |
|-------------|----------|--------------|
| **04:00 AM** | `historicalDBUpdater.js` | Updates all timeframes in database |
| **04:30 AM** | `fullbacktest.js` | Runs strategy optimization + updates best strategies |
| **09:30 AM – 04:00 PM** | `stockmonitor.js` | Continuously updates live data |
| every 15 min | `strat_test.js` | Tests live data for alerts |
| immediate | `optionchaintest.js` | Analyzes options for alerted stocks |
| immediate | `chartoptionbridge.js` | Matches stock + option alerts |
| immediate | `emailer.js` | Sends final email alerts |
| **04:00 PM** | — | System stops until next day |
