// update-optionable-list.js
const fs = require('fs');
const path = require('path');
const Alpaca = require('@alpacahq/alpaca-trade-api');
require('dotenv').config();

const FILE_PATH = path.join(__dirname, 'optionable_stocks.csv');

const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: true,
  baseUrl: process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets',
});

(async () => {
  try {
    // Check last modified time
    let downloadNeeded = true;
    if (fs.existsSync(FILE_PATH)) {
      const stats = fs.statSync(FILE_PATH);
      const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
      if (ageHours < 24) downloadNeeded = false;
    }

    if (!downloadNeeded) {
      console.log('Optionable stock list is up-to-date.');
      return;
    }

    console.log('Updating optionable stock list...');

    // Fetch all active assets
    const assets = await alpaca.getAssets({ status: 'active' });

    // Filter tradable stocks on major US exchanges (most are optionable)
    const optionable = assets.filter(a =>
      a.tradable &&
      ['NASDAQ', 'NYSE', 'AMEX'].includes(a.exchange)
    );

    if (!optionable.length) {
      console.warn('No optionable stocks found from Alpaca API.');
      return;
    }

    // Generate CSV: Symbol,Name,Exchange
    const header = 'Symbol,Name,Exchange\n';
    const rows = optionable.map(a => {
      // Escape quotes and wrap name in quotes
      const safeName = a.name ? `"${a.name.replace(/"/g, '""')}"` : '';
      return `${a.symbol},${safeName},${a.exchange}`;
    }).join('\n');

    fs.writeFileSync(FILE_PATH, header + rows);
    console.log(`Optionable stock list updated. Total: ${optionable.length}`);
  } catch (err) {
    console.error('Failed to update optionable list:', err);
  }
})();
