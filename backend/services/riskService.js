/**
 * Advanced Dynamic Risk Management Service
 * Adapts risk levels based on strategy, ATR, and signal direction.
 * Provides contextual trade guidance for each strategy type.
 */

function riskManagement(symbol, signal) {
  if (!signal) return null;

  const atr = signal.atr || 1;
  const direction = signal.direction || signal.signal;
  const entry = signal.entry || signal.price || 0;
  const strategy = signal.strategy || "Generic";

  let stopMultiplier, targetMultiplier, notes, timingTip, scalingTip;

  switch (strategy) {
    // === 1. Trend Strategies ===
    case "MomentumPullback":
      stopMultiplier = 1.0;
      targetMultiplier = 2.5;
      notes = "Momentum continuation trade following a pullback. Favor trending markets.";
      timingTip = "Enter after confirmation candle resumes trend direction with RSI > 50.";
      scalingTip = "Consider scaling in only after a strong candle confirms the bounce.";
      break;

    case "TrendSpike":
      stopMultiplier = 1.5;
      targetMultiplier = 3.5;
      notes = "High-momentum spike. Allow more room for volatility but aim for a large reward.";
      timingTip = "Enter near breakout confirmation with volume > 1.5× average.";
      scalingTip = "Trail stops below last 2 bars’ lows (long) or highs (short) to lock profit.";
      break;

    // === 2. Breakout Strategies ===
    case "BreakoutRange":
      stopMultiplier = 1.2;
      targetMultiplier = 3.0;
      notes = "Captures breakouts from tight ranges. Works best after consolidation.";
      timingTip = "Enter once price closes outside the range on rising volume.";
      scalingTip = "Partial entry on breakout; add on retest of breakout zone.";
      break;

    case "LowVolumeBreakout":
      stopMultiplier = 1.0;
      targetMultiplier = 2.2;
      notes = "Thin-volume breakout play. Volatility is lower but moves are sharp when triggered.";
      timingTip = "Buy as price closes above resistance with even slight volume uptick.";
      scalingTip = "Small position size; liquidity may limit exits.";
      break;

    // === 3. Reversion Strategies ===
    case "MeanReversalRebound":
      stopMultiplier = 0.8;
      targetMultiplier = 1.5;
      notes = "Counter-trend rebound from RSI/Bollinger extremes.";
      timingTip = "Wait for RSI < 30 (long) or > 70 (short) and candle closing in reversal direction.";
      scalingTip = "Small size, quick exit. Rebounds often short-lived.";
      break;

    case "MicroReversion":
      stopMultiplier = 0.6;
      targetMultiplier = 1.0;
      notes = "Tiny counter-trend move. Ideal for quick scalps or mean bounces.";
      timingTip = "Enter on confirmation of bounce from SMA(5) support or resistance.";
      scalingTip = "Use tight stops and partial exits within minutes to hours.";
      break;

    // === Fallback ===
    default:
      stopMultiplier = 1.0;
      targetMultiplier = 2.0;
      notes = "Standard setup with balanced risk/reward.";
      timingTip = "Wait for technical confirmation and sufficient volume.";
      scalingTip = "Use 1-2% risk per trade.";
  }

  // === CALCULATE PRICE LEVELS ===
  let stop, target, rr, option;
  if (direction === "long") {
    stop = entry - atr * stopMultiplier;
    target = entry + atr * targetMultiplier;
    rr = ((target - entry) / (entry - stop)).toFixed(2);
    option = `${Math.round(entry + atr)}C`;
  } else if (direction === "short") {
    stop = entry + atr * stopMultiplier;
    target = entry - atr * targetMultiplier;
    rr = ((entry - target) / (stop - entry)).toFixed(2);
    option = `${Math.round(entry - atr)}P`;
  } else {
    return null;
  }

  return {
    stock: symbol,
    strategy,
    setup: direction,
    entry: entry.toFixed(2),
    stop: stop.toFixed(2),
    target: target.toFixed(2),
    atr: atr.toFixed(2),
    riskReward: rr,
    optionSuggestion: `${option} exp 10/31`,
    notes,
    guidance: {
      timingTip,
      scalingTip,
      stopTip: `Stop placed ${stopMultiplier}× ATR away for volatility buffering.`,
      targetTip: `Target ${targetMultiplier}× ATR — expected RR ${rr}:1.`,
      generalTip:
        direction === "long"
          ? "Focus on strong uptrend or RSI recovery zones."
          : "Favor weak trend continuation or breakdown setups.",
    },
  };
}

module.exports = { riskManagement };
