// Quick audit of a test_output.json from enrich.js.
// Usage (Windows):  node check_test_output.js test_output.json
const fs = require('fs');
const path = process.argv[2] || 'test_output.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));

const total      = data.length;
const priced     = data.filter(r => r.marketValueComplete || r.marketValueLoose || r.marketValueNew);
const withUpc    = data.filter(r => r.upc && String(r.upc).trim());
const pcDiscovered = data.filter(r => r.funkoSource === 'pricecharting');
const pcWithUpc  = pcDiscovered.filter(r => r.upc && String(r.upc).trim());
const pricedNoUpc = priced.filter(r => !(r.upc && String(r.upc).trim()));

console.log(`Total records:                 ${total}`);
console.log(`Priced (any grade):            ${priced.length}`);
console.log(`With UPC (scannable):          ${withUpc.length}`);
console.log(`Priced but NO UPC:             ${pricedNoUpc.length}  <- what --pc-fill-upc targets`);
console.log(`Crawl-discovered (pricecharting): ${pcDiscovered.length}`);
console.log(`  ...of those, with UPC:       ${pcWithUpc.length}`);

console.log(`\n--- 5 sample priced+UPC records (spot-check these on pricecharting.com) ---`);
withUpc.filter(r => r.marketValueComplete).slice(0, 5).forEach(r => {
  console.log(`  "${r.title}"  #${r.funkoNumber || '?'}  UPC=${r.upc}  complete=$${r.marketValueComplete}`);
  console.log(`     ${r.pricechartingUrl || ''}`);
});
