#!/usr/bin/env node
/**
 * upc_promote.js — Resolve UPCs that are missing from the catalog.
 *
 * MIT License, Copyright (c) 2026 Chris Ahrendt
 *
 * WHY THIS EXISTS
 * ---------------
 * 44 figures Chris owns are not in the base catalog. Because the app cannot find
 * them, it falls back to displaying the raw scan string he entered:
 *
 *     'Easter Stitch Funko Pop! Vinyl Figure #1533'
 *     'Funko Pop! Christmas Lilo & Stitch Angel with Lights #1505'
 *     'Funko POP! Marvel: Endgame - Captain America w/ Broken Shield & Mjolnir'
 *
 * Those are eBay listing titles, not Funko titles. Stripping them with a regex
 * is guesswork — where does the title start in "Funko Pop! Vinyl Figure Easter
 * Angel Lilo and Stitch Collection Pink 4 x 8 x 6 in"? So instead this resolves
 * each UPC against PriceCharting, which keys products by barcode.
 *
 * Resolving through the EXISTING catalog was tried and rejected: only 6 of 44
 * matched, and two of those six matched a record that carries the wrong UPC
 * (Chris's Captain America resolved to 'Callum ToyZilla Signed Edition' #750).
 * A catalog with known-bad UPC links cannot be used to repair titles.
 *
 * HOW IT WORKS
 * ------------
 * PriceCharting's product search accepts a barcode:
 *
 *     https://www.pricecharting.com/search-products?q=<upc>&type=prices
 *
 * A barcode should resolve to exactly one product. When it returns exactly one
 * `funko-pop-*` row, that is an exact-key match and is accepted. Anything else —
 * zero rows, or several — is reported for review rather than guessed at. This is
 * the same rule enrich.js applies in `fetchPcRowForRecord`.
 *
 * Plain fetch, no Puppeteer: PriceCharting serves static HTML. (enrich.js only
 * launches a browser for funko.com, which 403s non-browser clients.)
 *
 * The box number is the trailing digits of the product slug —
 * `/game/funko-pop-disney/easter-stitch-1533` → 1533 — which this session
 * established is authoritative: it agrees with `funkoNumber` on 14,988 of 15,063
 * catalog records, and wins all 122 disagreements with `seriesNumber`.
 *
 * OUTPUT
 * ------
 * A JSON array of catalog records in the shipped-base shape, ready to review and
 * then merge. Nothing is written into the catalog by this script.
 *
 * Usage:
 *     node upc_promote.js --input missing_upcs.json --out promoted.json
 *     node upc_promote.js --input missing_upcs.json --out promoted.json --apply
 *
 * `missing_upcs.json` is a JSON array of { upc, name } — `name` is only carried
 * through to the report so a human can sanity-check the match.
 */

'use strict';

const fs      = require('fs');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const PC_BASE   = 'https://www.pricecharting.com';
const PC_SEARCH = (q) => `${PC_BASE}/search-products?q=${encodeURIComponent(q)}&type=prices`;
const PC_DELAY  = 1100;   // ms between requests — be polite

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── UPC validation ───────────────────────────────────────────────────────────
// Only attempt a lookup for a barcode that could actually be a UPC-A.
function normalizeUpc(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 13 && d[0] === '0') return upcaValid(d.slice(1)) ? d.slice(1) : null;
  if (d.length === 12) return upcaValid(d) ? d : null;
  return null;
}
function upcaValid(u) {
  if (!/^\d{12}$/.test(u)) return false;
  let odd = 0, even = 0;
  for (let i = 0; i < 11; i++) (i % 2 === 0 ? (odd += +u[i]) : (even += +u[i]));
  return (10 - ((odd * 3 + even) % 10)) % 10 === +u[11];
}

// ── PriceCharting row parsing (mirrors enrich.js parsePriceChartingListing) ──
function pcFullSizeImage(src) {
  const m = String(src || '').match(
    /^(https?:\/\/storage\.googleapis\.com\/images\.pricecharting\.com\/[A-Za-z0-9]+)\/\d+\.jpg$/);
  return m ? `${m[1]}/1600.jpg` : '';
}

function parseRows(html) {
  const $ = cheerio.load(html);
  const out = [];
  const num = (t) => {
    const m = (t || '').match(/\$\s*([\d,]+\.\d{2})/);
    return m ? m[1].replace(/,/g, '') : null;
  };
  $('#games_table tbody tr').each((_, el) => {
    const a = $(el).find('a[href*="/game/"]').first();
    const href = a.attr('href') || '';
    if (!href) return;
    const consoleSlug = (href.match(/\/game\/([^/]+)\//) || [])[1] || '';
    out.push({
      id:       (a.attr('title') || '').trim() || href.split('/').filter(Boolean).pop(),
      name:     $(el).find('td.title').text().trim().replace(/\s+/g, ' '),
      console:  consoleSlug,
      href:     href.startsWith('http') ? href : `${PC_BASE}${href}`,
      imageUrl: pcFullSizeImage($(el).find('img.photo').first().attr('src')),
      loose:    num($(el).find('td').eq(3).text()),
      complete: num($(el).find('td').eq(4).text()),
      mint:     num($(el).find('td').eq(5).text()),
    });
  });
  return out;
}

/** `/game/funko-pop-disney/easter-stitch-1533` -> "1533" */
function boxNumberFromHref(href) {
  const m = String(href || '').match(/-(\d+)(?:\?|$)/);
  return m ? m[1] : '';
}

/** `funko-pop-disney` -> "Pop! Disney" */
const ACRONYMS = { wwe: 'WWE', nfl: 'NFL', mlb: 'MLB', nba: 'NBA', nhl: 'NHL', dc: 'DC', tv: 'TV' };
function seriesFromConsole(slug) {
  const m = String(slug || '').match(/^funko-pop-(.+)$/);
  if (!m) return '';
  return 'Pop! ' + m[1].split('-')
    .map((w) => ACRONYMS[w] || w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function handleFrom(title) {
  return String(title || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── lookup ───────────────────────────────────────────────────────────────────
async function lookupUpc(upc) {
  const res = await fetch(PC_SEARCH(upc), {
    headers: { 'User-Agent': 'Mozilla/5.0 (FunkoDex catalog builder)' },
    timeout: 30000,
  });
  if (!res.ok) return { status: 'http_error', code: res.status, rows: [] };

  const rows = parseRows(await res.text())
    .filter((r) => /^funko-pop-/.test(r.console || ''));

  // A barcode should resolve to exactly one product. Zero means PriceCharting
  // does not carry it; several means the barcode is ambiguous on their side.
  // Neither is guessed at — both are reported.
  if (rows.length === 1) return { status: 'resolved', rows };
  if (rows.length === 0) return { status: 'not_found', rows };
  return { status: 'ambiguous', rows };
}

function toCatalogRecord(upc, row) {
  const box    = boxNumberFromHref(row.href);
  const series = seriesFromConsole(row.console);
  const handle = handleFrom(row.name);
  const rec = {
    _id: `catalog::${handle}`,
    type: 'catalog',
    handle,
    title: row.name,
    series,
    category: series,
    upc,
    funkoNumber: box,
    seriesNumber: box ? `#${box}` : '',
    isExclusive: false,
    exclusiveRetailer: '',
    isChase: false,
    source: 'PRICECHARTING_UPC',
    lastUpdated: new Date().toISOString().slice(0, 10),
    pricechartingUrl: row.href,
    pricechartingId: row.id,
  };
  if (row.imageUrl) rec.imageUrl = row.imageUrl;
  if (row.loose)    rec.marketValueLoose = row.loose;
  if (row.complete) rec.marketValueComplete = row.complete;
  if (row.mint)     rec.marketValueNew = row.mint;
  return rec;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const arg  = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const input = arg('--input');
  const out   = arg('--out');
  const apply = args.includes('--apply');
  if (!input || !out) {
    console.error('usage: node upc_promote.js --input missing_upcs.json --out promoted.json [--apply]');
    process.exit(1);
  }

  const wanted = JSON.parse(fs.readFileSync(input, 'utf8'));
  console.log(`${wanted.length} UPCs to resolve\n`);

  const promoted = [];
  const review   = [];
  let i = 0;

  for (const item of wanted) {
    i++;
    const upc = normalizeUpc(item.upc);
    // A UPC that fails the checksum was never a real barcode; do not spend a
    // request on it.
    const label = String(item.name || '').slice(0, 52);
    if (!upc) {
      review.push({ ...item, status: 'invalid_upc' });
      console.log(`[${i}/${wanted.length}] ${item.upc}  INVALID UPC  ${label}`);
      continue;
    }

    let r;
    try {
      r = await lookupUpc(upc);
    } catch (err) {
      review.push({ ...item, status: 'fetch_error', error: err.message });
      console.log(`[${i}/${wanted.length}] ${upc}  ERROR ${err.message}`);
      await sleep(PC_DELAY);
      continue;
    }

    if (r.status === 'resolved') {
      const rec = toCatalogRecord(upc, r.rows[0]);
      promoted.push(rec);
      console.log(`[${i}/${wanted.length}] ${upc}  ->  ${rec.title} #${rec.funkoNumber}  (${rec.series})`);
      console.log(`      was: ${label}`);
    } else {
      review.push({ ...item, upc, status: r.status,
                    candidates: r.rows.map((x) => ({ name: x.name, href: x.href })) });
      console.log(`[${i}/${wanted.length}] ${upc}  ${r.status.toUpperCase()}` +
                  (r.rows.length ? ` (${r.rows.length} rows)` : '') + `  ${label}`);
    }
    await sleep(PC_DELAY);
  }

  console.log(`\n-- summary ---------------------------------------------------`);
  console.log(`  resolved : ${promoted.length}`);
  console.log(`  review   : ${review.length}`);
  const byStatus = {};
  review.forEach((r) => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
  Object.entries(byStatus).forEach(([k, v]) => console.log(`    ${v}  ${k}`));

  // Duplicate handles would collide with existing catalog ids.
  const seen = new Set();
  const dupes = promoted.filter((r) => seen.has(r._id) ? true : (seen.add(r._id), false));
  if (dupes.length) {
    console.log(`\n  !! ${dupes.length} duplicate _id among resolved records:`);
    dupes.forEach((d) => console.log(`     ${d._id}`));
  }

  if (!apply) {
    console.log('\n(dry-run -- nothing written. Re-run with --apply)');
    return;
  }

  fs.writeFileSync(out, JSON.stringify(promoted, null, 2), 'utf8');
  console.log(`\n  written: ${out}  (${promoted.length} records)`);
  const rp = out.replace(/\.json$/, '.review.json');
  fs.writeFileSync(rp, JSON.stringify(review, null, 2), 'utf8');
  console.log(`  review : ${rp}  (${review.length} records)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
