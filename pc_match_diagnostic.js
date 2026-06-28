#!/usr/bin/env node
/**
 * pc_match_diagnostic.js — PriceCharting match-rate diagnostic for funko_enrich.
 *
 * Reads the enriched catalog and breaks down PriceCharting coverage and FAILURES
 * by what would actually FIX them, so we build the highest-impact matcher change
 * instead of guessing. Read-only; never writes.
 *
 * Usage (Windows PowerShell, from repo root):
 *   node pc_match_diagnostic.js
 *   node pc_match_diagnostic.js --input funko_data_enriched.json
 *
 * License: MIT (c) 2026 Chris Ahrendt
 */

const fs   = require('fs');
const path = require('path');

// ── args ──────────────────────────────────────────────────────────────────
let input = 'funko_data_enriched.json';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--input') input = process.argv[++i];
}
const inPath = path.resolve(input);
if (!fs.existsSync(inPath)) {
  console.error(`Input not found: ${inPath}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
} catch (e) {
  console.error(`Could not parse ${inPath}: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(data)) {
  console.error('Input is not a JSON array.');
  process.exit(1);
}

// ── helpers (mirror enrich.js semantics) ────────────────────────────────────
const hasPrice = (r) => !!(r.marketValueLoose || r.marketValueComplete || r.marketValueNew);
const hasPcId  = (r) => !!(r.pricechartingId || r.pricechartingUrl);
const cleanUpc = (r) => {
  const u = r.upc != null ? String(r.upc).trim() : '';
  return u && /^\d{11,13}$/.test(u) ? u : '';   // a usable barcode
};
const hasUpc   = (r) => !!cleanUpc(r);
const funkoNum = (r) => {
  const n = (r.funkoNumber || r.funkoNumberFromTitle || '').replace(/[^0-9]/g, '');
  return n || '';
};
const hasNum   = (r) => !!funkoNum(r);

// A record "is a Pop we'd want priced". The pipeline already strips non-Pops in
// post-process, so by the time this runs nearly everything is a Pop; we still
// guard on having a title.
const wantPriced = (r) => !!(r.title && String(r.title).trim());

// ── tallies ─────────────────────────────────────────────────────────────────
const total      = data.length;
const popish     = data.filter(wantPriced);
const priced     = popish.filter(hasPrice);
const pcLinked   = popish.filter(hasPcId);
const approx     = popish.filter(r => r.marketValueIsApproximate);

// Unpriced = the failure set we care about.
const unpriced   = popish.filter(r => !hasPrice(r));

// Of the failures, how many are ADDRESSABLE by each lever?
const failWithUpc   = unpriced.filter(hasUpc);
const failWithNum   = unpriced.filter(hasNum);
const failWithBoth  = unpriced.filter(r => hasUpc(r) && hasNum(r));
const failWithNeither= unpriced.filter(r => !hasUpc(r) && !hasNum(r));
// Records that have a PriceCharting URL/id but still no price — these had a match
// attempt that resolved a page but parsed no price (or were uncertain-but-linked).
const failButLinked = unpriced.filter(hasPcId);

// UPC coverage overall (drives the app's PriceCharting live-refresh fallback too).
const withUpc    = popish.filter(hasUpc);
const pricedNoUpc = priced.filter(r => !hasUpc(r));

const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : '0%';

// ── report ──────────────────────────────────────────────────────────────────
console.log('');
console.log('═══ PriceCharting Match Diagnostic ═══');
console.log(`  file: ${inPath}`);
console.log('');
console.log('── Coverage ──');
console.log(`  total records:          ${total}`);
console.log(`  priceable (has title):  ${popish.length}`);
console.log(`  priced:                 ${priced.length}  (${pct(priced.length, popish.length)})`);
console.log(`  PriceCharting-linked:   ${pcLinked.length}  (${pct(pcLinked.length, popish.length)})`);
console.log(`  approximate prices:     ${approx.length}  (variant priced from base figure)`);
console.log(`  has usable UPC:         ${withUpc.length}  (${pct(withUpc.length, popish.length)})`);
console.log('');
console.log('── Failure set (UNPRICED) ──');
console.log(`  unpriced total:         ${unpriced.length}  (${pct(unpriced.length, popish.length)} of priceable)`);
console.log('');
console.log('  Addressability — how many unpriced records each lever could reach:');
console.log(`    have a usable UPC:        ${failWithUpc.length}  (${pct(failWithUpc.length, unpriced.length)} of failures)  <- UPC-search lever`);
console.log(`    have a funko number:      ${failWithNum.length}  (${pct(failWithNum.length, unpriced.length)} of failures)  <- number-in-query lever`);
console.log(`    have BOTH upc & number:   ${failWithBoth.length}  (${pct(failWithBoth.length, unpriced.length)})`);
console.log(`    have NEITHER:             ${failWithNeither.length}  (${pct(failWithNeither.length, unpriced.length)})  <- hardest; title-only`);
console.log(`    already PC-linked, unpriced: ${failButLinked.length}  (matched a page but no price parsed / uncertain)`);
console.log('');
console.log('── UPC backfill opportunity ──');
console.log(`  priced but NO upc:      ${pricedNoUpc.length}  (these lose the app's UPC-based live refresh)`);
console.log('');

// ── verdict: which lever wins ────────────────────────────────────────────────
console.log('── Verdict ──');
const upcShare = unpriced.length ? failWithUpc.length / unpriced.length : 0;
const numShare = unpriced.length ? failWithNum.length / unpriced.length : 0;
if (unpriced.length === 0) {
  console.log('  No unpriced records — match rate is already complete. No lever needed.');
} else {
  if (upcShare >= 0.30) {
    console.log(`  UPC-search is HIGH IMPACT: ${pct(failWithUpc.length, unpriced.length)} of failures carry a UPC.`);
    console.log('  -> Build the UPC-first match path (verify PriceCharting UPC search first).');
  } else {
    console.log(`  UPC-search is LOW impact: only ${pct(failWithUpc.length, unpriced.length)} of failures carry a UPC.`);
  }
  if (numShare >= 0.40) {
    console.log(`  Number-in-query is promising: ${pct(failWithNum.length, unpriced.length)} of failures have a funko number.`);
  }
  if (failButLinked.length >= unpriced.length * 0.15) {
    console.log(`  Note: ${failButLinked.length} failures are already PC-linked but unpriced — investigate the price PARSER, not the matcher (these found the right page).`);
  }
  if (failWithNeither.length >= unpriced.length * 0.5) {
    console.log(`  Caution: ${pct(failWithNeither.length, unpriced.length)} of failures have neither UPC nor number — title-only, the hardest set. Diminishing returns.`);
  }
}
console.log('');

// ── samples to eyeball ───────────────────────────────────────────────────────
const sample = (arr, n) => arr.slice(0, n).map(r => `      - ${(r.title || '').slice(0, 60)}`).join('\n');
console.log('── Samples ──');
console.log('  Unpriced WITH upc (UPC-lever targets):');
console.log(sample(failWithUpc, 8) || '      (none)');
console.log('  Unpriced, already PC-linked (parser/uncertain targets):');
console.log(sample(failButLinked, 8) || '      (none)');
console.log('  Unpriced with NEITHER upc nor number (hard set):');
console.log(sample(failWithNeither, 8) || '      (none)');
console.log('');
