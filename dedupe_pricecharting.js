/**
 * dedupe_pricecharting.js — collapse PriceCharting duplicate records into the
 * existing catalog record for the same Pop.
 *
 * MIT License, Copyright (c) 2026 Chris Ahrendt
 *
 * WHY: Pass 3b discovers Pops from PriceCharting and, when it cannot recognise
 * that a Pop already exists in the catalog (titles are formatted very differently
 * between sources — PriceCharting appends "#<num>" and variant tags your catalog
 * stores separately), it adds a NEW record. That produces duplicate pairs: one
 * original (from HobbyDB/funko.com) and one PriceCharting copy of the same Pop.
 *
 * This tool merges those pairs using a STRONGER key than title alone:
 *   funkoNumber (parsed from "#<num>" on the PriceCharting side, already a field
 *   on the existing side) + a fuzzy CORE-NAME match (title with #numbers,
 *   [brackets], (variant parens) and HTML entities stripped).
 *
 * It is FILL-ONLY and CONSERVATIVE:
 *   - merges PriceCharting data (pricechartingId, prices, UPC, metadata) INTO the
 *     existing record, never overwriting a non-empty existing value;
 *   - only merges when funkoNumber matches AND core names are similar, so it will
 *     not collapse genuinely distinct Pops;
 *   - leaves unmatched PriceCharting records as-is (they are real new discoveries).
 *
 * USAGE:
 *   node dedupe_pricecharting.js [--in funko_data_enriched.json] [--out <same>]
 *                               [--dry-run] [--report dupes_report.json]
 *
 *   --dry-run   analyse and report only; do not write.
 *   A timestamped backup of the input is written before any in-place write.
 */

'use strict';
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const o = { in: 'funko_data_enriched.json', out: null, dryRun: false, report: null };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--in':     o.in = argv[++i]; break;
      case '--out':    o.out = argv[++i]; break;
      case '--dry-run':o.dryRun = true; break;
      case '--report': o.report = argv[++i]; break;
      default: if (argv[i].startsWith('--')) { console.error('Unknown:', argv[i]); process.exit(1); }
    }
  }
  if (!o.out) o.out = o.in;
  return o;
}

// Strip a leading "#" number, [bracket] tags, (paren) qualifiers, HTML entities,
// and punctuation to get a comparable CORE NAME. Keeps the essential character
// name so "Luke Skywalker (Bespin) #93" and "Luke Skywalker (Bespin)" both reduce
// toward "luke skywalker bespin" — but we compare core WITHOUT the parens too.
function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
function coreName(title) {
  let s = decodeEntities(title || '').toLowerCase();
  s = s.replace(/#\s*\d+[a-z]?/g, ' ');          // drop #123 pop numbers
  s = s.replace(/\[[^\]]*\]/g, ' ');             // drop [Convention] tags
  s = s.replace(/\bbottle opener\b|\bbox\b|\bpop! protector\b/g, ' '); // accessory suffixes
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();      // punctuation → space
  return s;
}
// A tighter variant that also strips (parenthetical) variant qualifiers, to allow
// matching when one side carries the variant in the name and the other doesn't.
function coreNameNoParens(title) {
  return coreName(String(title || '').replace(/\([^)]*\)/g, ' '));
}
// Extract the funko number from either an explicit field or a "#<num>" in title.
function numOf(rec) {
  if (rec.funkoNumber !== undefined && rec.funkoNumber !== null && rec.funkoNumber !== '') {
    return String(rec.funkoNumber).replace(/^0+/, '') || '0';
  }
  const m = /#\s*(\d+)/.exec(rec.title || '');
  return m ? String(parseInt(m[1], 10)) : '';
}

const opts = parseArgs(process.argv);
const inPath = path.resolve(opts.in);
if (!fs.existsSync(inPath)) { console.error('Input not found:', inPath); process.exit(1); }
const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
console.log(`Loaded ${data.length} records from ${path.basename(inPath)}`);

const isPc  = r => r.funkoSource === 'pricecharting' || (r.handle || '').startsWith('pc-');
const pcRecords  = data.filter(isPc);
const nonPc      = data.filter(r => !isPc(r));
console.log(`  PriceCharting-sourced: ${pcRecords.length} | other: ${nonPc.length}`);

// Index the non-PriceCharting (canonical) records by funkoNumber and by core name.
const byNum = new Map();          // num -> [recordIndex,...]
const byCore = new Map();         // coreName -> [recordIndex,...]
data.forEach((r, i) => {
  if (isPc(r)) return;
  const n = numOf(r);
  if (n) { if (!byNum.has(n)) byNum.set(n, []); byNum.get(n).push(i); }
  for (const key of new Set([coreName(r.title), coreNameNoParens(r.title)])) {
    if (key) { if (!byCore.has(key)) byCore.set(key, []); byCore.get(key).push(i); }
  }
});

function mergeFill(target, src) {
  const fields = ['pricechartingId','pricechartingUrl','marketValueLoose',
                  'marketValueComplete','marketValueNew','upc','releaseDate','epid'];
  let changed = 0;
  for (const f of fields) {
    if (src[f] && (target[f] === undefined || target[f] === null || target[f] === '')) {
      target[f] = src[f]; changed++;
    }
  }
  return changed;
}

const toDrop = new Set();   // indices of pc duplicates to remove
const merges = [];          // {pcTitle, intoTitle, num} for the report
let merged = 0, fieldsAdded = 0;

data.forEach((r, i) => {
  if (!isPc(r)) return;
  const n = numOf(r);
  const core = coreName(r.title);
  const coreNP = coreNameNoParens(r.title);

  let matchIdx = -1;
  // 1) Strongest: same funkoNumber AND core-name token overlap.
  if (n && byNum.has(n)) {
    for (const ci of byNum.get(n)) {
      const c = coreName(data[ci].title), cnp = coreNameNoParens(data[ci].title);
      if (c === core || cnp === coreNP || c === coreNP || cnp === core ||
          shareAllShortTokens(core, c)) { matchIdx = ci; break; }
    }
  }
  // 2) Fallback: exact core-name match even without a number (rare but safe).
  if (matchIdx === -1) {
    for (const key of [core, coreNP]) {
      if (key && byCore.has(key)) { matchIdx = byCore.get(key)[0]; break; }
    }
  }

  if (matchIdx !== -1 && matchIdx !== i) {
    fieldsAdded += mergeFill(data[matchIdx], r);
    toDrop.add(i);
    merged++;
    if (merges.length < 500) merges.push({ num: n, pcTitle: r.title, intoTitle: data[matchIdx].title });
  }
});

// Token-overlap helper: true if the shorter core's tokens are all in the longer.
function shareAllShortTokens(a, b) {
  const ta = a.split(' ').filter(Boolean), tb = b.split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  if (short.length < 2) return false;       // need at least 2 tokens to be safe
  return short.every(t => long.has(t));
}

const result = data.filter((_, i) => !toDrop.has(i));
console.log(`\nMerged ${merged} PriceCharting duplicates into existing records ` +
            `(${fieldsAdded} fields filled).`);
console.log(`Records: ${data.length} → ${result.length} (removed ${data.length - result.length}).`);

if (opts.report) {
  fs.writeFileSync(path.resolve(opts.report), JSON.stringify(merges, null, 2));
  console.log(`Sample of merges written to ${opts.report} (first ${merges.length}).`);
}

if (opts.dryRun) {
  console.log('\n--dry-run: no file written. Review the report, then run without --dry-run.');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = inPath.replace(/\.json$/i, `.pre-dedupe.${stamp}.json`);
fs.copyFileSync(inPath, backup);
fs.writeFileSync(path.resolve(opts.out), JSON.stringify(result, null, 2));
console.log(`Backup: ${path.basename(backup)}`);
console.log(`Wrote:  ${path.basename(path.resolve(opts.out))}`);
