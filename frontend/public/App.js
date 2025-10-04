// frontend/public/App.js

// Fetch signals from backend
async function fetchSignals() {
  try {
    const response = await fetch("/api/signals");
    if (!response.ok) throw new Error("Failed to fetch signals");
    const data = await response.json();
    return data.signals || [];
  } catch (err) {
    console.error("Error fetching signals:", err);
    return [];
  }
}

// Fetch scheduler log from backend
async function fetchLogs() {
  try {
    const response = await fetch("/api/logs");
    if (!response.ok) throw new Error("Failed to fetch logs");
    const data = await response.json();
    return data.log || [];
  } catch (err) {
    console.error("Error fetching logs:", err);
    return [];
  }
}

// Render signals into container
function renderSignals(signals, container) {
  container.innerHTML = "";

  if (!signals || signals.length === 0) {
    container.innerHTML = "<p>No signals at this time.</p>";
    return;
  }

  signals.forEach(signal => {
    const card = document.createElement("div");
    card.classList.add("signal-card", "fade-in");

    // Color code based on long/short
    if (signal.setup === "long") card.style.borderLeft = "5px solid #4caf50";
    if (signal.setup === "short") card.style.borderLeft = "5px solid #f44336";

    let adviceHTML = "";
    if (signal.adviceTips && signal.adviceTips.length > 0) {
      adviceHTML = "<ul>" + signal.adviceTips.map(tip => `<li>${tip}</li>`).join("") + "</ul>";
    }

    const reasonsHTML = signal.reasons ? `<p><strong>Reasons:</strong> ${signal.reasons}</p>` : "";

    card.innerHTML = `
      <h3>${signal.stock} - ${signal.setup.toUpperCase()}</h3>
      <p><strong>Entry:</strong> $${parseFloat(signal.entry).toFixed(2)}</p>
      <p><strong>Stop Loss:</strong> $${parseFloat(signal.stop).toFixed(2)}</p>
      <p><strong>Target:</strong> $${parseFloat(signal.target).toFixed(2)}</p>
      <p><strong>Risk/Reward:</strong> ${signal.riskReward}</p>
      <p><strong>Option Suggestion:</strong> ${signal.optionSuggestion || "N/A"}</p>
      ${reasonsHTML}
      ${adviceHTML}
    `;

    container.appendChild(card);
  });
}

// Render scheduler log
function renderLogs(logs, container) {
  container.innerHTML = "";

  if (!logs || logs.length === 0) {
    container.innerHTML = "<p>No logs at this time.</p>";
    return;
  }

  logs.forEach(signal => {
    let adviceHTML = "";
    if (signal.adviceTips && signal.adviceTips.length > 0) {
      adviceHTML = "<ul>" + signal.adviceTips.map(tip => `<li>${tip}</li>`).join("") + "</ul>";
    }

    const reasonsHTML = signal.reasons ? `<p><strong>Reasons:</strong> ${signal.reasons}</p>` : "";

    // Determine color for long/short
    const color = signal.setup === "long" ? "#4caf50" : signal.setup === "short" ? "#f44336" : "#888";

    const block = document.createElement("div");
    block.innerHTML = `
      <p><strong style="border-left:5px solid ${color}; padding-left:5px;">${signal.stock} - ${signal.setup.toUpperCase()}</strong></p>
      <p>Entry: $${parseFloat(signal.entry).toFixed(2)}, Stop: $${parseFloat(signal.stop).toFixed(2)}, Target: $${parseFloat(signal.target).toFixed(2)}, R:R: ${signal.riskReward}, Option: ${signal.optionSuggestion || "N/A"}</p>
      ${reasonsHTML}
      ${adviceHTML}
      <hr style="border-color: #333;">
    `;
    container.appendChild(block);
  });
}

// Initialize and periodically update dashboard
async function initializeDashboard() {
  const signalsContainer = document.getElementById("signals");
  const logsContainer = document.getElementById("logs");

  async function update() {
    const [signals, logs] = await Promise.all([fetchSignals(), fetchLogs()]);
    renderSignals(signals, signalsContainer);
    renderLogs(logs, logsContainer);
  }

  update(); // initial load
  setInterval(update, 5000); // refresh every 5 seconds
}

// Wait for DOM to load
document.addEventListener("DOMContentLoaded", initializeDashboard);

