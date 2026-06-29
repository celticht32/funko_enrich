#!/usr/bin/env node
/**
 * clean_nonfigures.js — remove pure non-figure merchandise from the enriched
 * catalog (socks, drinkware, passport, poster, card games, Rock'em Sock'em).
 *
 * CONSERVATIVE BY DESIGN. It removes ONLY records whose exact title is in the
 * REMOVE list below AND which carry no real-Pop signal (no funko number, no
 * funko-pop-* console, no pricechartingId, no funkoSource). Anything that
 * contains a figure — FunkO's cereal, advent calendars, collectors boxes (each
 * bundles an exclusive Pocket Pop) — is NOT in this list and is kept. Variants
 * are never touched.
 *
 * Writes a NEW file (does not overwrite the input) plus a removal report so the
 * removals can be audited before importing.
 *
 * Usage (Windows PowerShell, from repo root):
 *   node clean_nonfigures.js
 *   node clean_nonfigures.js --input funko_data_enriched.json --output funko_data_enriched.clean.json
 *
 * License: MIT (c) 2026 Chris Ahrendt
 */

const fs   = require('fs');
const path = require('path');

let input  = 'funko_data_enriched.json';
let output = 'funko_data_enriched.clean.json';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--input')  input  = process.argv[++i];
  if (process.argv[i] === '--output') output = process.argv[++i];
}

const inPath  = path.resolve(input);
const outPath = path.resolve(output);
if (!fs.existsSync(inPath)) { console.error(`Input not found: ${inPath}`); process.exit(1); }

let data;
try { data = JSON.parse(fs.readFileSync(inPath, 'utf8')); }
catch (e) { console.error(`Parse error: ${e.message}`); process.exit(1); }
if (!Array.isArray(data)) { console.error('Input is not a JSON array.'); process.exit(1); }

// A record has a "real Pop signal" if any of these is present. Such records are
// NEVER removed, even if their title matches a merch word — this protects real
// figures with odd names.
const hasPopSignal = (r) => {
  const num = (r.funkoNumber || r.funkoNumberFromTitle || '').toString().replace(/[^0-9]/g, '');
  return !!num
      || /^funko-pop-/.test(r.console || '')
      || !!r.pricechartingId
      || !!r.funkoSource;
};

// Exact titles to remove — pure non-figure merchandise only. Reviewed individually.
const REMOVE_TITLES = new Set([
  'Mickey Mouse Holiday Socks',
  'Passport Issued By Funko',
  'Wonder Woman Insulated Glass',
  'Target Marvel UV Socks 3-Pack',
  "Rock 'em Sock 'em Robots (Red)",
  "Rock 'em Sock 'em Robot (Red)",
  "Rock 'em Sock 'em Robot (Blue)",
  'Gremlins - Family Card Game',
  "National Lampoon's Christmas Vacation - Family Card Game",
  'Batman 80th Socks',
  'Fuzzy Beast Toe Socks',
  'Batman Classic TV Socks',
  'Darth Vader 16 Oz. Tumbler W/ Straw',
  '8-Bit Batman Socks (Green & Blue)',
  '8-Bit Batman Socks (Blue & Red)',
  '8-Bit Batman Socks (Gray & Blue)',
  '8-Bit Batman Socks (Orange & Red)',
  '8-Bit Batman Socks (Purple & Blue)',
  'Endor Socks',
  'First Order Emblem Socks',
  'Snowman Jack Socks',
  'The Last Jedi Poster',
  'Wonder Woman Socks',
  'Fright Night Socks',
  'Darth Vader & Stormtrooper Socks',
]);

const removed = [];
const kept = data.filter((r) => {
  const title = (r.title || '').trim();
  if (REMOVE_TITLES.has(title) && !hasPopSignal(r)) {
    removed.push(title);
    return false;   // drop it
  }
  return true;      // keep
});

// Report any REMOVE_TITLES that were NOT found (so the list stays honest if the
// catalog changes) and any that were protected by a Pop signal.
const removedSet = new Set(removed);
const notFound = [...REMOVE_TITLES].filter(t => !data.some(r => (r.title || '').trim() === t));
const protectedBySignal = data.filter(r => REMOVE_TITLES.has((r.title || '').trim()) && hasPopSignal(r))
  .map(r => (r.title || '').trim());

fs.writeFileSync(outPath, JSON.stringify(kept, null, 2), 'utf8');

console.log('');
console.log('═══ Non-figure cleanup ═══');
console.log(`  input:   ${inPath}`);
console.log(`  output:  ${outPath}`);
console.log('');
console.log(`  records in:   ${data.length}`);
console.log(`  removed:      ${removed.length}`);
console.log(`  records out:  ${kept.length}`);
console.log('');
console.log('  Removed (pure non-figure merch):');
removed.forEach(t => console.log(`    - ${t}`));
if (protectedBySignal.length) {
  console.log('');
  console.log('  PROTECTED (matched remove-list but has a Pop signal — KEPT):');
  protectedBySignal.forEach(t => console.log(`    + ${t}`));
}
if (notFound.length) {
  console.log('');
  console.log('  Listed but not present in this catalog (no-op):');
  notFound.forEach(t => console.log(`    ? ${t}`));
}
console.log('');
console.log('  Original file unchanged. Review the output, then import the clean file.');
console.log('');
