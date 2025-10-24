Chart-Option Bridge Indicators Guide

This guide explains the fields logged in BridgeResults.json and how they can inform your trading decisions.

1. symbol
   - The stock symbol (e.g., AAPL, SPY)
   - Used to identify the underlying security for the option.

2. type
   - "call" or "put"
   - Call = bet on stock going up
   - Put = bet on stock going down

3. strike
   - The option's strike price
   - Price at which the option can be exercised

4. expiration
   - The expiration date of the option
   - Shorter expiration = more sensitive to price changes and time decay

5. lastPrice
   - The last traded price of the option

6. theoPrice
   - The theoretical value of the option using the Black-Scholes model
   - Compares market price to fair value

7. diffPct
   - Percent difference between theoPrice and lastPrice
   - Positive = undervalued (potential buy)
   - Negative = overvalued (potential sell or avoid)

8. status
   - "Undervalued" or "Overvalued"
   - Quick reference based on diffPct

9. histVol
   - Historical volatility of the underlying stock
   - Higher = stock has moved more in the past (higher risk, higher option premium)

10. iv
    - Implied volatility from option market
    - Reflects expected future movement
    - Compare to histVol: if iv >> histVol, option may be expensive

11. volRatio
    - iv / histVol
    - >1 = options are relatively expensive
    - <1 = options are relatively cheap

12. bid / ask
    - Current bid and ask prices
    - Wide spreads may indicate low liquidity or uncertainty

13. spreadPct
    - ((ask - bid) / lastPrice) * 100
    - Higher % = larger spread, less desirable to trade
    - Lower % = tighter spread, more tradable

14. openInterest
    - Number of open contracts
    - Higher = more liquid, easier to enter/exit
    - Lower = less liquid, risk of slippage

How to use:
- Look for undervalued options with reasonable volRatio (<1.2), tight spread (<5%), and decent openInterest (>500).
- Overvalued options may be avoided unless you want to sell or write options.
- Combine with chart alerts to time entries (e.g., stock alert up + undervalued call = potential buy).

##Chart-Option Bridge Indicators Guide

1. symbol - The stock symbol (e.g., AAPL, SPY)
2. type - "call" or "put". Call = bet on price going up, Put = bet on price going down
3. strike - Option strike price
4. expiration - Option expiration date
5. lastPrice - Last traded price of the option
6. theoPrice - Theoretical value from Black-Scholes calculation
7. diffPct - % difference between theoPrice and lastPrice; positive = undervalued, negative = overvalued
8. status - "Undervalued" or "Overvalued"
9. histVol - Historical volatility of the stock
10. iv - Implied volatility of the option
11. volRatio - iv / histVol; >1 means option is expensive relative to history, <1 means cheap
12. bid / ask - Current market bid and ask prices for the option
13. spreadPct - ((ask - bid)/lastPrice)*100; lower values indicate tighter spreads (better liquidity)
14. openInterest - Number of open contracts; higher = more liquid
15. chartAlertType - The type of chart alert received (e.g., "uptrend", "downtrend", "high probability signal")

How to use this information:
- Undervalued options with supportive chart alerts may indicate a good buying opportunity.
- Overvalued options with contrary chart alerts may indicate potential shorting opportunities.
- Compare volRatio and spreadPct to evaluate risk and liquidity before taking action.
- Consider expiration and strike relative to your trading horizon and strategy.
- Use multiple indicators together for a more informed decision rather than relying on a single metric.
