#!/usr/bin/env node
/**
 * stamp_pricesource.js — add the `priceSource` flag to an already-enriched file
 * WITHOUT re-running the pipeline. Pure local pass: reads the file, stamps each
 * record, writes it back. No network, no crawling, no pricing.
 *
 * priceSource semantics (must match enrich.js post-process):
 *   'pricecharting' — record has a real market value (loose/complete/new).
 *   'none'          — no market value; the app fills via live tiers on ADD.
 * A record that already carries a priceSource is left as-is.
 *
 * Usage (Windows PowerShell, from repo root):
 *   node stamp_pricesource.js
 *   node stamp_pricesource.js --input funko_data_enriched.json --in-place
 *   node stamp_pricesource.js --input X.json --output Y.json
 *
 * Default: reads funko_data_enriched.clean.json, writes the SAME file in place.
 *
 * License: MIT (c) 2026 Chris Ahrendt
 */

const fs   = require('fs');
const path = require('path');

let input    = 'funko_data_enriched.json';
let output   = null;          // null => in place (same as input)
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--input')    input  = process.argv[++i];
  else if (a === '--output') output = process.argv[++i];
  else if (a === '--in-place') output = null;
}
const inPath  = path.resolve(input);
const outPath = path.resolve(output || input);   // default: overwrite input

if (!fs.existsSync(inPath)) { console.error(`Input not found: ${inPath}`); process.exit(1); }

let data;
try { data = JSON.parse(fs.readFileSync(inPath, 'utf8')); }
catch (e) { console.error(`Parse error: ${e.message}`); process.exit(1); }
if (!Array.isArray(data)) { console.error('Input is not a JSON array.'); process.exit(1); }

let priced = 0, pending = 0, alreadySet = 0;
for (const r of data) {
  const hasPrice = !!(r.marketValueLoose || r.marketValueComplete || r.marketValueNew);
  if (r.priceSource === 'pricecharting' || r.priceSource === 'none') {
    alreadySet++;
    // keep existing, but correct it if it's now inconsistent with the data
    if (hasPrice && r.priceSource !== 'pricecharting') { r.priceSource = 'pricecharting'; }
    if (!hasPrice && r.priceSource !== 'none')         { r.priceSource = 'none'; }
  } else if (hasPrice) {
    r.priceSource = 'pricecharting';
  } else {
    r.priceSource = 'none';
  }
  if (r.priceSource === 'pricecharting') priced++; else pending++;
}

fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');

console.log('');
console.log('═══ priceSource stamp ═══');
console.log(`  input:   ${inPath}`);
console.log(`  output:  ${outPath}${outPath === inPath ? '  (in place)' : ''}`);
console.log('');
console.log(`  records:           ${data.length}`);
console.log(`  priceSource set:   ${priced} pricecharting, ${pending} none`);
if (alreadySet) console.log(`  (had a value already: ${alreadySet}, re-checked for consistency)`);
console.log('');
console.log('  Done. This is the file to import.');
console.log('');
