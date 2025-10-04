/**
 * Format risk object into alert for frontend
 * @param {Object} riskObj - { stock, setup, entry, stop, target, riskReward, optionSuggestion, reasons, atr }
 * @returns {Object|null} formatted alert
 */
function formatAlert(riskObj) {
  if (!riskObj) return null;

  const advice = [];

  advice.push(`Consider entering ${riskObj.setup.toUpperCase()} at $${riskObj.entry}`);
  advice.push(`Set stop-loss at $${riskObj.stop}`);
  advice.push(`Target $${riskObj.target} → R:R ${riskObj.riskReward}`);
  advice.push(`Option suggestion: ${riskObj.optionSuggestion}`);
  if (riskObj.reasons) advice.push(`Reason(s): ${riskObj.reasons}`);
  if (riskObj.atr) advice.push(`ATR used: ${riskObj.atr.toFixed(2)}`);

  return {
    stock: riskObj.stock,
    setup: riskObj.setup,
    entry: riskObj.entry,
    stop: riskObj.stop,
    target: riskObj.target,
    riskReward: riskObj.riskReward,
    optionSuggestion: riskObj.optionSuggestion,
    message: `${riskObj.stock} ${riskObj.setup.toUpperCase()} → Entry $${riskObj.entry}, Stop $${riskObj.stop}, Target $${riskObj.target}, R:R ${riskObj.riskReward}, Option: ${riskObj.optionSuggestion}${riskObj.reasons ? `, Reason(s): ${riskObj.reasons}` : ''}`,
    adviceTips: advice
  };
}

module.exports = { formatAlert };

