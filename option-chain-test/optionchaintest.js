// optionchaintest.js
import * as math from 'mathjs';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import 'dotenv/config'; // Load .env from project root

// === CONFIG ===
const SECRET_KEY = process.env.PUBLIC_API_KEY;      // from root .env
const FINNHUB_KEY = process.env.FINNHUB_KEY;        // from root .env
const ACCOUNT_ID = process.env.ACCOUNT_ID;          // optional: move your Alpaca account ID to .env
const PUBLIC_API_BASE = 'https://api.public.com';
const RISK_FREE_RATE = 0.035; // 3.5%

const LOG_DIR = path.join(__dirname, 'log');            // option-chain-test/log
const LOG_FILE = path.join(LOG_DIR, 'results.js');      // matches new structure

const MAX_DIFF_PERCENT = 10; 
const MAX_MONTHS = 2;
const MIN_OPTION_PRICE = 0.10; 
const ACTIONABLE_THRESHOLD = 20; 
const MIN_BS_PRICE = 0.01; 
const MAX_BS_PRICE = 0.20; 

// === Finnhub Config ===
const FINNHUB_BASE = 'https://finnhub.io/api/v1';

// === Example popular and random stock lists ===
const popularStocks = [
  'AAPL','MSFT','GOOGL','AMZN','TSLA','NVDA','META','BRK-B','JNJ','V',
  'UNH','PG','HD','MA','DIS','PYPL','ADBE','NFLX','PFE','KO',
  'PEP','INTC','CSCO','XOM','MRK','ABBV','CVX','BAC','WMT','ORCL',
  'CRM','NKE','LLY','TMO','ACN','MCD','ABT','QCOM','TXN','MDT',
  'HON','DHR','COST','NEE','LIN','PM','BMY','IBM','LOW','UNP',
  'SBUX','AMGN','RTX','BA','SCHW','BLK','CAT','CVS','MMM','GS',
  'AXP','PLD','NOW','LMT','AMT','BKNG','ISRG','SYK','DE','ZTS',
  'MO','ADP','FIS','SPGI','EL','CI','EQIX','REGN','CCI','PNC',
  'TMUS','VRTX','MDLZ','DUK','GM','CB','NSC','SCHW','DUK','EW',
  'APD','TJX','ITW','MET','FDX','SHW','SO','GM','SO','CL'
];
const randomStocks = [
  'FIZZ','CZR','PLTR','ROKU','CRWD','SNAP','UPST','FUBO','SPLK','ZM',
  'MDB','AFRM','TWLO','ETSY','DOCU','SHOP','DDOG','COIN','SQ','PYPL',
  'NET','OKTA','BYND','ABNB','ETSY','LCID','SE','DKNG','NIO','QS',
  'RIVN','LC','U','EXPI','RBLX','SNOW','TTCF','HIMS','F','GM','NOK',
  'BB','PLUG','CLOV','SOLO','SPCE','SPWR','ON','CFLT','NNDM','FLEX',
  'AI','APP','AFRM','COUP','HUT','SNDL','BNTX','INO','VZ','T','WKHS',
  'SAVA','BIIB','MNST','VVI','BIDU','TME','BILI','JD','BABA','PDD',
  'IQ','XPEV','LI','KNDI','CANG','HUYA','W','RBLX','TGT','AMC','BBBY',
  'VST','AAL','UAL','SAVE','ALK','JBLU','CCL','RCL','NCLH','SKYW','CC',
  'GTLB','PENN','MGM','WYNN','MLCO','LVS','CAKE'
];

// === Helper: Delay / Sleep ===
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// === Ensure log directory exists ===
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

// === Write results organized by stock ===
function logResultsByStock(stockResults) {
  ensureLogDir();
  fs.writeFileSync(LOG_FILE, '', 'utf8');
  for (const { symbol, results, spotPrice } of stockResults) {
    if (!spotPrice) continue;
    fs.appendFileSync(LOG_FILE, `\n=== Option Analysis for ${symbol} (Spot: $${spotPrice.toFixed(2)}) ===\n`, 'utf8');
    if (!results.length) {
      fs.appendFileSync(LOG_FILE, `No actionable options in BS price range $${MIN_BS_PRICE}-${MAX_BS_PRICE}.\n`, 'utf8');
      continue;
    }
    const tableHeader = ['Strike','Type','Expiration','Option Mid','BS Price','Status','% Diff','Recommendation'];
    fs.appendFileSync(LOG_FILE, tableHeader.join('\t') + '\n', 'utf8');
    for (const r of results) {
      const line = [r.strike,r.type,r.expiration,r.mid.toFixed(2),r.bs.toFixed(2),r.status,r.diffPct,r.recommendation].join('\t');
      fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
    }
  }
}

// === Fetch Spot Price via Finnhub with 55 calls/min limit ===
let lastApiCallTime = 0;
const API_CALL_INTERVAL = 1100; // ~1.1s between calls ≈ 55 calls/min

async function fetchSpotPrice(symbol) {
  try {
    const now = Date.now();
    const diff = now - lastApiCallTime;
    if (diff < API_CALL_INTERVAL) await sleep(API_CALL_INTERVAL - diff);

    const res = await axios.get(`${FINNHUB_BASE}/quote`, {
      params: { symbol, token: FINNHUB_KEY }
    });

    lastApiCallTime = Date.now();
    const price = res.data?.c;
    if (!price) {
      console.warn(`⚠️ No price returned for ${symbol}. Skipping.`);
      return null;
    }
    return parseFloat(price);
  } catch (err) {
    console.error(`❌ Error fetching stock price for ${symbol}:`, err.message);
    return null;
  }
}

// === Get Public API Token ===
async function getAccessToken() {
  try {
    const res = await axios.post(`${PUBLIC_API_BASE}/userapiauthservice/personal/access-tokens`,
      { validityInMinutes: 120, secret: SECRET_KEY, scopes: ['marketdata'] },
      { headers: { 'Content-Type': 'application/json' } });
    return res.data.accessToken;
  } catch (err) {
    console.error('❌ Error getting access token:', err.message);
    return null;
  }
}

// === Fetch Expirations ===
async function fetchExpirations(symbol, token) {
  try {
    const res = await axios.post(`${PUBLIC_API_BASE}/userapigateway/marketdata/${ACCOUNT_ID}/option-expirations`,
      { instrument: { symbol, type: 'EQUITY' } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    return res.data?.payload?.expirations || [];
  } catch (err) {
    console.error(`❌ Error fetching expirations for ${symbol}:`, err.message);
    return [];
  }
}

// === Fetch Option Chain ===
async function fetchOptionChain(symbol, expiration, token) {
  try {
    const res = await axios.post(`${PUBLIC_API_BASE}/userapigateway/marketdata/${ACCOUNT_ID}/option-chain`,
      { instrument: { symbol, type: 'EQUITY' }, expirationDate: expiration },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    return res.data?.payload || null;
  } catch (err) {
    console.error(`❌ Error fetching option chain for ${symbol} ${expiration}:`, err.message);
    return null;
  }
}

// === Black-Scholes Price ===
function bsPrice({ S, K, T, r, sigma, type }) {
  const normCdf = x => 0.5 * (1 + math.erf(x / Math.sqrt(2)));
  if (T <= 0 || sigma <= 0) return type==='call'?Math.max(S-K,0):Math.max(K-S,0);
  const d1 = (Math.log(S/K) + (r + 0.5*sigma**2)*T)/(sigma*Math.sqrt(T));
  const d2 = d1 - sigma*Math.sqrt(T);
  return type==='call'?S*normCdf(d1)-K*Math.exp(-r*T)*normCdf(d2)
                     :K*Math.exp(-r*T)*normCdf(-d2)-S*normCdf(-d1);
}

// === Parse option symbol ===
function parseOptionSymbol(optionSymbol) {
  const match = optionSymbol.match(/^([A-Z]+)(\d{6})([CP])(\d+)$/);
  if (!match) return null;
  const [, , , typeChar, strikeRaw] = match;
  return { type: typeChar==='C'?'call':'put', strike: parseInt(strikeRaw,10)/1000 };
}

// === Analyze single stock ===
async function analyzeSymbol(symbol, token) {
  const spotPrice = await fetchSpotPrice(symbol);
  if (!spotPrice) return { symbol, spotPrice:0, results:[] };
  const expirations = await fetchExpirations(symbol, token);
  if (!expirations.length) return { symbol, spotPrice, results:[] };

  const results = [];
  const now = new Date();
  const maxDate = new Date(); maxDate.setMonth(now.getMonth()+MAX_MONTHS);

  for (const expiration of expirations) {
    const expDate = new Date(expiration);
    if (expDate > maxDate) continue;
    const chain = await fetchOptionChain(symbol, expiration, token);
    if (!chain) continue;
    const T = Math.max((expDate-now)/(365*24*60*60*1000),0);

    const processOption = opt => {
      const parsed = parseOptionSymbol(opt.instrument.symbol);
      if (!parsed) return;
      const { type, strike: K } = parsed;
      const mid = opt.bid && opt.ask ? (parseFloat(opt.bid)+parseFloat(opt.ask))/2 : parseFloat(opt.last);
      if (!mid || mid < MIN_OPTION_PRICE) return;

      const sigma = 0.25;
      const bs = bsPrice({ S: spotPrice, K, T, r:RISK_FREE_RATE, sigma, type });
      if (bs < MIN_BS_PRICE || bs > MAX_BS_PRICE) return;

      let status='Correct';
      let diffPct = ((mid-bs)/bs)*100;
      if (diffPct<-1) status='Underpriced';
      else if (diffPct>1) status='Overpriced';

      if (Math.abs(diffPct)>=ACTIONABLE_THRESHOLD) {
        let recommendation='BUY';
        if(status==='Underpriced') recommendation = type==='call'?'BUY CALL (underpriced)':'BUY PUT (underpriced)';
        else if(status==='Overpriced') recommendation = type==='call'?'SELL CALL (overpriced)':'SELL PUT (overpriced)';
        results.push({ symbol, expiration, strike:K, type, mid, bs, status, diffPct:diffPct.toFixed(2), recommendation });
      }
    };

    chain.calls?.forEach(processOption);
    chain.puts?.forEach(processOption);
  }

  results.sort((a,b)=>Math.abs(b.diffPct)-Math.abs(a.diffPct));
  return { symbol, spotPrice, results };
}

// === Run analysis one by one with Finnhub rate limiting ===
async function analyzeStocks() {
  const token = await getAccessToken();
  if (!token) return;

  const allStocks = [...popularStocks, ...randomStocks];
  const stockResults = [];

  for (const symbol of allStocks) {
    const result = await analyzeSymbol(symbol, token);
    if (result.spotPrice > 0) stockResults.push(result);
    console.log(`Processed ${symbol}.`);
  }

  logResultsByStock(stockResults);
  console.log(`\n✅ Analysis complete. Results saved to ${LOG_FILE}`);
}

// === RUN ===
analyzeStocks();
