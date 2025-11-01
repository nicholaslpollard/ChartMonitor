/**
 * Chart Monitor - Master Scheduler (Enhanced)
 * Runs all daily jobs automatically in sequence.
 * Includes: retry logic, summary logging, performance tracking, and failure logging.
 */

const { exec } = require("child_process");
const path = require("path");
const schedule = require("node-schedule");
const fs = require("fs");

// ---- Paths ----
const BASE = path.join(__dirname, "..");
const LOG_DIR = path.join(BASE, "Archive", "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const DATE_STR = new Date().toISOString().split("T")[0];
const LOG_FILE = path.join(LOG_DIR, `scheduler_${DATE_STR}.log`);
const SUMMARY_FILE = path.join(LOG_DIR, `summary_${DATE_STR}.json`);
const FAILS_FILE = path.join(LOG_DIR, `fails.json`);

// Ensure fails.json exists
if (!fs.existsSync(FAILS_FILE)) fs.writeFileSync(FAILS_FILE, JSON.stringify([]));

// ---- Globals ----
let summary = {
  date: DATE_STR,
  morningPrep: { successes: 0, failures: 0, retries: 0, duration: 0 },
  intradayCycles: [],
};

// ---- Logger ----
function log(message) {
  const timestamp = new Date().toISOString();
  const formatted = `[${timestamp}] ${message}`;
  console.log(formatted);
  fs.appendFileSync(LOG_FILE, formatted + "\n");
}

// ---- Failure logger ----
function logFailure(details) {
  const currentFails = JSON.parse(fs.readFileSync(FAILS_FILE));
  currentFails.push(details);
  fs.writeFileSync(FAILS_FILE, JSON.stringify(currentFails, null, 2));
}

// ---- Write daily summary ----
function saveSummary() {
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
}

// ---- Run external scripts with retry ----
async function runScript(scriptPath, name, retries = 1) {
  const startTime = Date.now();

  async function attempt(attemptNum) {
    log(`🚀 Starting ${name} (attempt ${attemptNum}/${retries + 1})...`);

    return new Promise((resolve, reject) => {
      const process = exec(`node "${scriptPath}"`, { cwd: BASE });

      process.stdout.on("data", data => log(`[${name}] ${data.trim()}`));
      process.stderr.on("data", data => log(`[${name} ERROR] ${data.trim()}`));

      process.on("exit", code => {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        if (code === 0) {
          log(`✅ ${name} completed successfully in ${duration}s.`);
          resolve(duration);
        } else {
          const failDetails = {
            timestamp: new Date().toISOString(),
            script: name,
            path: scriptPath,
            attempt: attemptNum,
            exitCode: code,
            duration: parseFloat(duration),
          };
          logFailure(failDetails);
          log(`❌ ${name} failed (exit code ${code}) after ${duration}s.`);
          reject(new Error(`${name} failed (exit code ${code})`));
        }
      });
    });
  }

  for (let i = 0; i <= retries; i++) {
    try {
      const duration = await attempt(i + 1);
      return duration;
    } catch (err) {
      if (i < retries) {
        log(`🔁 Retrying ${name} (${i + 1}/${retries})...`);
      } else {
        log(`⚠️ ${name} failed after ${retries + 1} attempts.`);
        throw err;
      }
    }
  }
}

// ---- Define pipeline functions ----
async function morningPrep() {
  const start = Date.now();
  const results = { successes: 0, failures: 0, retries: 0 };

  try {
    await runScript(path.join(BASE, "Historical", "historicalDBBuilder.js"), "HistoricalDBBuilder", 1);
    results.successes++;
    await runScript(path.join(BASE, "backtesters", "update-optionable-list.js"), "UpdateOptionableList", 1);
    results.successes++;
    await runScript(path.join(BASE, "backtesters", "fullbacktest.js"), "FullBacktest", 1);
    results.successes++;
  } catch (err) {
    log(`⚠️ MorningPrep failed: ${err.message}`);
    results.failures++;
  }

  const duration = ((Date.now() - start) / 1000 / 60).toFixed(2);
  summary.morningPrep = { ...results, duration };
  saveSummary();
}

async function intradayCycle() {
  const start = Date.now();
  const cycleStats = { time: new Date().toLocaleTimeString(), successes: 0, failures: 0, duration: 0 };

  try {
    await runScript(path.join(BASE, "stock_strat_test", "stockmonitor.js"), "StockMonitor", 1);
    cycleStats.successes++;
    await runScript(path.join(BASE, "stock_strat_test", "strat_test.js"), "StratTest", 1);
    cycleStats.successes++;
    await runScript(path.join(BASE, "option-chain-test", "optionchaintest.js"), "OptionChainTest", 1);
    cycleStats.successes++;
    await runScript(path.join(BASE, "Chart Option Bridge", "chartOptionBridge.js"), "ChartOptionBridge", 1);
    cycleStats.successes++;
  } catch (err) {
    log(`⚠️ IntradayCycle failed: ${err.message}`);
    cycleStats.failures++;
  }

  cycleStats.duration = ((Date.now() - start) / 1000 / 60).toFixed(2);
  summary.intradayCycles.push(cycleStats);
  saveSummary();
}

// ---- Schedules ----
function setupSchedules() {
  // 4:00 AM - Run morning prep
  schedule.scheduleJob("0 4 * * 1-5", async () => {
    log("🌅 Morning prep sequence started.");
    await morningPrep();
  });

  // 9:00 AM - Start market cycle (every 15 minutes until 4:00 PM)
  schedule.scheduleJob("*/15 9-15 * * 1-5", async () => {
    const now = new Date();
    const hour = now.getHours();
    if (hour >= 9 && hour < 16) {
      log("🏁 Running intraday cycle...");
      await intradayCycle();
    } else {
      log("⏸️ Market closed. Skipping intraday cycle.");
    }
  });

  // 4:00 PM - Final shutdown/log close
  schedule.scheduleJob("0 16 * * 1-5", () => {
    log("📘 Market closed. Scheduler entering idle mode until next day.");
    saveSummary();
  });
}

// ---- Start ----
log("🕒 Chart Monitor Scheduler initialized (Enhanced Version).");
setupSchedules();
