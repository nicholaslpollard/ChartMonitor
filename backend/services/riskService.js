/**
 * Calculate dynamic risk management levels for a trade signal
 * Ultra-High Win Rate version
 * @param {string} symbol
 * @param {Object} signal - { direction, entry, atr }
 * @returns {Object|null} risk object
 */
function riskManagement(symbol, signal) {
  if (!signal) return null;

  const atr = signal.atr || 1; // fallback if ATR not provided
  let stop, target, rr, option;

  // Tighter ATR multipliers for ultra-high WR strategy
  const stopMultiplier = 0.7;   // stop distance = ATR * 0.7
  const targetMultiplier = 1.1; // target distance = ATR * 1.1

  if (signal.direction === "long") {
    stop = signal.entry - atr * stopMultiplier;
    target = signal.entry + atr * targetMultiplier;
    rr = (signal.entry - stop !== 0) ? ((target - signal.entry) / (signal.entry - stop)).toFixed(2) : "0";
    option = `${Math.round(signal.entry + atr)}C exp 10/18`; // optional example option
  } else {
    stop = signal.entry + atr * stopMultiplier;
    target = signal.entry - atr * targetMultiplier;
    rr = (stop - signal.entry !== 0) ? ((signal.entry - target) / (stop - signal.entry)).toFixed(2) : "0";
    option = `${Math.round(signal.entry - atr)}P exp 10/18`;
  }

  return {
    stock: symbol,
    setup: signal.direction,
    entry: signal.entry.toFixed(2),
    stop: stop.toFixed(2),
    target: target.toFixed(2),
    riskReward: rr,
    optionSuggestion: option,
  };
}

module.exports = { riskManagement };


