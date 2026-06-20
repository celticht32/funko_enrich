'use strict';
/**
 * export-community-delta.js
 * MIT License, Copyright (c) 2026 Chris Ahrendt
 *
 * Reads funko_data_enriched.json and exports records that have both a UPC
 * and a handle as a delta file compatible with funko-upc-community schema v1.
 *
 * Usage:
 *   node export-community-delta.js [--input <path>] [--output <path>] [--deltas-dir <path>]
 *
 * Options:
 *   --input       Path to funko_data_enriched.json  (default: funko_data_enriched.json)
 *   --output      Output delta filename             (default: auto-generated with timestamp)
 *   --deltas-dir  Path to the deltas/ folder        (default: ./deltas)
 */

const fs   = require('fs');
const path = require('path');

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const opts = {
  input:     'funko_data_enriched.json',
  output:    null,
  deltasDir: './deltas',
};
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--input':      opts.input     = args[++i]; break;
    case '--output':     opts.output    = args[++i]; break;
    case '--deltas-dir': opts.deltasDir = args[++i]; break;
  }
}

// ── Load enriched data ───────────────────────────────────────────────────────

const inputPath = path.resolve(opts.input);
if (!fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
console.log(`Loaded ${data.length} records from ${inputPath}`);

// ── GS1 UPC-A check digit validation ─────────────────────────────────────────

function isValidUpc(upc) {
  if (!/^\d{12,13}$/.test(upc)) return false;
  if (upc.length === 13) return true; // EAN-13 — accept as-is
  // UPC-A check digit
  const digits = upc.split('').map(Number);
  const check = digits[11];
  const sum = digits.slice(0, 11).reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

// ── Map enriched record to community schema ───────────────────────────────────

const today = new Date().toISOString().split('T')[0];

function toCommunityRecord(rec) {
  // Extract franchise from series array — first non-Pop!/non-Funko tag
  const series = rec.series || [];
  const franchise = rec.franchise ||
    series.find(s =>
      !s.startsWith('Pop!') &&
      !s.startsWith('Funko') &&
      !s.includes('Exclusive') &&
      s.length > 2
    ) || series[0] || '';

  // Extract category — first Pop! tag
  const category = series.find(s => s.startsWith('Pop!')) || '';

  // Series number — from funkoNumber (verified) then funkoNumberFromTitle (unverified)
  const seriesNumber = rec.funkoNumber
    ? `#${rec.funkoNumber}`
    : rec.funkoNumberFromTitle
    ? `#${rec.funkoNumberFromTitle}`
    : '';

  // Retail price — stored as "14.99" string, convert to number
  const retailPrice = rec.price
    ? parseFloat(rec.price.replace(/[^0-9.]/g, '')) || undefined
    : undefined;

  // Exclusive retailer — from series tags or explicit field
  const exclusiveRetailer = rec.exclusiveRetailer ||
    (series.find(s => /exclusive/i.test(s) && s.length < 50) || '').replace(/\s*exclusive[s]?$/i, '').trim() || '';

  // Clean handle — strip funko.com .html suffix if present
  const handle = rec.handle.endsWith('.html')
    ? rec.handle.replace('.html', '')
    : rec.handle;

  const result = {
    upc:              rec.upc,
    handle:           handle.slice(0, 100),
    name:             rec.title,
    franchise:        franchise,
    schemaVersion:    1,
    source:           'USER_SCAN',  // enricher-sourced, not Channel3
    contributedAt:    today,
  };

  if (category)         result.category          = category;
  if (seriesNumber)     result.seriesNumber       = seriesNumber;
  if (retailPrice)      result.retailPrice        = retailPrice;
  if (rec.imageName)    result.imageUrl           = rec.imageName;
  if (exclusiveRetailer) result.exclusiveRetailer = exclusiveRetailer;
  if (rec.isVaulted)    result.isVaulted          = true;
  if (rec.isChase)      result.isChase            = true;
  if (rec.isExclusive)  result.isExclusive        = true;

  return result;
}

// ── Filter and map ────────────────────────────────────────────────────────────

let skippedNoUpc    = 0;
let skippedNoHandle = 0;
let skippedBadUpc   = 0;
let skippedNoName   = 0;
let skippedNoFranchise = 0;

const records = [];

for (const rec of data) {
  // Must have UPC and handle
  if (!rec.upc) { skippedNoUpc++; continue; }
  if (!rec.handle) { skippedNoHandle++; continue; }

  // Skip funko.com-only records — their handles are item numbers, not Kenny Chan slugs
  if (rec.handle.endsWith('.html')) { skippedNoHandle++; continue; }

  // Validate UPC
  const upc = String(rec.upc).replace(/\s/g, '');
  if (!isValidUpc(upc)) { skippedBadUpc++; continue; }

  // Must have a title
  if (!rec.title || rec.title.length < 2) { skippedNoName++; continue; }

  const mapped = toCommunityRecord({ ...rec, upc });

  // Must have franchise (required by schema)
  if (!mapped.franchise) { skippedNoFranchise++; continue; }

  records.push(mapped);
}

console.log(`\nFiltering results:`);
console.log(`  Exported:          ${records.length}`);
console.log(`  Skipped no UPC:    ${skippedNoUpc}`);
console.log(`  Skipped no handle: ${skippedNoHandle}`);
console.log(`  Skipped bad UPC:   ${skippedBadUpc}`);
console.log(`  Skipped no name:   ${skippedNoName}`);
console.log(`  Skipped no franchise: ${skippedNoFranchise}`);

if (records.length === 0) {
  console.log('\nNo records to export.');
  process.exit(0);
}

// ── Write delta file ──────────────────────────────────────────────────────────

const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const filename   = opts.output || `enricher-${timestamp}.json`;
const deltasDir  = path.resolve(opts.deltasDir);

if (!fs.existsSync(deltasDir)) {
  fs.mkdirSync(deltasDir, { recursive: true });
}

const outputPath = path.join(deltasDir, filename);
fs.writeFileSync(outputPath, JSON.stringify(records, null, 2), 'utf8');

console.log(`\nDelta file written: ${outputPath}`);
console.log(`Records: ${records.length}`);
console.log(`\nNext steps:`);
console.log(`  1. Copy the delta file to your funko-upc-community/deltas/ folder`);
console.log(`  2. Run: node merge-deltas.js`);
console.log(`  3. git add . && git commit -m "Add enricher delta ${timestamp}"`);
console.log(`  4. git push`);
