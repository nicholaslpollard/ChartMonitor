// frontend/src/services/api.js

const BASE_URL = "http://localhost:3000"; // Change if deployed elsewhere

/**
 * Fetch the latest trading signals from the backend
 * @returns {Promise<Array>} Array of signal objects
 */
export async function fetchSignals() {
  try {
    const response = await fetch(`${BASE_URL}/api/signals`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.signals || [];
  } catch (err) {
    console.error("Error fetching signals:", err);
    return [];
  }
}

/**
 * Fetch scheduler logs (if using scheduler.js)
 * @returns {Promise<Array>} Array of logged signals
 */
export async function fetchSignalLog() {
  try {
    const response = await fetch(`${BASE_URL}/api/logs`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.log || [];
  } catch (err) {
    console.error("Error fetching signal logs:", err);
    return [];
  }
}

