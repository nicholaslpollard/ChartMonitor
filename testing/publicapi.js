const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ------------------- CONFIG -------------------
const DELAY_MS = 200; // per-key delay
const BETWEEN_TEST_DELAY_MS = 1000; // 1-second delay between the two tests

const SECRET_KEY_1 = "2QdWKlLrnNnM5AotxCdZSj4WzVGjxUP3";
const ACCOUNT_ID_1 = "5OF34891";
const BASE_1 = "https://api.public.com";

const SECRET_KEY_2 = "jqxXdzYHWIZOH1QJLYRJ3DN7PJocdLzL";
const ACCOUNT_ID_2 = "5OF34891";
const BASE_2 = "https://api.public.com";

// 100 symbols for testing
const symbols = [
  "AAPL","MSFT","GOOG","AMZN","TSLA","NVDA","META","NFLX","INTC","AMD",
  "BAC","JPM","WFC","C","GS","MS","SCHW","COF","PYPL","ADBE",
  "ORCL","CRM","IBM","QCOM","TXN","AVGO","SBUX","T","VZ","PEP",
  "KO","MCD","DIS","CVX","XOM","BA","GE","CAT","MMM","HON",
  "F","GM","NKE","LULU","BKNG","UBER","LYFT","SQ","SPOT","TWTR",
  "SNAP","ZM","DOCU","ROKU","CRWD","OKTA","NOW","TEAM","FSLY","PLTR",
  "SHOP","ETSY","PINS","DDOG","NET","ZS","MDB","CRSP","NIO","LI",
  "XPEV","RIVN","LCID","PLUG","BLNK","NKLA","FSR","HOOD","COIN","SOFI",
  "ABNB","EXPE","TRIP","MAR","HLT","WYNN","CZR","MGM","RCL","NCLH",
  "AAL","DAL","UAL","LUV","ALK","SAVE","RTX","LMT","NOC","GD"
];

// ------------------- PATH -------------------
const logPath = path.join(__dirname, '..', 'Chart Monitor', 'publicresults.json');

// Ensure directory exists
if (!fs.existsSync(path.dirname(logPath))) fs.mkdirSync(path.dirname(logPath), { recursive: true });

// Create file if missing
if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, JSON.stringify({}, null, 2), 'utf-8');

// ------------------- HELPERS -------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getAccessToken(secretKey, base) {
  try {
    const res = await axios.post(
      `${base}/userapiauthservice/personal/access-tokens`,
      { validityInMinutes: 60, secret: secretKey },
      { headers: { "Content-Type": "application/json" } }
    );
    return res.data.accessToken;
  } catch (err) {
    console.error('Error fetching access token:', err.response ? err.response.data : err.message);
    return null;
  }
}

// ------------------- LOG RESULTS -------------------
function logResult(symbol, label, data, success = true, error = null) {
  let currentLog = {};
  try {
    currentLog = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
  } catch {
    currentLog = {};
  }

  if (!currentLog[label]) currentLog[label] = {};
  currentLog[label][symbol] = {
    success,
    error,
    data,
    timestamp: new Date().toISOString()
  };

  fs.writeFileSync(logPath, JSON.stringify(currentLog, null, 2), 'utf-8');
}

// ------------------- RUN SINGLE KEY -------------------
async function runSingleKey(symbolList, token, accountId, base, label) {
  let successCount = 0;
  const start = Date.now();

  for (let i = 0; i < symbolList.length; i++) {
    const symbol = symbolList[i];
    try {
      const res = await axios.post(
        `${base}/userapigateway/marketdata/${accountId}/quotes`,
        { instruments: [{ symbol, type: 'EQUITY' }] },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      successCount++;
      console.log(`✅ ${symbol} succeeded (${label}, ${successCount} total)`);
      logResult(symbol, label, res.data, true);

    } catch (err) {
      if (err.response && err.response.status === 429) {
        console.log(`🚨 Rate limit hit on ${symbol} (${label})!`);
        break;
      } else {
        console.log(`❌ ${symbol} error (${label}):`, err.response ? err.response.data : err.message);
        logResult(symbol, label, null, false, err.response ? err.response.data : err.message);
      }
    }
    await sleep(DELAY_MS);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`\n${label} complete. Elapsed: ${elapsed}s`);
  return elapsed;
}

// ------------------- RUN TWO KEYS IN PARALLEL -------------------
async function runTwoKeys(symbolList, tokens, accountIds, bases) {
  const half = Math.ceil(symbolList.length / 2);
  const list1 = symbolList.slice(0, half);
  const list2 = symbolList.slice(half);

  console.log(`Splitting symbols into two halves: ${list1.length} for key 1, ${list2.length} for key 2\n`);

  const start = Date.now();

  // Run both loops concurrently
  const [time1, time2] = await Promise.all([
    runSingleKey(list1, tokens[0], accountIds[0], bases[0], "key 1"),
    runSingleKey(list2, tokens[1], accountIds[1], bases[1], "key 2")
  ]);

  const totalElapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`\nTest complete!`);
  console.log(`Key 1 time: ${time1}s`);
  console.log(`Key 2 time: ${time2}s`);
  console.log(`Total elapsed (parallel): ${totalElapsed}s`);
  return totalElapsed;
}

// ------------------- MAIN -------------------
(async () => {
  const token1 = await getAccessToken(SECRET_KEY_1, BASE_1);
  const token2 = await getAccessToken(SECRET_KEY_2, BASE_2);

  if (!token1 || !token2) {
    console.error("Failed to get one or both access tokens. Exiting.");
    return;
  }

  console.log("🚀 Running test with only key 1...");
  const timeSingleKey = await runSingleKey(symbols, token1, ACCOUNT_ID_1, BASE_1, "single key");
  console.log(`⏱ Time for single key: ${timeSingleKey}s\n`);

  console.log("🕐 Waiting 1 second before running the two-key test...\n");
  await sleep(BETWEEN_TEST_DELAY_MS);

  console.log("🚀 Running test using two keys concurrently...");
  const timeTwoKeys = await runTwoKeys(symbols, [token1, token2], [ACCOUNT_ID_1, ACCOUNT_ID_2], [BASE_1, BASE_2]);
  console.log(`⏱ Time for two keys (parallel): ${timeTwoKeys}s`);
})();
