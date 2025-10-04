//optionsbacktest using nvidia - 15.69% win rate - money system does not work right

require('dotenv').config();
const Alpaca = require('@alpacahq/alpaca-trade-api');
const fs = require('fs');
const path = require('path');

// =========================
// === Alpaca Setup ========
const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: true,
  baseUrl: process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets',
});

// =========================
// === Log Setup ===========
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, 'optionsBacktestLog.txt');
fs.writeFileSync(logPath, `Options Backtest Log - ${new Date().toLocaleString()}\n========================\n\n`);

// =========================
// === Helper Functions ===
function SMA(arr, period) { if (arr.length < period) return null; return arr.slice(-period).reduce((a,b)=>a+b,0)/period; }
function RSI(prices, period=14){ if(prices.length<period+1)return null; let g=0,l=0; for(let i=prices.length-period;i<prices.length;i++){const d=prices[i]-prices[i-1]; if(d>0) g+=d; else l-=d;} if(l===0) return 100; return 100-100/(1+g/l);}
function ATR(candles, period=14){ if(candles.length<period+1)return null; const trs=[]; for(let i=candles.length-period;i<candles.length;i++){ const c=candles[i], p=candles[i-1]; trs.push(Math.max(c.high-c.low, Math.abs(c.high-p.close), Math.abs(c.low-p.close)));} return trs.reduce((a,b)=>a+b,0)/trs.length;}
function trendDirection(candles){ if(candles.length<21){ const closes=candles.map(c=>c.close); return closes[closes.length-1] > closes[0] ? 'up' : 'down'; } const closes=candles.map(c=>c.close); return SMA(closes,9)>SMA(closes,21)?'up':'down';}
function BollingerBands(prices, period=20, mult=2){ if(prices.length<period)return null; const sma=SMA(prices,period); const varr=prices.slice(-period).reduce((sum,p)=>sum+Math.pow(p-sma,2),0)/period; const std=Math.sqrt(varr); return {upper:sma+mult*std, lower:sma-mult*std, mid:sma};}
function ADX(candles, period=14){ if(candles.length<period+1)return null; let tr=[],pDM=[],mDM=[]; for(let i=1;i<candles.length;i++){ const c=candles[i], prev=candles[i-1]; const hd=c.high-prev.high; const ld=prev.low-c.low; pDM.push(hd>ld&&hd>0?hd:0); mDM.push(ld>hd&&ld>0?ld:0); tr.push(Math.max(c.high-c.low,Math.abs(c.high-prev.close),Math.abs(c.low-prev.close))); } const smTR=SMA(tr,period), smP=SMA(pDM,period), smM=SMA(mDM,period); const plusDI=(smP/smTR)*100, minusDI=(smM/smTR)*100; return (Math.abs(plusDI-minusDI)/(plusDI+minusDI))*100;}

// =========================
// === Fetch Historical ===
async function fetchHistoricalData(symbol, timeframe, start, end) {
  const resp = await alpaca.getBarsV2(symbol,{
    start:new Date(start).toISOString(),
    end:new Date(end).toISOString(),
    timeframe
  },alpaca.configuration);
  const bars=[];
  for await(let bar of resp){ 
    bars.push({
      time:bar.Timestamp,
      open:bar.OpenPrice,
      high:bar.HighPrice,
      low:bar.LowPrice,
      close:bar.ClosePrice,
      volume:bar.Volume
    }); 
  }
  return bars;
}

// =========================
// === Strategy ===========
function strategy(prices, candles, volumes, higherCandles, i, lastTradeIndex, cooldownBars) {
  const fast = SMA(prices, 9);
  const slow = SMA(prices, 21);
  const rsiValue = RSI(prices);
  const atrNow = ATR(candles);
  const bb = BollingerBands(prices);
  const adxVal = ADX(candles);
  const volNow = volumes.at(-1);
  const avgVol = SMA(volumes, 20);
  const active = avgVol ? volNow > avgVol*0.7 : true;
  const cooled = i - lastTradeIndex >= cooldownBars;

  const trendSlice = higherCandles.slice(0, Math.floor(i/12)+1);
  const trend = trendSlice.length >= 5 ? trendDirection(trendSlice) : 'up';

  if(!fast||!slow||!rsiValue||!bb||!atrNow||!adxVal||!trend||!active||!cooled) return null;

  const candle=candles.at(-1), prev=candles.at(-2);
  const reasons=[];
  reasons.push(trend==='up'?'Trend up':'Trend down');
  reasons.push(fast>slow?'Fast SMA > Slow SMA':'Fast SMA < Slow SMA');
  reasons.push(candle.close>prev.high?'Close>Prev High':'Close<Prev Low');
  reasons.push(rsiValue>55?'RSI>55':'RSI<45');
  if(adxVal>20) reasons.push('ADX>20');
  reasons.push(candle.close>bb.mid?'Close>BB mid':'Close<BB mid');
  if(active) reasons.push('Volume active');
  if(cooled) reasons.push('Cooldown passed');

  if(trend==='up' && fast>slow && candle.close>prev.high && rsiValue>55 && adxVal>20 && candle.close>bb.mid)
    return {signal:'long', reasons:reasons.join(', ')};
  if(trend==='down' && fast<slow && candle.close<prev.low && rsiValue<45 && adxVal>20 && candle.close<bb.mid)
    return {signal:'short', reasons:reasons.join(', ')};
  return null;
}

// =========================
// === Options Risk/Reward ==
function optionsRisk(entry, setup, atr) {
  const stop = setup==='long' ? entry - atr*1.5 : entry + atr*1.5;
  const target = setup==='long' ? entry + atr*3 : entry - atr*3;
  return { stop:+stop.toFixed(2), target:+target.toFixed(2) };
}

// =========================
// === Backtest Runner ===
async function runOptionsBacktest(symbol='NVDA', start='2024-10-01', end='2025-09-30') {
  try {
    console.log(`Running options backtest on ${symbol} from ${start} to ${end}`);
    const [lower, higher] = await Promise.all([
      fetchHistoricalData(symbol,'5Min',start,end), 
      fetchHistoricalData(symbol,'1Hour',start,end)
    ]);

    const prices=[], volumes=[], candles=[];
    let trades=0, wins=0, losses=0, timeouts=0, lastTradeIndex=-999;
    const COOLDOWN=5;
    let balance=100, investmentGone=false;

    for(let i=25;i<lower.length;i++){
      prices.push(lower[i].close);
      volumes.push(lower[i].volume);
      candles.push(lower[i]);
      const subPrices = prices.slice(-30);
      const subCandles = candles.slice(-30);
      const subVolumes = volumes.slice(-30);

      const tradeSignal = strategy(subPrices, subCandles, subVolumes, higher, i, lastTradeIndex, COOLDOWN);
      if(!tradeSignal) continue;

      const { signal, reasons } = tradeSignal;
      const entryPrice = lower[i].close;
      const atrNow = ATR(subCandles);
      const { stop, target } = optionsRisk(entryPrice, signal, atrNow);

      const stopDistance = Math.max(Math.abs(entryPrice - stop), 0.01);
      let riskPerTrade = Math.max(balance*0.02, 10);
      let contracts = Math.floor(riskPerTrade / (stopDistance * 100));
      if(contracts <= 0) contracts = 1; // always 1 contract minimum
      let balanceUsed = contracts*entryPrice*100;
      if(balance < balanceUsed) investmentGone = true;

      lastTradeIndex = i; trades++;

      let exited=false, tradeResult='', tradePL=0;

      for(let j=i+1;j<Math.min(i+12, lower.length); j++){
        const priceMove = lower[j].close - entryPrice;
        const exitPrice = signal==='long' ? entryPrice + priceMove : entryPrice - priceMove;

        if(signal==='long'){
          if(exitPrice >= target){ tradePL = contracts*100*(exitPrice-entryPrice); tradeResult='Win'; wins++; exited=true; break; }
          if(exitPrice <= stop){ tradePL = contracts*100*(exitPrice-entryPrice); tradeResult='Loss'; losses++; exited=true; break; }
        } else {
          if(exitPrice <= target){ tradePL = contracts*100*(entryPrice-exitPrice); tradeResult='Win'; wins++; exited=true; break; }
          if(exitPrice >= stop){ tradePL = contracts*100*(entryPrice-exitPrice); tradeResult='Loss'; losses++; exited=true; break; }
        }
      }

      if(!exited){ tradePL = 0; tradeResult='Timeout'; timeouts++; }

      if(!investmentGone) balance += tradePL;

      const tradeLog =
`Trade #${trades}
Signal: ${signal}
Reason: ${reasons}
Option Premium: ${entryPrice.toFixed(2)}, Stop: ${stop.toFixed(2)}, Target: ${target.toFixed(2)}
Contracts: ${contracts}, Money Used: ${balanceUsed.toFixed(2)}
Result: ${tradeResult}, P/L: ${tradePL.toFixed(2)}
Balance after trade: ${balance.toFixed(2)}
Investment Gone: ${investmentGone}
-------------------------------
`;
      fs.appendFileSync(logPath, tradeLog);
    }

    const winRate = trades ? ((wins/trades)*100).toFixed(2) : 0;
    console.log(`--- Backtest Summary ---`);
    console.log(`Total trades: ${trades}`);
    console.log(`Wins: ${wins}, Losses: ${losses}, Timeouts: ${timeouts}`);
    console.log(`Win rate: ${winRate}%`);
    console.log(`Ending balance: $${balance.toFixed(2)}`);

  } catch(err){ console.error('Options backtest error:', err); }
}

runOptionsBacktest();


