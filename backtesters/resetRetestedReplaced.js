// resetRetested.js
// Resets "retested" and "replaced" fields to "no" in all JSON objects in results.json
const fs = require('fs');
const path = require('path');

const resultsPath = path.join(__dirname, 'log', 'results.json');

if (!fs.existsSync(resultsPath)) {
  console.error('❌ results.json not found.');
  process.exit(1);
}

let allResults = [];
try {
  allResults = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
} catch (err) {
  console.error('❌ Failed to parse JSON:', err.message);
  process.exit(1);
}

// Update each entry
allResults.forEach(entry => {
  entry.retested = 'no';
  entry.replaced = 'no';
});

// Save back to file
fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
console.log(`✅ Updated ${allResults.length} entries: set retested = "no" and replaced = "no"`);
