/**
 * harvest_facets.js — funko.com facet harvester (standalone, run after a full enrich.js regen)
 *
 * MIT License, Copyright (c) 2026 Chris Ahrendt
 *
 * Two jobs, both sourced from funko.com's /all-funko-products/ faceted listing:
 *
 *   (a) VOCABULARY  — extract the three facet dimensions (Fandom, License, Series)
 *                     with their canonical names + counts into funko_facets.json.
 *                     This is a controlled vocabulary for normalising grouping tags
 *                     across the whole catalog (not just current-stock items).
 *
 *   (b) MEMBERSHIP  — for each facet value, drive the live page (click the facet,
 *                     wait for the JS re-render, scrape the narrowed product list)
 *                     and tag each matched product with its funko.com
 *                     fandom / license / series. Merged into funko_data_enriched.json.
 *
 * WHY A SEPARATE SCRIPT (not a pass in enrich.js):
 *   - It is slow (≈250+ facet interactions) and only covers funko.com's CURRENT
 *     ~2,900-item catalog, so it should not gate or lengthen the main regen.
 *   - funko.com applies facet filtering CLIENT-SIDE: the prefn1/prefv1 URL params
 *     do NOT filter server-side (verified — the param URL returns the full
 *     unfiltered catalog). So (b) must click the checkbox and wait for the
 *     re-render; a plain fetch of the facet URL cannot work.
 *
 * DEFENSIVE DESIGN:
 *   Because the click-and-wait is the load-bearing risk, every facet scrape
 *   verifies the result count actually DROPPED from the unfiltered total before
 *   trusting the products. If a facet's count did not narrow, that facet is
 *   skipped with a warning rather than mis-tagging every product with every facet.
 *
 * USAGE:
 *   node harvest_facets.js [options]
 *     --enriched <path>   Enriched catalog to tag      (default: funko_data_enriched.json)
 *     --facets-out <path> Vocabulary output            (default: funko_facets.json)
 *     --vocab-only        Do (a) only; skip the per-facet membership scrape (b)
 *     --limit <N>         (b) cap: only scrape the first N facet values (testing)
 *     --delay <ms>        Delay between facet interactions (default: 1200)
 *     --chrome-path <p>   Path to Chrome/Edge (default: auto-detect)
 *     --dims <list>       Comma list of dimensions to scrape for (b):
 *                         fandom,license,series  (default: all three)
 *
 * OUTPUTS:
 *   funko_facets.json                      — the vocabulary (a), always written
 *   funko_data_enriched.json (in place)    — tagged with funkoFandom/License/Series (b)
 *   A dated backup of the enriched file is written before (b) mutates it.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const FUNKO_BASE   = 'https://www.funko.com';
const ALL_PRODUCTS = `${FUNKO_BASE}/all-funko-products/`;

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    enriched:   'funko_data_enriched.json',
    facetsOut:  'funko_facets.json',
    vocabOnly:  false,
    limit:      0,            // 0 = no cap
    delay:      1200,
    chromePath: null,
    dims:       ['fandom', 'license', 'series'],
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--enriched':    opts.enriched   = argv[++i]; break;
      case '--facets-out':  opts.facetsOut  = argv[++i]; break;
      case '--vocab-only':  opts.vocabOnly  = true; break;
      case '--limit':       opts.limit      = parseInt(argv[++i], 10) || 0; break;
      case '--delay':       opts.delay      = parseInt(argv[++i], 10) || 1200; break;
      case '--chrome-path': opts.chromePath = argv[++i]; break;
      case '--dims':        opts.dims = argv[++i].split(',').map(s => s.trim().toLowerCase()).filter(Boolean); break;
      default:
        if (argv[i].startsWith('--')) { console.error(`Unknown option: ${argv[i]}`); process.exit(1); }
    }
  }
  return opts;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Chrome resolution (mirrors enrich.js) ────────────────────────────────────
function findChrome(override) {
  if (override) {
    if (fs.existsSync(override)) return override;
    throw new Error(`--chrome-path not found: ${override}`);
  }
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  throw new Error('Chrome/Edge not found — pass --chrome-path');
}

// ── Title normalisation (mirrors enrich.js findIndex matching) ───────────────
function normaliseTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/^pop!?\s+/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── Facet vocabulary extraction (a) ──────────────────────────────────────────
// The three facet blocks render in static HTML as labelled lists:
//   "Refine by Fandom: <Name> (<count>)"  /  "Refine by License: ..."  /  "Refine by Series: ..."
// Plus a plainer rendering "<Name> (<count>)" under each "Filter products by X:" heading.
// We parse the "Refine by <Dim>: <Name> (<count>)" form — it is unambiguous about which
// dimension each value belongs to.
function extractFacetVocabulary(html) {
  const vocab = { fandom: {}, license: {}, series: {} };
  const re = /Refine by (Fandom|License|Series):\s*(.+?)\s*\((\d[\d,]*)\)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const dim   = m[1].toLowerCase();
    const name  = m[2].trim();
    const count = parseInt(m[3].replace(/,/g, ''), 10);
    if (name && vocab[dim] && vocab[dim][name] === undefined) vocab[dim][name] = count;
  }
  return vocab;
}

// ── Product tile parsing (mirrors enrich.js parseTiles, trimmed to what we need) ─
function parseTiles(html) {
  const $ = cheerio.load(html);
  const products = [];
  const tileSelectors = ['.product-tile', '.b-product-tile', '[data-pid]', '.product-grid-item', 'article.product'];
  let tiles = $();
  for (const sel of tileSelectors) { tiles = $(sel); if (tiles.length > 0) break; }
  if (tiles.length === 0) tiles = $('[data-product-id], [data-itemid]');
  if (tiles.length === 0) return null;

  tiles.each((_, el) => {
    const tile = $(el);
    const title =
      tile.find('.product-name, .b-product-tile__name, .product-title, h2, h3').first().text().trim() ||
      tile.attr('data-name') || tile.attr('aria-label') || '';
    if (!title) return;
    const href = tile.find('a[href*="/products/"]').first().attr('href') ||
                 tile.find('a').first().attr('href') || '';
    const handle = href
      ? (href.split('/products/')[1]?.split('?')[0]?.split('/')[0] || href.split('/').pop())
      : '';
    const pid = tile.attr('data-pid') || tile.attr('data-product-id') || tile.attr('data-itemid') || '';
    products.push({ pid, handle, title });
  });
  return products;
}

// Read the live result-count ("... of N Items" / "(N) Results") from the page.
async function readResultCount(page) {
  return page.evaluate(() => {
    const txt = document.body.innerText;
    let m = txt.match(/of\s+([\d,]+)\s+Items/i) || txt.match(/\(([\d,]+)\)\s+Results/i);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : -1;
  });
}

// ── Per-facet membership scrape (b) ──────────────────────────────────────────
// Click the checkbox for one facet value, verify the count narrowed, scrape all
// pages of the filtered list. Returns { ok, count, products } — ok=false means the
// facet did not narrow (client-side filter didn't apply) and must be skipped.
async function scrapeFacet(page, dim, value, unfilteredTotal, opts) {
  // Selector for the facet checkbox: funko renders an input/label whose accessible
  // text is "Refine by <Dim>: <Value> (<count>)". We match on that aria/label text.
  const refineText = `Refine by ${dim[0].toUpperCase() + dim.slice(1)}: ${value} (`;

  // Reset to the unfiltered listing first so facets don't stack.
  await page.goto(`${ALL_PRODUCTS}?sz=48&start=0`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => /(?:of\s+[\d,]+\s+Items|\([\d,]+\)\s+Results)/i.test(document.body.innerText),
    { timeout: 10000 }
  ).catch(() => {});

  // Find and click the matching facet control.
  const clicked = await page.evaluate((needle) => {
    // Look across links, labels, buttons, and checkboxes for the refine text.
    const nodes = Array.from(document.querySelectorAll('a, label, button, [role="checkbox"], input'));
    for (const n of nodes) {
      const t = (n.getAttribute('aria-label') || n.textContent || n.title || '').trim();
      if (t.startsWith(needle)) {
        // Prefer an associated clickable: the element itself or its closest anchor/label.
        const target = n.closest('a, label, button, [role="checkbox"]') || n;
        target.click();
        return true;
      }
    }
    return false;
  }, refineText);

  if (!clicked) return { ok: false, reason: 'facet control not found', count: -1, products: [] };

  // Wait for the count to change away from the unfiltered total.
  await page.waitForFunction(
    (total) => {
      const txt = document.body.innerText;
      const m = txt.match(/of\s+([\d,]+)\s+Items/i) || txt.match(/\(([\d,]+)\)\s+Results/i);
      if (!m) return false;
      const n = parseInt(m[1].replace(/,/g, ''), 10);
      return n > 0 && n !== total;
    },
    { timeout: 12000 },
    unfilteredTotal
  ).catch(() => {});

  const count = await readResultCount(page);
  // Guard: if the count did not narrow, the client-side filter didn't apply —
  // do NOT trust the products (they'd be the whole catalog). Skip this facet.
  if (count < 0 || count >= unfilteredTotal) {
    return { ok: false, reason: `count did not narrow (got ${count}, total ${unfilteredTotal})`, count, products: [] };
  }

  // Scrape all products for this facet. The filtered view paginates the same way;
  // we page by actual products returned until we've collected `count` (or pages run dry).
  const collected = new Map(); // handle|title -> {handle,title,pid}
  let guardPages = 0;
  while (collected.size < count && guardPages < 60) {
    const html = await page.content();
    const tiles = parseTiles(html) || [];
    let added = 0;
    for (const p of tiles) {
      const key = p.handle || normaliseTitle(p.title);
      if (key && !collected.has(key)) { collected.set(key, p); added++; }
    }
    // Click "Show More" if present to load the next chunk; stop if it's gone or nothing new.
    const more = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('a, button'))
        .find(b => /show more/i.test(b.textContent || ''));
      if (btn) { btn.click(); return true; }
      return false;
    });
    guardPages++;
    if (!more && added === 0) break;
    await sleep(opts.delay);
  }

  return { ok: true, count, products: [...collected.values()] };
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async function main() {
  const opts = parseArgs(process.argv);
  console.log('funko.com facet harvester');
  console.log(`  enriched: ${opts.enriched}`);
  console.log(`  facets-out: ${opts.facetsOut}`);
  console.log(`  mode: ${opts.vocabOnly ? 'vocabulary only (a)' : 'vocabulary (a) + membership (b)'}`);
  if (!opts.vocabOnly) console.log(`  dims: ${opts.dims.join(', ')}${opts.limit ? `  (limit ${opts.limit}/dim)` : ''}`);

  let chromePath;
  try { chromePath = findChrome(opts.chromePath); console.log(`  Chrome: ${chromePath}`); }
  catch (e) { console.error(`  ERROR: ${e.message}`); process.exit(1); }

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // ── (a) VOCABULARY ────────────────────────────────────────────────────────
    console.log('\n── (a) Extracting facet vocabulary ──');
    await page.goto(`${ALL_PRODUCTS}?sz=48&start=0`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => /Refine by (Fandom|License|Series):/i.test(document.body.innerHTML),
      { timeout: 12000 }
    ).catch(() => {});
    const vocabHtml = await page.content();
    const unfilteredTotal = await readResultCount(page);
    const vocab = extractFacetVocabulary(vocabHtml);
    const vCounts = {
      fandom:  Object.keys(vocab.fandom).length,
      license: Object.keys(vocab.license).length,
      series:  Object.keys(vocab.series).length,
    };
    console.log(`  Unfiltered catalog total: ${unfilteredTotal > 0 ? unfilteredTotal.toLocaleString() : 'undetected'}`);
    console.log(`  Fandom: ${vCounts.fandom} | License: ${vCounts.license} | Series: ${vCounts.series}`);

    fs.writeFileSync(path.resolve(opts.facetsOut), JSON.stringify({
      source: ALL_PRODUCTS,
      harvestedAt: new Date().toISOString(),
      unfilteredTotal,
      counts: vCounts,
      vocabulary: vocab,
    }, null, 2), 'utf8');
    console.log(`  Wrote ${opts.facetsOut}`);

    if (opts.vocabOnly) { console.log('\n--vocab-only set; skipping membership scrape (b).'); await browser.close(); return; }
    if (unfilteredTotal <= 0) {
      console.error('  Could not detect the unfiltered total; (b) needs it to verify narrowing. Aborting (b).');
      await browser.close();
      return;
    }

    // ── (b) MEMBERSHIP ────────────────────────────────────────────────────────
    console.log('\n── (b) Scraping per-facet product membership ──');
    // handle/title-key -> { fandom:Set, license:Set, series:Set }
    const tagMap = new Map();
    const ensure = key => {
      if (!tagMap.has(key)) tagMap.set(key, { fandom: new Set(), license: new Set(), series: new Set() });
      return tagMap.get(key);
    };

    let skipped = 0, scraped = 0;
    for (const dim of opts.dims) {
      const values = Object.keys(vocab[dim] || {});
      if (values.length === 0) { console.log(`  [${dim}] no facet values; skipping`); continue; }
      const slice = opts.limit ? values.slice(0, opts.limit) : values;
      console.log(`  [${dim}] ${slice.length} facet value(s)`);

      for (const value of slice) {
        process.stdout.write(`    ${dim}: ${value} ... `);
        let res;
        try { res = await scrapeFacet(page, dim, value, unfilteredTotal, opts); }
        catch (e) { console.log(`error: ${e.message} — skipped`); skipped++; continue; }

        if (!res.ok) { console.log(`skipped (${res.reason})`); skipped++; await sleep(opts.delay); continue; }

        for (const p of res.products) {
          const key = p.handle || normaliseTitle(p.title);
          if (key) ensure(key)[dim].add(value);
        }
        console.log(`${res.count} products`);
        scraped++;
        await sleep(opts.delay);
      }
    }
    console.log(`  Facets scraped: ${scraped} | skipped: ${skipped} | tagged keys: ${tagMap.size}`);

    if (tagMap.size === 0) {
      console.warn('  No facet membership collected — likely the client-side filter never narrowed. '
        + 'Nothing merged. The vocabulary (a) was still written.');
      await browser.close();
      return;
    }

    // ── Merge tags into the enriched catalog ──────────────────────────────────
    const enrichedPath = path.resolve(opts.enriched);
    if (!fs.existsSync(enrichedPath)) {
      console.error(`  Enriched file not found: ${enrichedPath} — tags not merged. (Vocabulary still written.)`);
      await browser.close();
      return;
    }
    const data = JSON.parse(fs.readFileSync(enrichedPath, 'utf8'));

    // Build lookup by handle and by normalised title (mirrors enrich.js findIndex).
    const byHandle = new Map();
    const byTitle  = new Map();
    data.forEach((rec, i) => {
      if (rec.handle) byHandle.set(rec.handle.toLowerCase(), i);
      const nt = normaliseTitle(rec.title);
      if (nt && !byTitle.has(nt)) byTitle.set(nt, i);
    });

    let matched = 0, addedTags = 0;
    for (const [key, dims] of tagMap.entries()) {
      let idx = byHandle.get(String(key).toLowerCase());
      if (idx === undefined) idx = byTitle.get(normaliseTitle(key));
      if (idx === undefined) continue; // funko.com product not in our catalog — skip
      matched++;
      const rec = data[idx];
      const apply = (field, set) => {
        if (set.size === 0) return;
        const cur = new Set(Array.isArray(rec[field]) ? rec[field] : []);
        const before = cur.size;
        set.forEach(v => cur.add(v));
        if (cur.size !== before) { rec[field] = [...cur]; addedTags += (cur.size - before); }
      };
      apply('funkoFandom',  dims.fandom);
      apply('funkoLicense', dims.license);
      apply('funkoSeries',  dims.series);
    }
    console.log(`  Matched ${matched}/${tagMap.size} facet keys to catalog records; added ${addedTags} tags.`);

    // Backup then write in place (additive only — never removes existing fields).
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = enrichedPath.replace(/\.json$/i, `.pre-facets.${stamp}.json`);
    fs.copyFileSync(enrichedPath, backup);
    fs.writeFileSync(enrichedPath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`  Backup: ${path.basename(backup)}`);
    console.log(`  Updated: ${path.basename(enrichedPath)}`);
    console.log('\nDone. New fields: funkoFandom[], funkoLicense[], funkoSeries[] (additive, current-catalog items only).');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
