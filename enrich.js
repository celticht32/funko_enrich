/**
 * Funko Data Enricher
 * MIT License, Copyright (c) 2026 Chris Ahrendt
 *
 * Three-pass enrichment pipeline:
 *   Pass 1 — Kenny Chan GitHub (MIT open dataset, ~23k records)
 *             Fills catalog gaps — items not in your HobbyDB source.
 *   Pass 2 — funko.com scrape
 *             Adds: price, available, productUrl, funkoPrimaryImage, pid
 *   Pass 3 — PriceCharting.com scrape
 *             Adds: marketValueLoose, marketValueComplete, marketValueNew,
 *                   pricechartingId, pricechartingUrl
 *             Only runs on records still missing market pricing after Pass 2.
 *
 * Usage:
 *   node enrich.js [options]
 *
 * Options:
 *   --input           Path to existing funko_data.json  (default: funko_data.json)
 *   --output          Path for enriched output           (default: funko_data_enriched.json)
 *   --delay           Milliseconds between requests      (default: 1500)
 *   --max-pages       Stop funko.com after N pages       (default: 0 = unlimited)
 *   --skip-kenny      Skip Pass 1 (Kenny Chan merge)
 *   --skip-funko      Skip Pass 2 (funko.com scrape)
 *   --skip-pc         Skip Pass 3 (PriceCharting scrape)
 *   --pc-limit        Max items to look up on PriceCharting (default: 100000 = all)
 *   --pc-crawl        Pass 3b: discover & add PriceCharting Pops not in catalog (DEFAULT ON)
 *   --no-pc-crawl     Disable Pass 3b (faster runs that don't grow the record set)
 *   --pc-crawl-limit  Cap console sets crawled in Pass 3b (default: no cap)
 *   --pc-fill-upc     Pass 3: also fill UPC on priced-but-no-UPC records (DEFAULT ON)
 *   --no-pc-fill-upc  Disable the UPC top-up
 *   --skip-hdb        Skip Pass 4 (HobbyDB Reference Numbers / series scrape)
 *   --hdb-limit       Max HobbyDB lookups per run        (default: 5000)
 *   --hdb-delay       Milliseconds between HobbyDB requests (default: 1500)
 *   --hdb-all         Re-check all HobbyDB records, ignoring hdbChecked
 *   --retry-no-refs   Re-fetch hdbChecked records that have no hdbid
 *   --retry-no-series Re-fetch hdbChecked records missing series tags
 *
 *   NOTE: defaults are tuned for the MOST COMPLETE build (Pass 3b on, no pricing
 *   cap, large HobbyDB limit, UPC fill on), so a plain `node enrich.js` is the
 *   full golden-master run (and the longest). Use --no-pc-crawl / --pc-limit N /
 *   --skip-* for quick partial runs.
 *                     (use this to backfill `series` via parseHobbyDbSeries
 *                     on records already scraped before that field existed,
 *                     without rebuilding from scratch)
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');

// ─── CLI args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    input:      'funko_data.json',
    output:     'funko_data_enriched.json',
    delay:      1500,
    maxPages:   0,
    skipKenny:  false,
    skipFunko:  false,
    skipPc:     false,
    // Completeness-maximizing defaults: a plain `node enrich.js` now does the
    // most complete build possible (longest run). Use the --no-* / smaller-limit
    // flags below for quick test runs.
    pcLimit:    100000, // Pass 3: price every unpriced candidate (was 500 cap)
    pcCrawl:    true,   // Pass 3b: discover & add PriceCharting Pops not in catalog
    pcCrawlLimit: Infinity, // no cap on console-set crawl
    pcFillUpc:  true,   // Pass 3: also revisit priced-but-no-UPC records to fill UPC
    chromePath: null,
    popsOnly:   false,
    skipHdb:    false,
    hdbLimit:   1000000, // effectively uncapped — process every HobbyDB candidate
                         // in one run (resume + checkpoints make a long run crash-safe).
                         // Lower it (--hdb-limit N) only for quick partial test runs.
    hdbDelay:   1500,   // ms between HobbyDB requests
    hdbAll:          false,  // look up all records, not just missing
    retryNoRefs:     false,  // re-fetch records with hdbChecked but no hdbid
    retryNoSeries:   false,  // re-fetch hdbChecked HobbyDB records missing series tags
    skipFunkoDetail:  false,
    funkoDetailDelay: 1000,  // ms between product page fetches (domcontentloaded = fast)
    popFilter:  true,   // keep only standard Pops from funko.com
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input':       opts.input      = args[++i]; opts.inputExplicit = true; break;
      case '--output':      opts.output     = args[++i]; break;
      case '--delay':       opts.delay      = parseInt(args[++i], 10); break;
      case '--max-pages':   opts.maxPages   = parseInt(args[++i], 10); break;
      case '--skip-kenny':  opts.skipKenny  = true; break;
      case '--skip-funko':  opts.skipFunko  = true; break;
      case '--skip-pc':     opts.skipPc     = true; break;
      case '--pc-limit':    opts.pcLimit    = parseInt(args[++i], 10); break;
      case '--pc-crawl':    opts.pcCrawl    = true; break;
      case '--no-pc-crawl':    opts.pcCrawl   = false; break; // opt out of Pass 3b (faster test runs)
      case '--no-pc-fill-upc': opts.pcFillUpc = false; break; // opt out of UPC top-up
      case '--pc-crawl-limit': opts.pcCrawlLimit = parseInt(args[++i], 10); break;
      case '--pc-fill-upc': opts.pcFillUpc = true; break;
      case '--chrome-path': opts.chromePath = args[++i]; break;
      case '--pops-only':   opts.popsOnly   = true; break;
      case '--no-pop-filter': opts.popFilter = false; break;
      case '--skip-hdb':    opts.skipHdb   = true; break;
      case '--hdb-limit':   opts.hdbLimit  = parseInt(args[++i], 10); break;
      case '--hdb-delay':   opts.hdbDelay  = parseInt(args[++i], 10); break;
      case '--hdb-all':          opts.hdbAll          = true; break;
      case '--retry-no-refs':    opts.retryNoRefs     = true; break;
      case '--retry-no-series':  opts.retryNoSeries   = true; break;
      case '--skip-funko-detail': opts.skipFunkoDetail = true; break;
      case '--funko-detail-delay': opts.funkoDetailDelay = parseInt(args[++i], 10); break;
    }
  }
  return opts;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalise a title for fuzzy matching */
function normaliseTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trim leading/trailing whitespace and collapse internal runs to single space */
function sanitiseTitle(t) {
  return (t || '').replace(/\s+/g, ' ').trim();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Clean a scraped price string into a plain "NN.NN" value.
 * funko.com sale prices come through as multi-line blocks like
 * "Price reduced from $14.99 to $4.50 (70% off)" — we extract the SALE price
 * (the last dollar amount when a reduction is present, else the first).
 * Returns "" if no dollar amount found.
 */
function cleanPrice(raw) {
  if (!raw) return '';
  const matches = raw.match(/\$\s*(\d+\.\d{2})/g);
  if (!matches || matches.length === 0) return '';
  const nums = matches.map(m => m.replace(/[^0-9.]/g, ''));
  // If this is a reduction block, the sale price is the last amount
  if (/reduced|off|\bto\b/i.test(raw) && nums.length > 1) {
    return nums[nums.length - 1];
  }
  return nums[0];
}

// ─── Standard-Pop classifier ───────────────────────────────────────────────────
//
// funko.com's catalog includes bags, wallets, keychains, pins, glitter globes,
// Bitty/Pocket Pops, protectors, and display cases alongside standard Pop figures.
// This keeps ONLY standard Pop figures and drops the rest. Returns the cleaned
// title if it is a standard Pop, or null if it should be dropped. Protector
// bundles ("... with Pop! Protector") are kept with the suffix stripped.

const DROP_LINES         = /\b(bitty pop|pocket pop|mystery min|mini vinyl figures)\b/i;
const ACCESSORY_KEYWORDS = /\b(backpack|wallet|crossbody|tote|globe|lanyard|keychain|charm|sling|cardholder|coin bag|zip around|glitter globe)\b/i;
const ACCESSORY_STANDALONE = /\b(pin|pins|case|cases|display|stand|bag|bags)\b/ig;
const PROTECTOR_SUFFIX   = /\s+with Pop!\s*Protector\s*$/i;

// Splits a "Pop!" title into its subtype (size/format class) and the clean name.
// "Pop! Rides Deluxe SpongeBob with Mystery" -> { popType: "Rides Deluxe", name: "SpongeBob with Mystery" }
// "Pop! Man Ray" -> { popType: "Standard", name: "Man Ray" }
// Subtypes carry collector-relevant info (size, format) so we keep them in a field.
// Note: "Super" is NOT treated as a subtype when followed by "Saiyan" (character name).
const POP_SUBTYPES = /^Pop!\s+((?:(?:Rides Deluxe|Rides|Deluxe|Super(?!\s+Saiyan)|Jumbo|Moments|Moment|Premium|Plus|Towns|Town|Nooks|Comic Cover|Cover|Album|Die-Cast|Movie Poster|Gamerverse|Pez)\s+)+)/i;
function splitPopTitle(title) {
  const t = (title || '').trim();
  const m = t.match(POP_SUBTYPES);
  if (m) {
    const popType = m[1].trim().replace(/\s+/g, ' ');
    const name    = t.slice(m[0].length).trim();
    return { popType, name };
  }
  // No subtype — plain "Pop! <name>"
  const name = t.replace(/^Pop!\s+/i, '').trim();
  return { popType: 'Standard', name };
}

function classifyPop(title) {
  let t = (title || '').trim();
  t = t.replace(PROTECTOR_SUFFIX, '').trim();
  if (!/^pop!/i.test(t)) return null;
  if (DROP_LINES.test(t)) return null;
  if (ACCESSORY_KEYWORDS.test(t)) return null;
  ACCESSORY_STANDALONE.lastIndex = 0;
  let m;
  while ((m = ACCESSORY_STANDALONE.exec(t)) !== null) {
    const end = m.index + m[0].length;
    if (end < t.length && t[end] === '-') continue;
    return null;
  }
  return splitPopTitle(t);  // { popType, name }
}

/** Fetch with retry on 429 / 5xx */
async function fetchWithRetry(url, opts = {}, retries = 3, backoff = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        ...opts,
      });
      if (res.status === 429 || res.status >= 500) {
        console.warn(`    HTTP ${res.status} attempt ${attempt}/${retries} — waiting ${backoff * attempt}ms`);
        await sleep(backoff * attempt);
        continue;
      }
      return res;
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`    Network error attempt ${attempt}/${retries}: ${err.message}`);
      await sleep(backoff * attempt);
    }
  }
  return null;
}

// ─── Index management ────────────────────────────────────────────────────────

function buildIndexes(records) {
  const titleIndex  = new Map();
  const handleIndex = new Map();
  records.forEach((rec, i) => {
    if (rec.title)  titleIndex.set(normaliseTitle(rec.title), i);
    if (rec.handle) handleIndex.set(rec.handle.toLowerCase(), i);
  });
  return { titleIndex, handleIndex };
}

function findIndex(handle, title, handleIndex, titleIndex) {
  const h = (handle || '').toLowerCase();
  if (h && handleIndex.has(h)) return handleIndex.get(h);
  const t = normaliseTitle(title || '');
  if (t && titleIndex.has(t)) return titleIndex.get(t);
  return -1;
}

// ─── Merge logic ─────────────────────────────────────────────────────────────

/**
 * Merge scraped fields into an existing record.
 * Core identity fields (handle, title, imageName, series) are never overwritten.
 * New fields are only written if not already present (or if always-update flagged).
 */
function mergeRecord(existing, scraped) {
  const merged = { ...existing };

  // funko.com fields
  if (scraped.pid             && !merged.pid)              merged.pid              = scraped.pid;
  if (scraped.price           && !merged.price)            merged.price            = scraped.price;
  if (scraped.available       !== undefined)               merged.available        = scraped.available;
  if (scraped.productUrl      && !merged.productUrl)       merged.productUrl       = scraped.productUrl;
  if (scraped.funkoPrimaryImage && !merged.funkoPrimaryImage)
                                                           merged.funkoPrimaryImage = scraped.funkoPrimaryImage;
  if (scraped.funkoSource)                                 merged.funkoSource      = scraped.funkoSource;
  if (scraped.popType           && !merged.popType)        merged.popType          = scraped.popType;

  // PriceCharting fields
  if (scraped.marketValueLoose    && !merged.marketValueLoose)    merged.marketValueLoose    = scraped.marketValueLoose;
  if (scraped.marketValueComplete && !merged.marketValueComplete) merged.marketValueComplete = scraped.marketValueComplete;
  if (scraped.marketValueNew      && !merged.marketValueNew)      merged.marketValueNew      = scraped.marketValueNew;
  if (scraped.pricechartingId   && !merged.pricechartingId)   merged.pricechartingId   = scraped.pricechartingId;
  if (scraped.pricechartingUrl  && !merged.pricechartingUrl)  merged.pricechartingUrl  = scraped.pricechartingUrl;

  // Union-merge series arrays
  if (scraped.series && scraped.series.length) {
    const existingSeries = new Set(merged.series || []);
    scraped.series.forEach(s => existingSeries.add(s));
    merged.series = [...existingSeries];
  }

  return merged;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PASS 1 — Kenny Chan GitHub dataset merge
// ═══════════════════════════════════════════════════════════════════════════════

const KENNY_URL = 'https://raw.githubusercontent.com/kennymkchan/funko-pop-data/master/funko_pop.json';

/**
 * Downloads the Kenny Chan open-source dataset and merges any records not
 * already present in our working set. This catches items that HobbyDB missed.
 * Kenny's fields: handle, title, image (URL), series[]
 * His 'image' field maps to our 'imageName' (same HobbyDB CDN source).
 */
async function passKennyChan(enriched, titleIndex, handleIndex) {
  console.log('\n── Pass 1: Kenny Chan GitHub dataset ──────────────────────────');
  console.log(`  Downloading from: ${KENNY_URL}`);

  let kennyRecords;
  try {
    const res = await fetchWithRetry(KENNY_URL);
    if (!res || !res.ok) {
      console.warn(`  Failed to fetch Kenny Chan data (HTTP ${res ? res.status : 'N/A'}) — skipping.`);
      return { newCount: 0, enrichedCount: 0 };
    }
    const text = await res.text();
    kennyRecords = JSON.parse(text);
  } catch (err) {
    console.warn(`  Error fetching/parsing Kenny Chan data: ${err.message} — skipping.`);
    return { newCount: 0, enrichedCount: 0 };
  }

  console.log(`  Downloaded ${kennyRecords.length} records`);

  let newCount      = 0;
  let enrichedCount = 0;

  for (const rec of kennyRecords) {
    const handle = (rec.handle || '').trim();
    const title  = (rec.title  || '').trim();
    if (!handle && !title) continue;

    const idx = findIndex(handle, title, handleIndex, titleIndex);

    if (idx !== -1) {
      // Existing record — fill image if missing (Kenny uses same HobbyDB CDN)
      const existing = enriched[idx];
      if (rec.image && !existing.imageName) {
        enriched[idx] = { ...existing, imageName: rec.image };
        enrichedCount++;
      }
    } else {
      // New record not in our base set
      const normTitle  = normaliseTitle(title);
      const normHandle = handle.toLowerCase();
      const newRec = {
        handle:    handle || normTitle.replace(/\s+/g, '-'),
        title:     sanitiseTitle(title),
        imageName: rec.image || '',
        series:    rec.series || [],
        kennySource: true,
      };
      const newIdx = enriched.length;
      enriched.push(newRec);
      if (normTitle)  titleIndex.set(normTitle, newIdx);
      if (normHandle) handleIndex.set(normHandle, newIdx);
      newCount++;
    }
  }

  console.log(`  New records added: ${newCount}`);
  console.log(`  Existing records enriched: ${enrichedCount}`);
  return { newCount, enrichedCount };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PASS 2 — funko.com scrape (Puppeteer + stealth)
// ═══════════════════════════════════════════════════════════════════════════════
//
// funko.com returns 403 to plain fetch requests — it uses bot detection that
// requires a real browser fingerprint. We use puppeteer-core (no bundled
// Chromium) + puppeteer-extra-plugin-stealth to render pages in your locally
// installed Chrome, bypassing the detection.
//
// Chrome executable is auto-detected from common Windows install paths.
// Override with --chrome-path "C:\path\to\chrome.exe" if needed.

const puppeteer      = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const FUNKO_BASE = 'https://www.funko.com';

// Common Chrome install locations on Windows — tried in order
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA
    ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
    : '',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',  // Edge fallback
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function findChrome(override) {
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`Chrome not found at: ${override}`);
    return override;
  }
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    'Chrome not found. Install Google Chrome or pass --chrome-path "C:\\path\\to\\chrome.exe"'
  );
}

/**
 * Parse product tiles from HTML using cheerio.
 * Shared between the Puppeteer page content and any future fallback.
 */
function parseTiles(html) {
  const $        = cheerio.load(html);
  const products = [];

  const tileSelectors = [
    '.product-tile', '.b-product-tile', '[data-pid]',
    '.product-grid-item', 'article.product',
  ];
  let tiles = $();
  for (const sel of tileSelectors) {
    tiles = $(sel);
    if (tiles.length > 0) break;
  }
  if (tiles.length === 0) tiles = $('[data-product-id], [data-itemid]');
  if (tiles.length === 0) return null; // signal: no tiles found

  tiles.each((_, el) => {
    const tile = $(el);
    const title =
      tile.find('.product-name, .b-product-tile__name, .product-title, h2, h3').first().text().trim() ||
      tile.attr('data-name') || tile.attr('aria-label') || '';
    if (!title) return;

    const href       = tile.find('a[href*="/products/"]').first().attr('href') ||
                       tile.find('a').first().attr('href') || '';
    const handle     = href
      ? (href.split('/products/')[1]?.split('?')[0]?.split('/')[0] || href.split('/').pop())
      : '';
    const imgEl      = tile.find('img').first();
    const image      = imgEl.attr('src') || imgEl.attr('data-src') || imgEl.attr('data-lazy') || '';
    const rawPrice   = tile.find('.price, .b-price, .product-price, [class*="price"]').first().text().trim() ||
                       tile.attr('data-price') || '';
    const price      = cleanPrice(rawPrice);
    const pid        = tile.attr('data-pid') || tile.attr('data-product-id') || tile.attr('data-itemid') || '';
    const available  = !tile.find('.out-of-stock, .unavailable, .sold-out, [class*="out-of-stock"]').length;
    const catText    = tile.attr('data-category') ||
                       tile.find('.breadcrumb, .category, [class*="category"]').text().trim() || '';
    const series     = catText
      ? catText.split(/[,|>\/]/).map(s => s.trim()).filter(Boolean)
      : [];
    const productUrl = href
      ? (href.startsWith('http') ? href : `${FUNKO_BASE}${href}`)
      : '';

    products.push({ pid, handle, title, price, available, series, productUrl,
                    funkoPrimaryImage: image, funkoSource: 'funko.com' });
  });

  return products;
}

async function passFunkoCom(enriched, titleIndex, handleIndex, opts) {
  console.log('\n── Pass 2: funko.com scrape (Puppeteer + stealth) ─────────────');

  // Resolve Chrome path
  let chromePath;
  try {
    chromePath = findChrome(opts.chromePath);
    console.log(`  Chrome: ${chromePath}`);
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    console.error('  Pass 2 skipped. Install Chrome or use --chrome-path.');
    return { totalScraped: 0, newCount: 0, enrichedCount: 0 };
  }

  console.log(`  Catalog: ${opts.popsOnly ? 'Pop! only (funko.com/fandoms/?prefn1=productType&prefv1=Pop!)' : 'All products (funko.com/all-funko-products/)'}`);
  console.log(`  Delay: ${opts.delay}ms per page${opts.maxPages > 0 ? `, max ${opts.maxPages} pages` : ''}`);

  // Launch browser once — reuse across all pages for speed
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Set a realistic Accept-Language header
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  let pageNum = 1, totalScraped = 0, newCount = 0, enrichedCount = 0, consecutiveEmpty = 0, pageDropped = 0;
  let catalogTotal = -1; // detected from the listing page, -1 = unknown
  let start = 0;         // running product offset — advanced by ACTUAL products
                         // returned per page, not by a fixed page size. funko.com's
                         // SFCC ignores large sz values and serves ~10/page, so a
                         // fixed-stride offset races past the real catalog and the
                         // loop never terminates. Tracking the real count fixes that.

  try {
    while (true) {
      if (opts.maxPages > 0 && pageNum > opts.maxPages) {
        console.log(`  Reached max-pages limit (${opts.maxPages}).`);
        break;
      }

      const pageSize = 48; // requested; funko.com may serve fewer (we track actual)

      // Hard stop: once the catalog total is known, stop as soon as the running
      // offset reaches it. This is the primary terminator now that `start`
      // advances by real product counts.
      if (catalogTotal > 0 && start >= catalogTotal) {
        console.log(`  Reached catalog end (${catalogTotal} items, offset ${start}). Stopping.`);
        break;
      }

      // Absolute backstop: even if the total is never detected, never page past a
      // sane ceiling. The full funko.com all-products catalog is only a few
      // thousand items; 500 pages at any realistic page size is far beyond it.
      if (pageNum > 500) {
        console.log(`  Hit hard page ceiling (500). Stopping — catalog total ${catalogTotal > 0 ? catalogTotal : 'undetected'}.`);
        break;
      }

      const url = opts.popsOnly
        ? `${FUNKO_BASE}/fandoms/?prefn1=productType&prefv1=Pop%21&sz=${pageSize}&start=${start}`
        : `${FUNKO_BASE}/all-funko-products/?sz=${pageSize}&start=${start}`;

      process.stdout.write(`  Page ${pageNum}... `);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Wait for product tiles to appear (up to 8s)
        await page.waitForSelector(
          '.product-tile, .b-product-tile, [data-pid], .product-grid-item',
          { timeout: 15000 }
        ).catch(() => {}); // don't throw if not found — parseTiles handles it

        // Until the total is known, wait briefly for the JS-injected result count
        // so catalogTotal is detected and the end-of-catalog stop can fire.
        if (catalogTotal < 0) {
          await page.waitForFunction(
            () => /(?:of\s+[\d,]+\s+Items|\([\d,]+\)\s+Results)/i.test(document.body.innerText),
            { timeout: 8000 }
          ).catch(() => {});
        }

        const html     = await page.content();

        // Extract total item count from SFCC page on first page only
        // SFCC renders it as e.g. "1-20 of 2,925 Items" in a .results-hits or similar element
        if (catalogTotal < 0) {
          const totalMatch =
            html.match(/of\s+([\d,]+)\s+Items?/i) ||
            html.match(/\(([\d,]+)\)\s+Results?/i) ||
            html.match(/([\d,]{2,})\s+Items?/i);
          if (totalMatch) {
            catalogTotal = parseInt(totalMatch[1].replace(/,/g, ''), 10);
            console.log(`  Catalog total: ${catalogTotal.toLocaleString()} items`);
          }
        }

        const products = parseTiles(html);

        if (products === null) {
          // No tiles at all — check if it's end of catalog or a parse problem
          const bodyText = await page.evaluate(() => document.body.innerText);
          if (bodyText.includes('No products') || bodyText.trim().length < 200) {
            console.log('end of catalog.');
            break;
          }
          consecutiveEmpty++;
          console.log(`0 tiles (${consecutiveEmpty} consecutive empty)`);
          if (consecutiveEmpty >= 3) { console.log('  3 consecutive empty — stopping.'); break; }
        } else if (products.length === 0) {
          consecutiveEmpty++;
          console.log(`0 products (${consecutiveEmpty} consecutive empty)`);
          if (consecutiveEmpty >= 3) { console.log('  3 consecutive empty — stopping.'); break; }
        } else {
          consecutiveEmpty = 0;
          totalScraped += products.length;
          start        += products.length; // advance offset by REAL count served

          // Apply standard-Pop filter (drops bags, keychains, pins, Bitty/Pocket, etc.)
          let pageKept = products;
          if (opts.popFilter) {
            pageKept = [];
            for (const p of products) {
              const result = classifyPop(p.title);
              if (result) {
                p.title   = result.name;     // clean name, prefix + subtype stripped
                p.popType = result.popType;  // "Standard", "Super", "Rides Deluxe", etc.
                pageKept.push(p);
              } else {
                pageDropped++;
              }
            }
          }
          console.log(`${products.length} products (${pageKept.length} kept)`);

          for (const scraped of pageKept) {
            const idx = findIndex(scraped.handle, scraped.title, handleIndex, titleIndex);

            if (idx !== -1) {
              const before = JSON.stringify(enriched[idx]);
              enriched[idx] = mergeRecord(enriched[idx], scraped);
              if (JSON.stringify(enriched[idx]) !== before) enrichedCount++;
            } else {
              const normTitle  = normaliseTitle(scraped.title);
              const normHandle = (scraped.handle || '').toLowerCase();
              const newRec = {
                handle:            scraped.handle || normTitle.replace(/\s+/g, '-'),
                title:             sanitiseTitle(scraped.title),
                popType:           scraped.popType || 'Standard',
                imageName:         scraped.funkoPrimaryImage || '',
                series:            scraped.series || [],
                pid:               scraped.pid || '',
                price:             scraped.price || '',
                available:         scraped.available,
                productUrl:        scraped.productUrl || '',
                funkoPrimaryImage: scraped.funkoPrimaryImage || '',
                funkoSource:       scraped.funkoSource,
              };
              const newIdx = enriched.length;
              enriched.push(newRec);
              if (normTitle)  titleIndex.set(normTitle, newIdx);
              if (normHandle) handleIndex.set(normHandle, newIdx);
              newCount++;
            }
          }
        }
      } catch (pageErr) {
        console.warn(`  Page ${pageNum} error: ${pageErr.message} — skipping`);
      }

      pageNum++;
      await sleep(opts.delay);
    }
  } finally {
    await browser.close();
  }

  console.log(`  Scraped: ${totalScraped} | Kept: ${totalScraped - pageDropped} | Dropped (non-Pop): ${pageDropped} | New: ${newCount} | Enriched: ${enrichedCount}`);
  return { totalScraped, newCount, enrichedCount };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PASS 3 — PriceCharting market value lookup
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PriceCharting URL pattern for Funko Pops:
 *   https://www.pricecharting.com/game/funko-pop-{series}/{title-slug}
 *
 * Their public catalog search (no auth needed):
 *   https://www.pricecharting.com/api/products?q={title}&id=funko-pops
 * Returns: { products: [ { id, product-name, console-name } ] }
 *
 * Per-product pricing page (scraped, no auth):
 *   https://www.pricecharting.com/game/funko-pop-{series}/{slug}
 * We extract loose-price and new-price from the page HTML.
 *
 * Rate limit: be conservative — 2s between requests minimum.
 */

const PC_BASE        = 'https://www.pricecharting.com';
const PC_SEARCH_URL  = (q) => `${PC_BASE}/api/products?q=${encodeURIComponent(q)}&id=funko-pops`;
const PC_HTML_SEARCH = (q) => `${PC_BASE}/search-products?q=${encodeURIComponent(q)}&type=prices`;
const PC_DELAY       = 2500; // ms between PriceCharting requests — be polite

/**
 * Reduce a catalog title to a core search query. PriceCharting's search wants
 * the base character/name, not the decorated variant title. We strip
 * parenthetical and bracketed qualifiers ("(Metallic)", "[Chase]"), drop a
 * trailing "#NN", collapse whitespace, and append "funko" so the search scopes
 * to Pops. Example:
 *   "Twinkie The Kid (Glow In The Dark) (Logo Bandana)" → "Twinkie The Kid funko"
 */
function pcSearchQuery(title) {
  return (title || '')
    .replace(/[\(\[][^\)\]]*[\)\]]/g, ' ')   // remove (...) and [...] qualifiers
    .replace(/#\s*\d+/g, ' ')                // remove "#27"
    .replace(/\s+/g, ' ')
    .trim() + ' funko';
}

/**
 * Pull the distinguishing variant tokens from a catalog title — the meaningful
 * words inside its parentheses/brackets, lowercased. Stopwords (in, the, of, a,
 * and, with, edition, etc.) are dropped so a qualifier like "(Glow In The Dark)"
 * yields ["glow","dark"] and can't false-match a plain row via "in"/"the".
 * "Twinkie the Kid (Metallic)" → ["metallic"].
 */
const VARIANT_STOPWORDS = new Set([
  'in', 'the', 'of', 'a', 'an', 'and', 'with', 'edition', 'le', 'version',
]);
function variantTokens(title) {
  const tokens = [];
  const re = /[\(\[]([^\)\]]*)[\)\]]/g;
  let m;
  while ((m = re.exec(title || '')) !== null) {
    m[1].split(/\s+/).forEach(w => {
      const t = w.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
      if (t && !VARIANT_STOPWORDS.has(t)) tokens.push(t);
    });
  }
  return tokens;
}

/**
 * Score a PriceCharting listing row against the catalog record to choose the
 * best variant. Rewards matching variant tokens and a matching funko number;
 * penalises a row that carries a variant tag the record doesn't have (so the
 * plain "Twinkie the Kid" record doesn't grab the "[Chase]" row). Higher = better.
 */
function scorePcRow(row, rec) {
  const rowName = (row.name || '').toLowerCase();
  const wantTokens = variantTokens(rec.title);
  const rowTokens  = variantTokens(row.name);
  let score = 0;
  for (const t of wantTokens) if (rowName.includes(t)) score += 10;
  // Penalise variant tags present on the row but not wanted (wrong variant).
  for (const t of rowTokens) if (!wantTokens.includes(t)) score -= 4;
  // Funko number match is a strong signal.
  const recNum = (rec.funkoNumber || '').replace(/[^0-9]/g, '');
  const rowNum = (row.name.match(/#(\d+)/) || [])[1] || '';
  if (recNum && rowNum && recNum === rowNum) score += 8;
  if (recNum && rowNum && recNum !== rowNum) score -= 3;
  return score;
}

/**
 * Decide whether a chosen row is a CONFIDENT match for the record, so we only
 * attach a price we trust. PriceCharting and our catalog use different variant
 * vocabularies (e.g. "Glow In The Dark" vs "Chase GITD"), so a wrong-variant
 * price is a real risk — for a collection where chase/exclusive value differs
 * sharply from the common figure, a confident-only policy is safer than broad
 * coverage. Confident when:
 *   - the record has NO variant qualifiers and the row carries none either
 *     (clean base-figure match), OR
 *   - at least one of the record's variant tokens appears in the row name
 *     (positive variant hit).
 * A record that wants a variant but matches no token — even on a number match —
 * is treated as uncertain, because PriceCharting may name the variant
 * differently and the price would attach to the wrong figure.
 * Returns { ok, reason }.
 */
function pcMatchConfident(row, rec) {
  const wantTokens = variantTokens(rec.title);
  const rowTokens  = variantTokens(row.name);

  if (wantTokens.length === 0) {
    // Base figure wanted. The row must also be a base figure AND its name must
    // actually cover the record's core name words — a base/base match on a
    // shared common word ("Freddy" in both "Freddy Frostbear" and "Baseball
    // Freddy") is NOT the same figure. Require all of the record's distinctive
    // name words to appear in the row name.
    if (rowTokens.length !== 0) {
      return { ok: false, reason: 'record is base but row is a variant' };
    }
    if (!coreNameCovered(rec.title, row.name)) {
      return { ok: false, reason: 'name mismatch (different figure)' };
    }
    return { ok: true, reason: 'base/base', approximate: false };
  }
  // Record wants a variant.
  const positiveHit = wantTokens.some(t => row.name.toLowerCase().includes(t));
  // A variant match still needs the core name to line up, so a variant token
  // can't rescue a wrong character.
  if (positiveHit && coreNameCovered(rec.title, row.name)) {
    return { ok: true, reason: 'variant token match', approximate: false };
  }
  // Approximate fallback: the record wants a variant PriceCharting doesn't list
  // separately, but the row is the SAME base figure (exact core-name match, no
  // conflicting variant token on the row). Take the base price as an approximate
  // estimate, flagged so it's never mistaken for an exact variant price. The
  // exact-core requirement (not just "covered") rejects fuller-named different
  // figures like "Orange Piccolo" for "Piccolo" or "Robin as Nightwing" for
  // "Robin", which a looser check would wrongly accept.
  const rowHasOtherVariant = rowTokens.some(t => !wantTokens.includes(t));
  if (!rowHasOtherVariant && coreNameExact(rec.title, row.name)) {
    return { ok: true, reason: 'approximate (base price, variant not listed)', approximate: true };
  }
  // The record wants a variant but no row token matched it and it's not a clean
  // base of the same figure. A bare number match is NOT enough — PriceCharting
  // may label the variant differently (e.g. "Glow In The Dark" vs "Chase GITD"),
  // and matching a different figure by number would attach the wrong price.
  return { ok: false, reason: 'variant qualifiers did not match (naming mismatch)' };
}

/**
 * True when the record's core-name tokens EXACTLY equal the row's core-name
 * tokens (as sets). Stricter than coreNameCovered: requires no extra words on
 * either side, so "Piccolo" does NOT match "Orange Piccolo" and "Robin" does NOT
 * match "Robin as Nightwing". Used to gate the approximate base-price fallback.
 */
function coreNameExact(recTitle, rowName) {
  const a = coreNameTokens(recTitle).slice().sort().join(' ');
  const b = coreNameTokens(rowName).slice().sort().join(' ');
  return a.length > 0 && a === b;
}

/**
 * Check that the record's distinctive core-name words all appear in the row
 * name. Strips variant qualifiers, the "#NN" and "Funko POP <category>" tail,
 * and generic stopwords, then requires every remaining record word to be present
 * in the row name. Guards against same-number / shared-word false matches like
 * "Freddy Frostbear" → "Baseball Freddy".
 */
const NAME_STOPWORDS = new Set([
  'funko', 'pop', 'the', 'a', 'an', 'of', 'and', 'with', 'in', 'le', 'vinyl',
]);
function coreNameTokens(title) {
  return (title || '')
    .replace(/[\(\[][^\)\]]*[\)\]]/g, ' ')          // drop (…)/[…]
    .replace(/#\s*\d+/g, ' ')                        // drop #NN
    .replace(/funko\s+pop.*$/i, ' ')                 // drop "Funko POP <cat>" tail
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w && !NAME_STOPWORDS.has(w));
}
function coreNameCovered(recTitle, rowName) {
  const want = coreNameTokens(recTitle);
  if (want.length === 0) return true;                // nothing to check
  const rowLc = (rowName || '').toLowerCase();
  return want.every(w => rowLc.includes(w));
}


/**
 * Search PriceCharting for a record and return the best-matching listing row
 * (with id, name, console, and inline prices). Uses the HTML search-products
 * page through the shared Puppeteer `page` (the JSON /api/products endpoint is
 * unreliable and the plain-fetch path gets blocked), parses the result rows with
 * the same verified listing parser, and picks the best variant by score.
 * Returns a row object or null.
 */
async function searchPriceCharting(page, rec) {
  try {
    const url = PC_HTML_SEARCH(pcSearchQuery(rec.title));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html = await page.content();
    let rows = parsePriceChartingListing(html);
    // Reject non-Funko rows. PriceCharting search mixes in video games, cards,
    // etc.; their console slug isn't a funko-pop-* set. Without this, a "FNAF
    // Game" Funko can match a PlayStation 5 title of the same name.
    rows = rows.filter(r => /^funko-pop-/.test(r.console || ''));
    if (rows.length === 0) return null;
    // Choose the highest-scoring row; ties keep search order (PC relevance).
    let best = null, bestScore = -1e9;
    rows.forEach((row, i) => {
      const s = scorePcRow(row, rec) - i * 0.01;  // tiny tiebreak toward top
      if (s > bestScore) { bestScore = s; best = row; }
    });
    return best;
  } catch (err) {
    return null;
  }
}

/**
 * Parse the three headline prices out of a PriceCharting product page's HTML.
 * Verified against a real saved page (Pepe Le Pew #395):
 *   #used_price     → Loose / out-of-box value   (e.g. $26.00)
 *   #complete_price → Complete / in-box value     (e.g. $42.00)
 *   #new_price      → New / mint value            (e.g. $49.45)
 * Each id is a container whose dollar amount lives in a nested .js-price span
 * as TEXT (not a data-price attribute, not cents). We read the first $ value
 * inside each container. Returns dollar strings (e.g. "42.00") or null each.
 */
function parsePriceChartingHtml(html) {
  const $ = cheerio.load(html);
  const readPrice = (id) => {
    const txt = $('#' + id).text();
    const m = txt.match(/\$\s*([\d,]+\.\d{2})/);
    if (!m) return null;
    const val = parseFloat(m[1].replace(/,/g, ''));
    return (val > 0 && val <= 100000) ? val.toFixed(2) : null;
  };
  return {
    loose:    readPrice('used_price'),
    complete: readPrice('complete_price'),
    mint:     readPrice('new_price'),
    url:      $('link[rel="canonical"]').attr('href') || null,
  };
}

/**
 * Normalise a UPC cell to a single valid barcode. A PriceCharting product page
 * sometimes lists multiple UPCs in one cell (e.g. a bundle), which a naive
 * strip-all-non-digits would join into an invalid 24-digit string. We take the
 * FIRST run of 12–13 digits (UPC-A is 12, EAN-13 is 13); a leading-zero 13 is
 * kept as-is. Returns the barcode string, or null if no valid-length run found.
 */
function normalizeUpc(raw) {
  if (!raw) return null;
  // Split on any non-digit, keep groups that look like a barcode.
  const groups = String(raw).split(/[^0-9]+/).filter(Boolean);
  for (const g of groups) {
    if (g.length === 12 || g.length === 13) return g;
  }
  // Fallback: if it's one long digit run, take the first 12.
  const digits = String(raw).replace(/[^0-9]/g, '');
  if (digits.length >= 12) return digits.slice(0, 12);
  return null;
}

/**
 * Parse the clean metadata rows from a PriceCharting product page. The page's
 * attribute table lists "Label: => Value" rows (Series, Release Date, Box
 * Number, UPC, ePID, etc.). We read every such row, drop "none"/"n/a"/empty,
 * and map the useful ones onto our field names. Verified against a live page.
 * Returns an object with only the fields PriceCharting actually provided.
 */
function parsePriceChartingMeta(html) {
  const $ = cheerio.load(html);
  const rows = {};
  $('tr').each((i, el) => {
    const tds = $(el).find('td');
    if (tds.length < 2) return;
    let k = $(tds[0]).text().trim().replace(/\s+/g, ' ');
    const v = $(tds[1]).text().trim().replace(/\s+/g, ' ');
    if (!k.endsWith(':')) return;            // only the clean "Label:" rows
    k = k.slice(0, -1).trim();
    if (!v || /^(none|n\/a)$/i.test(v)) return;
    rows[k] = v;
  });
  const pick = (...names) => { for (const n of names) if (rows[n]) return rows[n]; return null; };

  let releaseDate = null;
  const dateRaw = pick('Release Date');
  if (dateRaw) { const d = new Date(dateRaw); if (!isNaN(d)) releaseDate = d.toISOString().slice(0, 10); }
  const boxNum = pick('Box Number');

  const meta = {};
  const upc = pick('UPC');                    if (upc)         meta.upc          = normalizeUpc(upc);
  if (boxNum)                                                  meta.funkoNumber  = boxNum.replace(/[^0-9]/g, '');
  const series = pick('Series');              if (series)      meta.pcSeries     = series;
  if (releaseDate)                                             meta.releaseDate  = releaseDate;
  const epid = pick('ePID (eBay)');           if (epid)        meta.ebayEpid     = epid;
  const asin = pick('ASIN (Amazon)');         if (asin)        meta.amazonAsin   = asin;
  const printRun = pick('Print Run');         if (printRun)    meta.printRun     = printRun;
  const publisher = pick('Publisher');        if (publisher)   meta.publisher    = publisher;
  const desc = pick('Description');           if (desc)        meta.pcDescription = desc;
  return meta;
}

/**
 * Fetch a PriceCharting product page through the shared Puppeteer page (real
 * browser + stealth) and parse all three grades. PriceCharting blocks plain
 * fetches of product pages, so the price scrape must go through the browser —
 * the same approach the HobbyDB pass uses. `page` is an already-open Puppeteer
 * page. Returns { loose, complete, mint, url, meta } or null on failure.
 */
async function scrapePriceChartingPrices(page, productId, consoleName, directUrl) {
  // PriceCharting product URLs use the name-slug, not the numeric id, so a
  // caller that already has the correct href (e.g. from a listing row) should
  // pass it as directUrl. Otherwise fall back to building from console+id, which
  // only works when productId is itself the URL slug.
  let url = directUrl;
  if (!url) {
    const consoleSlug = (consoleName || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '-');
    url = `${PC_BASE}/game/${consoleSlug}/${productId}`;
  }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // The price table is server-rendered; a short settle is enough.
    const html = await page.content();
    const prices = parsePriceChartingHtml(html);
    prices.meta = parsePriceChartingMeta(html);
    if (!prices.url) prices.url = url;
    return prices;
  } catch (err) {
    return null;
  }
}

async function passPriceCharting(enriched, opts) {
  console.log('\n── Pass 3: PriceCharting market values ───────────────────────');

  // Candidate selection. By default: records with no market price yet.
  // With --pc-fill-upc: ALSO revisit records that have a price but no UPC, so
  // the metadata harvest can backfill the missing barcode (this is the path to
  // completing UPC coverage — a priced-but-UPC-less record is otherwise never
  // looked at again). Records that already have both a price and a UPC are
  // always skipped.
  const fillUpc = !!opts.pcFillUpc;
  const candidates = enriched
    .map((rec, i) => ({ rec, i }))
    .filter(({ rec }) => {
      const hasPrice = !!(rec.marketValueLoose || rec.marketValueComplete || rec.marketValueNew);
      const hasUpc   = !!(rec.upc && String(rec.upc).trim());
      if (!hasPrice) return true;            // never priced → look up
      if (fillUpc && !hasUpc) return true;   // priced but no UPC → revisit for UPC
      return false;                          // already complete → skip
    })
    .slice(0, opts.pcLimit);

  const mode = fillUpc ? 'no price, or priced-but-no-UPC' : 'no market price yet';
  console.log(`  Candidates (${mode}): ${candidates.length} (limit: ${opts.pcLimit})`);
  console.log(`  Estimated time: ~${Math.ceil(candidates.length * PC_DELAY / 60000)} minutes`);

  let found = 0, notFound = 0, errors = 0, uncertain = 0, upcFilled = 0, approxFound = 0;

  // PriceCharting product pages require a real browser (plain fetch is blocked),
  // so spin up the same stealth Puppeteer setup the HobbyDB pass uses.
  const chromePath = findChrome(opts.chromePath);
  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
  });
  let page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  const BROWSER_RESTART_INTERVAL = 200;
  async function restartBrowser() {
    try { await browser.close(); } catch (_) {}
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    console.log('  [browser restarted]');
  }

  try {
    for (let i = 0; i < candidates.length; i++) {
      const { rec, i: idx } = candidates[i];
      process.stdout.write(`  [${i + 1}/${candidates.length}] ${rec.title.slice(0, 50).padEnd(50)} `);

      if (i > 0 && i % BROWSER_RESTART_INTERVAL === 0) {
        await restartBrowser();
      }

      // Step 1: search via the HTML search page (browser) and pick best variant.
      const match = await searchPriceCharting(page, rec);
      await sleep(PC_DELAY);
      if (!match || !match.id) {
        console.log('not found');
        notFound++;
        continue;
      }

      // Confidence gate: only attach a price when we trust the variant match.
      // A wrong-variant price (chase priced as common, or vice versa) is worse
      // than no price, so low-confidence matches are logged and skipped.
      const conf = pcMatchConfident(match, rec);
      if (!conf.ok) {
        console.log(`uncertain — skipped (${conf.reason}) → "${match.name}"`);
        uncertain++;
        continue;
      }

      // The search row already carries all three prices inline. Visit the
      // product page only to harvest the richer metadata block (UPC, release
      // date, ePID, etc.). If the page visit fails, we still keep the inline
      // prices from the search row.
      const detail = await scrapePriceChartingPrices(page, match.id, match.console, match.href);
      await sleep(PC_DELAY);

      // Prefer detail-page prices when present, else the inline search-row ones.
      const loose    = (detail && detail.loose)    || match.loose    || null;
      const complete = (detail && detail.complete) || match.complete || null;
      const mint     = (detail && detail.mint)     || match.mint     || null;
      if (!loose && !complete && !mint) {
        console.log(`found (id:${match.id}) — no price data`);
        notFound++;
        continue;
      }

      // Step 3: merge into record. Complete (in-box) is the primary value.
      const updates = {
        pricechartingId:  String(match.id),
        pricechartingUrl: (detail && detail.url) || match.href,
      };
      if (loose)    updates.marketValueLoose    = loose;
      if (complete) updates.marketValueComplete = complete;
      if (mint)     updates.marketValueNew      = mint;
      // Flag approximate matches (variant record priced from the base figure
      // because PriceCharting doesn't list the variant separately).
      if (conf.approximate) updates.marketValueIsApproximate = true;

      // Harvest any metadata into fields the record is MISSING — never overwrite
      // existing values (HobbyDB/funko.com data is treated as authoritative).
      const meta = (detail && detail.meta) || {};
      let metaFilled = 0;
      for (const [k, v] of Object.entries(meta)) {
        if (v && (rec[k] === undefined || rec[k] === null || rec[k] === '')) {
          updates[k] = v;
          metaFilled++;
        }
      }

      enriched[idx] = { ...enriched[idx], ...updates };
      found++;
      if (updates.upc) upcFilled++;
      if (conf.approximate) approxFound++;
      const metaTag = metaFilled ? ` +${metaFilled} meta` : '';
      const upcTag  = updates.upc ? ` +UPC` : '';
      const apxTag  = conf.approximate ? ` ~approx` : '';
      console.log(`✓ loose:$${loose || '?'} complete:$${complete || '?'} mint:$${mint || '?'}${metaTag}${upcTag}${apxTag}`);
    }
  } finally {
    try { await browser.close(); } catch (_) {}
  }

  console.log(`  Found: ${found} (${approxFound} approximate) | UPCs filled: ${upcFilled} | Uncertain (skipped): ${uncertain} | Not found: ${notFound} | Errors: ${errors}`);
  return { found, notFound, errors, uncertain, upcFilled, approxFound };
}


// ═══════════════════════════════════════════════════════════════════════════════
// PASS 3b — PriceCharting catalog crawl (discover Funko Pops not in our catalog)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PriceCharting groups Funko Pops into "console" sets, each with a listing page:
 *   https://www.pricecharting.com/console/{slug}            (page 1)
 *   https://www.pricecharting.com/console/{slug}?... / next link for pagination
 *
 * This pass walks each Funko set's listing pages, reads every product row
 * (parsePriceChartingListing — VERIFIED against a live Funko list page: id from
 * the link's title attr, name from td.title, and all three prices inline), and
 * adds any Pop whose PriceCharting id we don't already have as a new, already-
 * priced record. Pass 3 (run after) can still fill metadata from product pages.
 *
 * The set of Funko console slugs is discovered automatically at run time from
 * PriceCharting's own category nav (discoverFunkoConsoles), so it stays current
 * as PriceCharting adds categories. PC_FUNKO_CONSOLES below is only a fallback
 * used if discovery fails. Unknown slugs 404 and are skipped harmlessly.
 *
 * ON by default (disable with --no-pc-crawl). This is the pass that grows the
 * record set beyond Kenny Chan + funko.com, so it stays on for the golden master.
 */

// Fallback list, used only if live discovery fails. Mirrors the funko-pop-*
// categories seen in PriceCharting's Funko nav as of this writing.
const PC_FUNKO_CONSOLES = [
  // Full Funko console set list, harvested from PriceCharting's
  // /category/funko-pops "Browse Popular Funko Pop Series" listing (the
  // authoritative index). The old 29-set list missed ~80 sets — Town, Deluxe,
  // Monsters, Sanrio, South Park, Trains, Trolls, etc. — leaving thousands of
  // Pops undiscovered. Discovery now scrapes that page directly; this is the
  // fallback if the page fetch fails.
  'funko-pop-8-bit', 'funko-pop-ad-icons', 'funko-pop-air-force',
  'funko-pop-albums', 'funko-pop-animation', 'funko-pop-aquasox',
  'funko-pop-army', 'funko-pop-around-the-world', 'funko-pop-art-cover',
  'funko-pop-art-series', 'funko-pop-artists', 'funko-pop-asia',
  'funko-pop-bape', 'funko-pop-basketball', 'funko-pop-bitty',
  'funko-pop-board-games', 'funko-pop-books', 'funko-pop-boxing',
  'funko-pop-broadway', 'funko-pop-build-a-bear', 'funko-pop-candy',
  'funko-pop-christmas', 'funko-pop-classics', 'funko-pop-college',
  'funko-pop-comedians', 'funko-pop-comic-covers', 'funko-pop-comics',
  'funko-pop-conan', 'funko-pop-deluxe', 'funko-pop-deluxe-moment',
  'funko-pop-die-cast', 'funko-pop-digital', 'funko-pop-directors',
  'funko-pop-disney', 'funko-pop-drag-queens', 'funko-pop-fantastic-beasts',
  'funko-pop-fantastik-plastik', 'funko-pop-fashion', 'funko-pop-foodies',
  'funko-pop-freddy-funko', 'funko-pop-game-covers', 'funko-pop-game-of-thrones',
  'funko-pop-games', 'funko-pop-golf', 'funko-pop-gpk',
  'funko-pop-halo', 'funko-pop-harry-potter', 'funko-pop-heroes',
  'funko-pop-hockey', 'funko-pop-holidays', 'funko-pop-house-of-the-dragons',
  'funko-pop-icons', 'funko-pop-lance', 'funko-pop-league-of-legends',
  'funko-pop-magazine-covers', 'funko-pop-magic-the-gathering', 'funko-pop-marines',
  'funko-pop-marvel', 'funko-pop-minis', 'funko-pop-mlb',
  'funko-pop-moment', 'funko-pop-monsters', 'funko-pop-movie-posters',
  'funko-pop-movies', 'funko-pop-muppets', 'funko-pop-my-little-pony',
  'funko-pop-myths', 'funko-pop-nascar', 'funko-pop-navy',
  'funko-pop-nba-mascots', 'funko-pop-nfl', 'funko-pop-pets',
  'funko-pop-plants', 'funko-pop-plus', 'funko-pop-pusheen',
  'funko-pop-racing', 'funko-pop-retro-toys', 'funko-pop-rides',
  'funko-pop-rocks', 'funko-pop-royals', 'funko-pop-sanrio',
  'funko-pop-sci-fi', 'funko-pop-se', 'funko-pop-sesame-street',
  'funko-pop-snl', 'funko-pop-soccer', 'funko-pop-south-park',
  'funko-pop-sports-legends', 'funko-pop-stan-lee', 'funko-pop-star-wars',
  'funko-pop-television', 'funko-pop-tennis', 'funko-pop-the-vote',
  'funko-pop-town', 'funko-pop-town-christmas', 'funko-pop-trading-cards',
  'funko-pop-trains', 'funko-pop-trolls', 'funko-pop-ufc',
  'funko-pop-uglydoll', 'funko-pop-valiant', 'funko-pop-vans',
  'funko-pop-vhs-covers', 'funko-pop-wnba', 'funko-pop-wreck-it-ralph',
  'funko-pop-wrestling', 'funko-pop-wwe', 'funko-pop-wwe-covers',
  'funko-pop-zodiac',
];

/**
 * Discover the full set of Funko console slugs from PriceCharting's category
 * nav. Loads a Funko page through the browser and extracts every distinct
 * /console/funko-pop-* slug from its links (the nav lists all categories).
 * Returns the discovered slug array, or the PC_FUNKO_CONSOLES fallback if the
 * page yields nothing.
 */
async function discoverFunkoConsoles(page) {
  try {
    // The /category/funko-pops "Browse Popular Funko Pop Series" listing is the
    // authoritative index of every funko-pop-* console set (~109). The old
    // /search-products page only surfaced ~28, leaving most sets uncrawled.
    await page.goto(`${PC_BASE}/category/funko-pops`,
      { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html = await page.content();
    const slugs = new Set();
    const re = /\/console\/(funko-pop-[a-z0-9-]+)/g;
    let m;
    while ((m = re.exec(html)) !== null) slugs.add(m[1]);
    // Union with the known fallback list so discovery can only ADD to coverage,
    // never regress below the verified ~109 if the page changes shape.
    for (const s of PC_FUNKO_CONSOLES) slugs.add(s);
    const list = [...slugs];
    if (list.length === 0) {
      console.log('  [console discovery found nothing — using fallback list]');
      return PC_FUNKO_CONSOLES;
    }
    console.log(`  Discovered ${list.length} Funko console sets to crawl`);
    return list;
  } catch (e) {
    console.log('  [console discovery failed — using fallback list]');
    return PC_FUNKO_CONSOLES;
  }
}

/**
 * Parse a PriceCharting listing/search page into product rows. VERIFIED against
 * a live Funko list page. Structure: table#games_table, one <tr> per product:
 *   - a[href*="/game/"] — product URL; its title="" attribute is the PC id
 *   - td.title          — product name (incl. variant tags like "[Metallic]")
 *   - columns Loose / CIB Price / New Price carry the three grade prices inline
 * So a listing row already gives id, name, console slug, URL, AND all 3 prices —
 * no per-product page visit needed for discovery.
 */
function parsePriceChartingListing(html) {
  const $ = cheerio.load(html);
  const out = [];
  const num = (txt) => { const m = (txt || '').match(/\$\s*([\d,]+\.\d{2})/); return m ? m[1].replace(/,/g, '') : null; };
  $('#games_table tbody tr').each((i, el) => {
    const a = $(el).find('a[href*="/game/"]').first();
    const href = a.attr('href') || '';
    if (!href) return;
    const id = (a.attr('title') || '').trim() || href.split('-').pop();
    const name = $(el).find('td.title').text().trim().replace(/\s+/g, ' ');
    const consoleSlug = (href.match(/\/game\/([^/]+)\//) || [])[1] || '';
    out.push({
      id,
      name,
      console: consoleSlug,
      href: href.startsWith('http') ? href : `${PC_BASE}${href}`,
      loose:    num($(el).find('td').eq(3).text()),
      complete: num($(el).find('td').eq(4).text()),
      mint:     num($(el).find('td').eq(5).text()),
    });
  });
  return out;
}

async function passPriceChartingCrawl(enriched, opts) {
  console.log('\n── Pass 3b: PriceCharting catalog crawl ──────────────────────');
  if (!opts.pcCrawl) {
    console.log('  SKIPPED — pass disabled (enable with --pc-crawl once the');
    console.log('  console list and listing-row selector are verified; see code).');
    return { discovered: 0, added: 0, pages: 0, withUpc: 0 };
  }

  // Index of PriceCharting ids we already have, to dedupe discoveries.
  const havePcId = new Set(
    enriched.map(r => r.pricechartingId).filter(Boolean).map(String)
  );

  const chromePath = findChrome(opts.chromePath);
  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
  });
  let page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  let discovered = 0, added = 0, pages = 0, withUpc = 0;
  const crawlLimit = opts.pcCrawlLimit || Infinity;

  // Discover the full Funko console set list from PriceCharting's nav, so the
  // crawl covers every category rather than a hardcoded subset.
  const consoles = await discoverFunkoConsoles(page);
  const totalSets = consoles.length;   // runtime count — never hardcoded; grows
                                       // automatically if PriceCharting adds sets.

  try {
    outer:
    for (const [setIdx, slug] of consoles.entries()) {
      const newBefore = discovered;    // to report new Pops found in THIS set
      console.log(`\n  [set ${setIdx + 1}/${totalSets}] ${slug}`);
      const url = `${PC_BASE}/console/${slug}`;
      let stubs = [];
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // PriceCharting console pages lazy-load their full figure list via JS as
        // you scroll — they do NOT use a "next" link or a working ?page= param
        // (verified: large sets show ~150 rows initially but have 500+ total, e.g.
        // funko-pop-rocks = 534). So scroll to the bottom repeatedly until the row
        // count stops growing, then parse the fully-loaded DOM once.
        let prevCount = -1, stable = 0, scrolls = 0;
        while (scrolls < 60) {            // hard cap: 60 scrolls (~9000 rows) per set
          scrolls++;
          const rowCount = await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
            const t = document.querySelector('#games_table tbody');
            return t ? t.querySelectorAll('tr').length : 0;
          });
          if (rowCount === prevCount) {
            stable++;
            if (stable >= 3) break;       // 3 stable reads → fully loaded
          } else {
            stable = 0;
            prevCount = rowCount;
          }
          await sleep(800);               // let the lazy-load fire
        }
        const html = await page.content();
        stubs = parsePriceChartingListing(html);
      } catch (e) {
        console.log('  (page error)');
        continue;
      }
      pages++;
      console.log(`  ${slug}: ${stubs.length} rows loaded`);
      {
        for (const s of stubs) {
          if (!s.id || havePcId.has(String(s.id))) continue;
          discovered++;
          havePcId.add(String(s.id));
          // Live progress: this loop visits one product page per new Pop (~2.5s
          // each), so without this the console looks frozen for minutes.
          process.stdout.write(`\r    +${added + 1} new | ${withUpc} w/UPC | ${(s.name || '').slice(0, 40).padEnd(40)}`);
          // Listing rows carry all three prices inline. To make the new Pop
          // SCANNABLE we also visit its product page to harvest the UPC and the
          // rest of the metadata (release date, ePID, etc.) — the listing row
          // alone has no UPC. This is the slow part of the crawl: one extra page
          // fetch per newly-discovered Pop.
          const rec = {
            handle: `pc-${s.id}`,
            title: s.name,
            funkoSource: 'pricecharting',
            pricechartingId: String(s.id),
            pricechartingUrl: s.href,
          };
          if (s.loose)    rec.marketValueLoose    = s.loose;
          if (s.complete) rec.marketValueComplete = s.complete;
          if (s.mint)     rec.marketValueNew      = s.mint;

          // Product-page visit for UPC + metadata. Reuses the same scraper Pass 3
          // uses. On failure we still keep the priced listing-row record (just
          // without a UPC), so a transient page error never loses the discovery.
          try {
            const detail = await scrapePriceChartingPrices(page, s.id, s.console, s.href);
            if (detail && detail.meta) {
              for (const [k, v] of Object.entries(detail.meta)) {
                if (v && (rec[k] === undefined || rec[k] === null || rec[k] === '')) {
                  rec[k] = v;
                }
              }
            }
            // Prefer product-page prices if the listing row lacked any.
            if (detail) {
              if (!rec.marketValueLoose    && detail.loose)    rec.marketValueLoose    = detail.loose;
              if (!rec.marketValueComplete && detail.complete) rec.marketValueComplete = detail.complete;
              if (!rec.marketValueNew      && detail.mint)     rec.marketValueNew      = detail.mint;
            }
            await sleep(PC_DELAY);
          } catch (e) {
            // keep the listing-row record as-is
          }

          enriched.push(rec);
          added++;
          if (rec.upc) withUpc++;
          if (added >= crawlLimit) { process.stdout.write('\n'); console.log('  [crawl limit reached]'); break outer; }
        }
        process.stdout.write('\n');   // finish the live progress line for this set
      }
      const newThisSet = discovered - newBefore;
      console.log(`    set done — ${newThisSet} new from ${slug} (running total: ${discovered} discovered, ${added} added)`);
    }
  } finally {
    try { await browser.close(); } catch (_) {}
  }

  console.log(`  Pages crawled: ${pages} | New Pops discovered: ${added} | With UPC (scannable): ${withUpc}`);
  return { discovered, added, pages, withUpc };
}



// ═══════════════════════════════════════════════════════════════════════════════
// PASS 4 — HobbyDB Reference Numbers scrape (UPC, Funko #, HDBID, retailer SKUs)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Each HobbyDB catalog page has a "Reference Numbers" section containing:
//   HDBID        — HobbyDB's own numeric ID
//   UPC          — barcode on the box (most valuable for FunkoDex scanning)
//   Reference #  — Funko's official Pop number (#203 etc.)
//   Hot Topic #  — retailer SKU (present on exclusives)
//   GameStop #   — retailer SKU
//   Target #     — retailer SKU
//   Walmart #    — retailer SKU
//   Amazon #     — retailer SKU
//
// HobbyDB returns 403 to plain fetch, so we use the Puppeteer browser session
// already established in Pass 2. We keep one browser instance open across all
// lookups and pace requests at --hdb-delay ms (default 1500).
//
// Only fetches records missing upc OR funkoNumber — skips records already enriched.
// Use --hdb-limit N to cap how many records to look up per run.
// Use --hdb-all to look up ALL records regardless of existing data.

const HDB_BASE = 'https://www.hobbydb.com/marketplaces/hobbydb/catalog_items';

/**
 * Scrape the Reference Numbers section from a fully Angular-rendered HobbyDB page.
 * HobbyDB renders reference fields as:
 *   <strong>HDBID:</strong>  <div class="ng-binding">322989</div>
 *   <strong>UPC:</strong>    <div class="ng-binding ng-scope">849803097097</div>
 *   <strong>Reference #:</strong> <div class="ng-binding">203</div>
 * We find every <strong> label and read the adjacent .ng-binding div as value.
 */
function parseHobbyDbRefs(html) {
  const $ = cheerio.load(html);
  const refs = {};

  // Primary: <strong> label + nearest .ng-binding in IMMEDIATE parent only.
  // We use .spaced-field or .col-md-6 as the container — these are the specific
  // divs HobbyDB uses for each reference field. Avoiding the generic 'div' fallback
  // prevents picking up ng-binding values from unrelated sections (prices, counts).
  $('strong').each((_, el) => {
    const label = $(el).text().replace(/:$/, '').trim();
    if (!label) return;
    // Only look in the specific HobbyDB field containers, not any ancestor div
    const parent = $(el).closest('.spaced-field, .col-md-6');
    if (!parent.length) return; // not inside a reference field container — skip
    const value  = parent.find('.ng-binding').first().text().trim() ||
                   $(el).next('.ng-binding').text().trim() ||
                   $(el).nextAll('.ng-binding').first().text().trim();
    if (value && value !== label && value.length < 50) {
      mapHdbField(refs, label.toLowerCase(), value);
    }
  });

  // Fallback: UPC from eBay search link (in static HTML before Angular loads)
  if (!refs.upc) {
    const m = html.match(/_nkw=(\d{10,13})/);
    if (m) refs.upc = m[1];
  }

  // Fallback: HDBID from ng-init
  if (!refs.hdbid) {
    const m = html.match(/itemId=(\d+)/);
    if (m) refs.hdbid = m[1];
  }

  return Object.keys(refs).length > 0 ? refs : null;
}

function mapHdbField(refs, label, value) {
  const v = value.trim();
  if (!v || v === '-') return;
  if (label === 'hdbid')                                refs.hdbid        = v;
  else if (label === 'upc')                             refs.upc          = v;
  else if (label.startsWith('reference')) { if (/^\d{1,6}$/.test(v)) refs.funkoNumber = v; } // digits only, max 6
  else if (label.includes('hot topic'))                 refs.hotTopicSku  = v;
  else if (label.includes('gamestop'))                  refs.gamestopSku  = v;
  else if (label.includes('target'))                    refs.targetSku    = v;
  else if (label.includes('walmart'))                   refs.walmartSku   = v;
  else if (label.includes('amazon'))                    refs.amazonSku    = v;
}

/**
 * Scrape HobbyDB "subject" tags from a catalog page — these are the category/
 * franchise/event/format links shown near the top of the page, e.g.:
 *   <a href="/marketplaces/hobbydb/subjects/pop-vinyl-series">Pop! Vinyl</a>
 *   <a href="/marketplaces/hobbydb/subjects/saint-cloth-myth-ex-series">Saint Cloth Myth EX</a>
 *   <a href="/marketplaces/hobbydb/subjects/new-york-comic-con-event-series">New York Comic Con</a>
 *
 * Verified live (sagittarius-seiya, Stitch as Baker / NYCC): the selector
 * a[href*="/subjects/"][href$="-series"] catches both "-series" and
 * "-event-series" hrefs since both end in "-series". There is no separate
 * franchise-only selector — HobbyDB pages may carry zero, one, or several of
 * these tags (format, event, product line), and some pages (e.g. Saint Cloth
 * Myth EX) expose only one tag total with no distinct franchise tag.
 *
 * Returns a deduped array of tag text in document order, or null if none found.
 * Callers should NOT assume any particular entry is "the franchise" — this is
 * a raw tag list matching Kenny's `series` array shape, not a classified field.
 */
function parseHobbyDbSeries(html) {
  const $ = cheerio.load(html);
  const tags = [];
  const seen = new Set();

  $('a[href*="/subjects/"][href$="-series"]').each((_, el) => {
    const text = $(el).text().trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    tags.push(text);
  });

  return tags.length > 0 ? tags : null;
}

async function passHobbyDb(enriched, opts) {
  console.log('\n── Pass 4: HobbyDB Reference Numbers ─────────────────────────');

  // Resolve Chrome
  let chromePath;
  try {
    chromePath = findChrome(opts.chromePath);
    console.log(`  Chrome: ${chromePath}`);
  } catch (err) {
    console.error(`  ERROR: ${err.message} — Pass 4 skipped.`);
    return { found: 0, notFound: 0, errors: 0 };
  }

  // Candidates: records with a handle but missing upc or funkoNumber
  // (skip funko.com-only records — they have no HobbyDB page)
  const candidates = enriched
    .map((rec, i) => ({ rec, i }))
    .filter(({ rec }) => {
      if (!rec.handle || rec.handle.endsWith('.html')) return false; // funko.com record
      if (opts.hdbAll) return true;
      if (opts.retryNoRefs)   return rec.hdbChecked && !rec.hdbid; // only retry no-refs
      if (opts.retryNoSeries) return rec.hdbChecked && (!rec.series || rec.series.length === 0); // only retry missing series
      return !rec.hdbid && !rec.hdbChecked; // skip if already fetched
    })
    .slice(0, opts.hdbLimit);

  console.log(`  Candidates: ${candidates.length} (limit: ${opts.hdbLimit})`);
  console.log(`  Estimated time: ~${Math.ceil(candidates.length * opts.hdbDelay / 60000)} minutes`);

  if (candidates.length === 0) {
    console.log('  Nothing to do.');
    return { found: 0, notFound: 0, errors: 0 };
  }

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
  });

  let page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  let found = 0, notFound = 0, errors = 0;

  // Restart browser every 200 records to prevent memory bloat slowing Angular rendering
  const BROWSER_RESTART_INTERVAL = 200;

  async function restartBrowser() {
    try { await browser.close(); } catch (_) {}
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    console.log('  [browser restarted]');
  }

  try {
    for (let i = 0; i < candidates.length; i++) {
      // Restart browser periodically to keep it fresh
      if (i > 0 && i % BROWSER_RESTART_INTERVAL === 0) {
        await restartBrowser();
      }

      const { rec, i: idx } = candidates[i];
      // Normalize handle to match HobbyDB URL conventions (verified against live site):
      //   &amp; -> removed (with surrounding hyphens)
      //   [content] -> removed entirely (convention tags)
      //   (content) -> parens removed, content kept
      //   # , -> removed
      //   ' -> hyphen
      //   . -> hyphen
      //   accents -> stripped (é->e, ü->u, etc.)
      //   multiple hyphens -> collapsed to one
      const cleanHandle = rec.handle
        .replace(/-?&amp;-?/g, '-')
        .replace(/-?&[a-z]+;-?/g, '-')
        .replace(/-?\[[^\]]*\]-?/g, '-')
        .replace(/[()]/g, '')
        .replace(/-?#\d*-?/g, '-')  // remove #NNN patterns (e.g. vampire-spike-#125-chase -> vampire-spike-chase)
        .replace(/,/g, '')
        .replace(/[''\u2018\u2019]/g, '-')
        .replace(/\./g, '-')
        .replace(/\//g, '-')
        .replace(/:/g, '-')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      const url = `${HDB_BASE}/${cleanHandle}`;
      process.stdout.write(`  [${i + 1}/${candidates.length}] ${rec.title.slice(0, 45).padEnd(45)} `);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Wait for Angular to render the Reference # value specifically.
        // 'Reference Numbers' heading appears before values populate — we must
        // wait until the Reference # ng-binding div actually has content.
        // Falls back gracefully if the record has no Reference # (timeout fires).
        await page.waitForFunction(
          () => {
            const strongs = Array.from(document.querySelectorAll('strong'));
            const refStrong = strongs.find(s => s.innerText.includes('Reference'));
            if (!refStrong) return false;
            const val = refStrong.parentElement &&
                        refStrong.parentElement.querySelector('.ng-binding');
            return val && val.innerText.trim().length > 0;
          },
          { timeout: 20000 }
        ).catch(() => {});

        const html = await page.content();
        const refs   = parseHobbyDbRefs(html);
        const series = parseHobbyDbSeries(html);

        if (!refs && !series) {
          console.log('no refs found');
          enriched[idx].hdbChecked = true; // mark as fetched so restarts skip it
          notFound++;
        } else {
          // Merge into record
          const r = enriched[idx];
          if (refs) {
            if (refs.hdbid       && !r.hdbid)       r.hdbid       = refs.hdbid;
            if (refs.upc         && !r.upc)         r.upc         = refs.upc;
            if (refs.funkoNumber && !r.funkoNumber) r.funkoNumber = refs.funkoNumber;
            if (refs.hotTopicSku && !r.hotTopicSku) r.hotTopicSku = refs.hotTopicSku;
            if (refs.gamestopSku && !r.gamestopSku) r.gamestopSku = refs.gamestopSku;
            if (refs.targetSku   && !r.targetSku)   r.targetSku   = refs.targetSku;
            if (refs.walmartSku  && !r.walmartSku)  r.walmartSku  = refs.walmartSku;
            if (refs.amazonSku   && !r.amazonSku)   r.amazonSku   = refs.amazonSku;
          }
          // series is a raw tag list (format/event/product-line) — fill only if
          // we don't already have one. Does not imply franchise; see Pass 5.
          if (series && (!r.series || r.series.length === 0)) r.series = series;

          enriched[idx].hdbChecked = true; // mark as fetched
          const summary = [
            ...(refs ? Object.entries(refs).map(([k,v])=>k+':'+v) : []),
            ...(series ? [`series:[${series.join(', ')}]`] : []),
          ].join(' | ');
          console.log(`✓ ${summary}`);
          found++;
        }
      } catch (err) {
        console.log(`error: ${err.message.slice(0, 60)}`);
        errors++;
      }

      await sleep(opts.hdbDelay);

      // Save every 25 records — balances progress safety against disk I/O.
      // hdbChecked markers persist so restart skips processed records (max 25 lost).
      if ((i + 1) % 10 === 0) {
        fs.writeFileSync(path.resolve(opts.output), JSON.stringify(enriched, null, 2), 'utf8');
      }
    }
  } finally {
    await browser.close();
    // Final save to capture the last partial batch
    fs.writeFileSync(path.resolve(opts.output), JSON.stringify(enriched, null, 2), 'utf8');
  }

  console.log(`  Found: ${found} | Not found: ${notFound} | Errors: ${errors}`);
  return { found, notFound, errors };
}


// ═══════════════════════════════════════════════════════════════════════════════
// PASS 5 — funko.com product page franchise/series enrichment
// ═══════════════════════════════════════════════════════════════════════════════
//
// funko.com-only records (from Pass 2) have empty series[] and no franchise
// because the listing tile scraper only gets basic product info. Each product
// page has JSON-LD structured data with a BreadcrumbList:
//
//   Funko → Fandoms → Animation & Cartoons → Pop! Man Ray
//
// Position 3 = franchise/category (e.g. "Animation & Cartoons")
// Position 2 = section (e.g. "Fandoms") — useful for future filtering
//
// We fetch each product page with domcontentloaded (JSON-LD is in static HTML,
// no Angular/JS rendering needed), extract the breadcrumb, and store:
//   franchise  — breadcrumb position 3 name
//   series     — ["Pop! Vinyl", "{franchise}"] constructed from breadcrumb
//   funkoSection — breadcrumb position 2 (e.g. "Fandoms", "Sports", "Music")
//
// Only runs on funko.com records missing series data.
// Uses same Puppeteer browser as Pass 2/4. Paced at --funko-detail-delay ms.

/**
 * Extract BreadcrumbList from JSON-LD in page HTML.
 * Returns array of {position, name, url} sorted by position, or null.
 */
function extractBreadcrumb(html) {
  const matches = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of matches) {
    try {
      const data = JSON.parse(match[1]);
      // May be an array or single object
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'BreadcrumbList' && Array.isArray(item.itemListElement)) {
          return item.itemListElement
            .map(el => ({
              position: el.position,
              name:     (el.item && el.item.name) || el.name || '',
              url:      (el.item && el.item['@id']) || '',
            }))
            .sort((a, b) => a.position - b.position);
        }
      }
    } catch (_) {}
  }
  return null;
}

async function passFunkoDetails(enriched, opts) {
  console.log('\n── Pass 5: funko.com product page franchise enrichment ────────');

  // Any record with an empty franchise that has a funko.com product page to
  // check — previously restricted to funkoSource === 'funko.com', which
  // excluded HobbyDB-origin records that ended up with a productUrl via the
  // dedup/merge pass. Records without a productUrl (no funko.com page at all)
  // genuinely have no franchise source here and are left as-is (see
  // parseHobbyDbSeries comments — some HobbyDB pages carry no franchise tag).
  const candidates = enriched
    .map((rec, i) => ({ rec, i }))
    .filter(({ rec }) =>
      !rec.franchise &&
      rec.productUrl
    );

  console.log(`  Candidates (records missing franchise with a funko.com page): ${candidates.length}`);
  if (candidates.length === 0) { console.log('  Nothing to do.'); return { enriched: 0, notFound: 0, errors: 0 }; }
  console.log(`  Estimated time: ~${Math.ceil(candidates.length * opts.funkoDetailDelay / 60000)} minutes`);

  // Resolve Chrome
  let chromePath;
  try {
    chromePath = findChrome(opts.chromePath);
    console.log(`  Chrome: ${chromePath}`);
  } catch (err) {
    console.error(`  ERROR: ${err.message} — Pass 5 skipped.`);
    return { enriched: 0, notFound: 0, errors: 0 };
  }

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  let enrichedCount = 0, notFound = 0, errors = 0;

  try {
    for (let i = 0; i < candidates.length; i++) {
      const { rec, i: idx } = candidates[i];
      process.stdout.write(`  [${i + 1}/${candidates.length}] ${rec.title.slice(0, 45).padEnd(45)} `);

      try {
        // JSON-LD is in static HTML — domcontentloaded is sufficient and much faster
        await page.goto(rec.productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const html  = await page.content();
        const crumbs = extractBreadcrumb(html);

        if (!crumbs || crumbs.length < 3) {
          console.log('no breadcrumb');
          notFound++;
        } else {
          // crumbs: [Funko, Section, Franchise, Product]
          const section   = crumbs[1]?.name || '';  // e.g. "Fandoms"
          const franchise = crumbs[2]?.name || '';  // e.g. "Animation & Cartoons"

          if (franchise) {
            enriched[idx].franchise    = franchise;
            enriched[idx].funkoSection = section;
            // Build series array to match HobbyDB format — only if the record
            // doesn't already have one (e.g. from Pass 4's parseHobbyDbSeries).
            if (!enriched[idx].series || enriched[idx].series.length === 0) {
              enriched[idx].series = ['Pop! Vinyl', franchise];
            }
            enrichedCount++;
            console.log(`✓ ${section} > ${franchise}`);
          } else {
            console.log('no franchise in breadcrumb');
            notFound++;
          }
        }
      } catch (err) {
        console.log(`error: ${err.message.slice(0, 50)}`);
        errors++;
      }

      await sleep(opts.funkoDetailDelay);
    }
  } finally {
    await browser.close();
  }

  console.log(`  Enriched: ${enrichedCount} | Not found: ${notFound} | Errors: ${errors}`);
  return { enriched: enrichedCount, notFound, errors };
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST-PROCESS — Dedup funko.com records against HobbyDB by cleaned title
// ═══════════════════════════════════════════════════════════════════════════════
//
// After Pass 2, funko.com records were added as new entries. Some have cleaned
// titles that match existing HobbyDB records (e.g. "Simba" on both). When that
// happens we should MERGE the funko.com fields into the HobbyDB record and
// remove the duplicate, rather than keeping two entries for the same Pop.
// False-match guard: only merge when the HobbyDB record is a Pop! (series contains
// "Pop!" or record has no series — not a Mystery Mini or Wacky Wobbler).

function dedupeAndMerge(enriched) {
  console.log('\n── Post-process: Dedup funko.com vs HobbyDB ──────────────────');

  // Build normalised-title → index map for non-funko records
  const hobbyIndex = new Map();
  enriched.forEach((rec, i) => {
    if (!rec.funkoSource) hobbyIndex.set(normaliseTitle(rec.title), i);
  });

  let merged = 0, kept = 0;
  const toRemove = new Set();

  enriched.forEach((rec, i) => {
    if (!rec.funkoSource) return; // only process funko.com additions
    const normTitle = normaliseTitle(rec.title);
    const hobbyIdx = hobbyIndex.get(normTitle);
    if (hobbyIdx === undefined) { kept++; return; }

    // Found a title match — check it's actually a Pop! not a Mystery Mini etc.
    const hobbyRec = enriched[hobbyIdx];
    const series = hobbyRec.series || [];
    const isPop = series.length === 0 ||
                  series.some(s => /^pop!/i.test(s) || /^funko pop/i.test(s));
    if (!isPop) { kept++; return; } // don't merge into Mystery Minis / Wacky Wobblers

    // Merge funko.com fields into HobbyDB record
    if (rec.price          && !hobbyRec.price)           hobbyRec.price           = rec.price;
    if (rec.available      !== undefined)                hobbyRec.available       = rec.available;
    if (rec.productUrl     && !hobbyRec.productUrl)      hobbyRec.productUrl      = rec.productUrl;
    if (rec.funkoPrimaryImage && !hobbyRec.funkoPrimaryImage)
                                                         hobbyRec.funkoPrimaryImage = rec.funkoPrimaryImage;
    if (rec.popType        && !hobbyRec.popType)         hobbyRec.popType         = rec.popType;
    if (rec.pid            && !hobbyRec.pid)             hobbyRec.pid             = rec.pid;
    hobbyRec.funkoSource = rec.funkoSource;

    toRemove.add(i);
    merged++;
  });

  // Rebuild array without removed indices
  const deduped = enriched.filter((_, i) => !toRemove.has(i));
  console.log(`  Merged into HobbyDB records: ${merged}`);
  console.log(`  funko.com-only new records:  ${kept}`);
  console.log(`  Records removed (dupes):     ${toRemove.size}`);
  return deduped;
}


// ═══════════════════════════════════════════════════════════════════════════════
// POST-PROCESS 2 — Remove non-Pop HobbyDB records from output
// ═══════════════════════════════════════════════════════════════════════════════
//
// The base HobbyDB dataset contains non-Pop items: shirts, bags, backpacks,
// wallets, keychains, mystery minis, wacky wobblers, Funkoverse, Soda, etc.
// These are not collectible Pops and don't belong in FunkoDex's catalog.
// We filter them out by title keywords and series tags.
//
// funko.com records already filtered by classifyPop() in Pass 2 — this only
// needs to clean up the original HobbyDB records.

const NON_POP_TITLE_WORDS = /\b(backpack|bag|wallet|crossbody|lanyard|keychain|soda|mystery minis|wacky wobbler|funkoverse|bitty pop|pocket pop|pin set|enamel pin|zip around|cardigan|hoodie|jacket|legging|dress|beanie|cap|hat|mug|cup|cushion|plush|peluche|dorbz|vynl|hikari|rock candy|fabrikations|paka paka|spastik plastik)\b/i;
// Note: tee/shirt removed from title filter — Pop figures can have shirt/tee in their
// variant name (e.g. 'Hulk Hogan (Ripped Shirt)'). Apparel is caught by the
// 'pop! tees & apparel' / 'shirts and jackets' series tags instead.

const NON_POP_SERIES = [
  'pop! tees', 'pop! homewares', 'pop! pins', 'pop! keychains',
  'loungefly', 'mystery minis', 'wacky wobblers', 'vinyl soda',
  'funko soda', 'funkoverse', 'dorbz', 'rock candy', 'hikari',
  'fabrikations', 'paka paka', 'spastik plastik', 'vynl',
  'pop! apparel', 'shirts and jackets', 'pins and badges',
  'something wild', 'funko games -',
];

function isNonPop(rec) {
  // funko.com records already filtered — only check HobbyDB originals
  if (rec.funkoSource) return false;

  // Title keyword check
  if (NON_POP_TITLE_WORDS.test(rec.title || '')) return true;

  // Series tag check
  const series = (rec.series || []).map(s => s.toLowerCase());
  if (NON_POP_SERIES.some(tag => series.some(s => s.includes(tag)))) return true;

  // 'Pop! and Shirt Pack' series can be either a bundle (keep) or standalone tee (drop).
  // Keep if title contains 'pop and shirt/tee' — that's the actual bundle.
  // Drop if title just ends in Tee/Shirt — that's the standalone apparel item.
  if (series.some(s => s.includes('pop! and shirt pack') || s.includes('and shirt pack'))) {
    const title = (rec.title || '').toLowerCase();
    const isBundle = /\bpop and (shirt|tee)\b|\band (shirt|tee) (pack|set)\b/i.test(rec.title || '');
    if (!isBundle) return true; // standalone tee in a shirt pack series
  }

  return false;
}

function removeNonPops(enriched) {
  console.log('\n── Post-process: Remove non-Pop HobbyDB records ──────────────');
  const before = enriched.length;
  const filtered = enriched.filter(rec => !isNonPop(rec));
  const removed = before - filtered.length;
  console.log(`  Removed non-Pop records: ${removed}`);
  console.log(`  Remaining records:       ${filtered.length}`);
  return filtered;
}


// ═══════════════════════════════════════════════════════════════════════════════
// POST-PROCESS 3 — Extract funko number from title when not found in HobbyDB
// ═══════════════════════════════════════════════════════════════════════════════
//
// Some HobbyDB records have the Pop number embedded in the title (e.g. "Garfield #20")
// but no Reference # in the Reference Numbers section. We extract it opportunistically
// and store it as funkoNumberFromTitle — separate from funkoNumber (which is verified
// from HobbyDB Reference Numbers) so the source is always clear.
//
// Pattern: #\d{1,6} anywhere in title
// Only applied when funkoNumber is not already set.
// Not applied to funko.com-only records (their titles are clean character names).

const TITLE_NUMBER_RE = /\s*#(\d{1,6})\b/;

// ═══════════════════════════════════════════════════════════════════════════════
// POST-PROCESS — title normalisation
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Clean display noise out of titles WITHOUT destroying meaningful data.
 * Deliberately conservative — verified against the live catalog:
 *   - decode HTML entities (&amp; -> &, &quot; -> ", &#39; -> ', etc.) — the bulk
 *   - normalise smart quotes to straight quotes
 *   - strip a leading "Funko Pop!" / "Pop!" prefix (only when more text follows)
 *   - strip a trailing "(Bobble-Head)" — redundant on a Pop
 * NOT touched (these are signal, not noise): "#123" Pop numbers, variant
 * qualifiers like (Flocked)/(GITD)/(Chase)/(Prototype)/(Signed by ...), and
 * series-colon titles like "Thor: Ragnarok" / "Soldier: 76" / "White Lantern:
 * Batman" where the colon is part of the real movie/set/character name.
 */
function decodeHtmlEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const cp = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    const k = code.toLowerCase();
    return Object.prototype.hasOwnProperty.call(named, k) ? named[k] : m;
  });
}

function cleanTitle(t) {
  if (!t) return t;
  let s = decodeHtmlEntities(t);
  s = s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
  s = s.replace(/^(?:Funko\s+)?Pop!?\s+(?=\S)/i, '');   // leading Funko Pop! / Pop!
  s = s.replace(/\s*\(Bobble-?Head\)\s*$/i, '');         // trailing (Bobble-Head)
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

function cleanTitles(enriched) {
  console.log('\n── Post-process: Clean title noise ───────────────────────────');
  let changed = 0;
  for (const rec of enriched) {
    const cleaned = cleanTitle(rec.title);
    if (cleaned && cleaned !== rec.title) { rec.title = cleaned; changed++; }
  }
  console.log(`  Titles cleaned: ${changed}`);
  return changed;
}

function extractNumbersFromTitles(enriched) {
  console.log('\n── Post-process: Extract Pop# from titles ────────────────────');
  let extracted = 0;

  let pricesCleaned = 0;
  for (const rec of enriched) {
    // Clean any dirty price strings (sale blocks, whitespace) left from scraping
    if (rec.price && (rec.price.includes('\n') || /reduced|off/i.test(rec.price) || rec.price.length > 12)) {
      const cleaned = cleanPrice(rec.price);
      rec.price = cleaned;
      pricesCleaned++;
    }

    if (rec.funkoNumber) continue;           // already have verified number
    if (rec.funkoSource === 'funko.com') continue; // funko.com titles are clean names
    const title = rec.title || '';
    const m = TITLE_NUMBER_RE.exec(title);
    if (m) {
      rec.funkoNumberFromTitle = m[1];
      // Clean the number from the title — "Maximus #860 (Body Armor)" → "Maximus (Body Armor)"
      rec.title = title.replace(TITLE_NUMBER_RE, '').replace(/\s{2,}/g, ' ').trim();
      extracted++;
    }
  }

  console.log(`  Numbers extracted from titles: ${extracted}`);
  if (pricesCleaned > 0) console.log(`  Dirty prices cleaned:          ${pricesCleaned}`);
  return enriched;
}


// ═══════════════════════════════════════════════════════════════════════════════
// POST-PROCESS 5 — Derive setTag + franchiseSuggestion (collection grouping)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Two grouping fields consumed by the FunkoDex app's series-completion / want-list
// feature (see FunkoDex SERIES_COMPLETION_SPEC). Both are SUGGESTIONS / enrichment:
// the app's user-assigned franchise always wins, and setTag drives the secondary
// named-set completion. Computed from data already present on the record — no
// extra network calls.
//
//   setTag             — the most-specific NAMED SET a figure belongs to
//                        (e.g. "Haunted Mansion Mini Vinyl Figures"), derived from
//                        the record's `series` tags. "" when the figure is in no
//                        named set (most Pop! figures). NOT the Pop! product line.
//
//   franchiseSuggestion — a property-level franchise pre-fill for the app's
//                        first-scan prompt, derived from the PriceCharting console
//                        in `pricechartingUrl`. ONLY emitted when the console is
//                        property-specific (e.g. funko-pop-harry-potter). Umbrella
//                        / genre consoles (disney, animation, movies, marvel, …)
//                        carry no property signal and are omitted, so the app does
//                        not pre-fill a misleading label. Verified against a live
//                        run's console distribution: Hocus Pocus figures sit under
//                        funko-pop-disney (umbrella → omitted), so the user assigns
//                        the property by hand; Harry Potter has its own console
//                        (→ suggested). The suggestion is a hint only; the user
//                        confirms or overrides it.

// Named-set detection. A real set tag ends in a specific set-type suffix and is
// NOT a Pop! product line, a generic mini line, an Advent Calendar, or a
// retailer/convention exclusive. Verified against a live run: this yields 13
// clean themed-set tags (Mystery Boxes, Vinyl Sets, Haunted Mansion Mini Vinyl
// Figures) with no false positives, resolving all Haunted Mansion records to
// "Haunted Mansion Mini Vinyl Figures".
const SET_SUFFIXES = [
  'mini vinyl figures', 'advent calendar', 'mystery box', 'vinyl sets',
  'gift set', 'collectors set', 'diorama', 'build a scene', 'build-a-scene',
];
const SET_EXCLUDE_KW = [
  'exclusive', 'gamestop', 'eb games', 'convention', 'comic con',
  'sdcc', 'nycc', 'eccc',
];
// Generic product lines that match a set suffix but are NOT a specific themed set
// (e.g. an Advent Calendar is a yearly product; "Funko Mini Vinyl Figures" is the
// generic mini line, not a themed set like "Haunted Mansion Mini Vinyl Figures").
// Matched case-insensitively against the whole tag.
const SET_GENERIC_LINES = new Set([
  'funko advent calendar',
  'funko mini vinyl figures',
  'mini vinyl figures',
  'disney mini vinyl figures',
]);

function isNamedSetTag(tag) {
  const t = (tag || '').toLowerCase().trim();
  if (!t) return false;
  if (t.startsWith('pop!')) return false;                 // product line, not a set
  if (SET_GENERIC_LINES.has(t)) return false;             // generic line, not a themed set
  if (SET_EXCLUDE_KW.some(k => t.includes(k))) return false;
  return SET_SUFFIXES.some(suf => t.endsWith(suf) || t.endsWith(suf + 's'));
}

// Pick the most-specific named-set tag from a record's series array. Among the
// set-qualifying tags, prefer the rarest in the catalog (a specific set like
// "Haunted Mansion Mini Vinyl Figures" is rarer than a broad line like "Disney
// Mini Vinyl Figures"), using the supplied frequency map as the tiebreak.
function pickSetTag(series, tagFreq) {
  const cands = (series || []).filter(isNamedSetTag);
  if (cands.length === 0) return '';
  return cands.reduce((best, s) =>
    (tagFreq.get(s) || 0) < (tagFreq.get(best) || 0) ? s : best, cands[0]);
}

// PriceCharting consoles that are umbrella / genre lines, not properties. A figure
// under one of these carries no property signal, so no franchise is suggested.
// Seeded from a live run's console distribution; extend as new umbrella consoles
// appear. Slugs are the part after "funko-pop-".
const UMBRELLA_CONSOLES = new Set([
  'animation', 'star-wars', 'disney', 'marvel', 'television', 'comics',
  'movies', 'games', 'heroes', 'icons', 'rocks', 'ad-icons', 'retro-toys',
  'asia', 'art-series', 'digital', 'vinyl-soda', 'soda', 'rides',
]);

// Title-case a console slug into a readable franchise suggestion.
// "harry-potter" → "Harry Potter", "fantastic-beasts" → "Fantastic Beasts".
// Known acronyms/brands are upper-cased rather than title-cased.
const CONSOLE_ACRONYMS = {
  wwe: 'WWE', mlb: 'MLB', nfl: 'NFL', nba: 'NBA', nhl: 'NHL', mls: 'MLS',
  bape: 'BAPE', vhs: 'VHS', se: 'SE', dc: 'DC', tv: 'TV', ufc: 'UFC',
};
function consoleSlugToLabel(slug) {
  return slug.split('-')
    .map(w => CONSOLE_ACRONYMS[w] || (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// Derive a Funko product-line CATEGORY ("Pop! Rocks", "Pop! Rides") from a
// PriceCharting console slug ("funko-pop-rocks") or a pricecharting /game/ URL.
// Pass 3b-discovered records are born with only a console slug + pricechartingUrl
// and no category; without this they import category-blank, which both looks wrong
// in the app AND fails to feed the dynamic category dropdown (which reads distinct
// catalog categories). Returns '' if the slug isn't a funko-pop-* console.
function categoryFromConsole(consoleSlug, pcUrl) {
  let slug = consoleSlug || '';
  if (!slug && pcUrl) {
    const m = /\/game\/(funko-pop-[a-z0-9-]+)\//.exec(pcUrl);
    if (m) slug = m[1];
  }
  const m = /^funko-pop-(.+)$/.exec(slug);
  if (!m) return '';
  const label = consoleSlugToLabel(m[1]);   // "rocks" → "Rocks"
  return label ? `Pop! ${label}` : '';
}

function franchiseSuggestionFromUrl(url) {
  if (!url) return '';
  const m = /\/game\/funko-pop-([a-z0-9-]+)\//.exec(url);
  if (!m) return '';
  const slug = m[1];
  if (UMBRELLA_CONSOLES.has(slug)) return '';   // umbrella → no property signal
  return consoleSlugToLabel(slug);
}

// pcSeries (the PriceCharting product-page "Series:" row) carries the actual
// property (e.g. "Hocus Pocus", "Dragon Ball Z") far more reliably than the
// console. PriceCharting appends retailer/event/format qualifiers after a "." or
// "," (e.g. "Dragon Ball Z. FYE", "My Hero Academia, Target"); we take the
// leading segment and drop it when that segment is itself pure noise. Verified
// against a live run: recovers 612/653 tagged records to a clean property.
const PCSERIES_HARD_NOISE = new Set([
  'walmart', 'wal-mart', 'only at walmart', 'funko shop', 'funko shop.',
  'funko pop figure', 'vinyl figure', "collector's edition", 'impressions',
  'icons', 'slam', 'target', 'gamestop', 'hot topic', 'boxlunch', 'box lunch',
  'fye', 'f.y.e.', 'amazon', 'disney store', 'px previews exclusive',
  'summer convention', 'summer funko convention', 'funko spring convention', 'tpm25',
]);
const PCSERIES_EVENT_KW = [
  'exclusive', 'convention', 'sdcc', 'nycc', 'eccc', 'd23', 'comic con',
  'celebration', 'loot crate', 'blizzard', 'walgreens', 'px previews', 'ccxp',
  'lacc', 'galactic convention', 'limited edition', 'blacklight', 'funko fundays',
  'funko shop', 'first to market',
];

function franchiseFromPcSeries(pcSeries) {
  if (!pcSeries) return '';
  const seg = pcSeries.split(/[.,]/)[0].trim();
  if (!seg) return '';
  const low = seg.toLowerCase();
  if (PCSERIES_HARD_NOISE.has(low)) return '';
  if (seg.split(/\s+/).length <= 4 && PCSERIES_EVENT_KW.some(k => low.includes(k))) return '';
  return seg;
}

function deriveGroupingFields(enriched) {
  console.log('\n── Post-process: Derive setTag + franchiseSuggestion ─────────');

  // Build a catalog-wide series-tag frequency map for the setTag tiebreak.
  const tagFreq = new Map();
  for (const rec of enriched) {
    for (const s of (rec.series || [])) {
      tagFreq.set(s, (tagFreq.get(s) || 0) + 1);
    }
  }

  let setCount = 0, frCount = 0, catCount = 0;
  for (const rec of enriched) {
    const setTag = pickSetTag(rec.series, tagFreq);
    if (setTag) { rec.setTag = setTag; setCount++; }

    // Franchise: prefer the cleaned pcSeries property, else the property-specific
    // console. Umbrella consoles and pure-noise pcSeries yield nothing → blank
    // (the app prompts the user to assign).
    const fr = franchiseFromPcSeries(rec.pcSeries) || franchiseSuggestionFromUrl(rec.pricechartingUrl);
    if (fr) { rec.franchiseSuggestion = fr; frCount++; }

    // Category: Pass 3b-discovered records (and any record) lacking a category
    // get one derived from their PriceCharting console slug ("funko-pop-rides" →
    // "Pop! Rides"). This makes them display correctly and feeds the app's dynamic
    // category dropdown. Only fills when blank — never overwrites an existing
    // category from HobbyDB/funko.com.
    if (!rec.category) {
      const cat = categoryFromConsole(rec.console, rec.pricechartingUrl);
      if (cat) {
        rec.category = cat;
        // Also seed the series array so setTag/grouping has something to work with
        // on otherwise-bare discovered records.
        if (!rec.series || rec.series.length === 0) rec.series = [cat];
        catCount++;
      }
    }
  }

  console.log(`  setTag assigned:             ${setCount}`);
  console.log(`  franchiseSuggestion assigned: ${frCount}`);
  console.log(`  category derived from console: ${catCount}`);
  return enriched;
}


// ═══════════════════════════════════════════════════════════════════════════════
// POST-PROCESS 4 — Merge duplicate handles
// ═══════════════════════════════════════════════════════════════════════════════
//
// The HobbyDB dataset lists the same physical Funko under multiple series/retailer
// tags, producing duplicate handles (e.g. "freddy-frostbear" tagged both
// "Special Delivery" and "Pop! Plush"). Since the Couchbase doc ID is
// catalog::{handle}, duplicates would collide on import — the second silently
// overwrites the first.
//
// This merges all records sharing a handle: series arrays are unioned, and any
// enrichment field (hdbid, upc, funkoNumber, etc.) present on any copy is kept.
// Order is preserved by first occurrence.

const MERGE_FIELDS = [
  'hdbid', 'upc', 'funkoNumber', 'funkoNumberFromTitle', 'funkoSource',
  'price', 'available', 'productUrl', 'funkoPrimaryImage', 'popType',
  'hotTopicSku', 'gamestopSku', 'targetSku', 'walmartSku', 'amazonSku',
  'franchise', 'funkoSection', 'pid', 'marketValueLoose', 'marketValueComplete', 'marketValueNew',
  'marketValueIsApproximate',
  'pricechartingId', 'pricechartingUrl',
  'pcSeries', 'releaseDate', 'ebayEpid', 'amazonAsin', 'printRun', 'publisher', 'pcDescription',
  'setTag', 'franchiseSuggestion',
];

function mergeDuplicateHandles(enriched) {
  console.log('\n── Post-process: Merge duplicate handles ─────────────────────');

  const byHandle = new Map();   // handle -> merged record
  const result = [];

  for (const rec of enriched) {
    const h = rec.handle;
    if (!h) { result.push(rec); continue; }

    if (!byHandle.has(h)) {
      byHandle.set(h, rec);
      result.push(rec);          // placeholder; we mutate it in place
    } else {
      const merged = byHandle.get(h);
      // Union series
      const allSeries = [...(merged.series || [])];
      for (const s of (rec.series || [])) {
        if (!allSeries.includes(s)) allSeries.push(s);
      }
      if (allSeries.length) merged.series = allSeries;
      // Fill any missing enrichment fields
      for (const f of MERGE_FIELDS) {
        if (rec[f] && !merged[f]) merged[f] = rec[f];
      }
    }
  }

  const removed = enriched.length - result.length;
  console.log(`  Duplicate handles merged: ${removed}`);
  console.log(`  Records remaining:        ${result.length}`);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const opts = parseArgs();
  const startTime = Date.now();

  // Load data. RESUME BEHAVIOUR: runs reload from disk each time, and the
  // per-pass caps (hdbLimit etc.) mean one run may not clear the whole backlog.
  // Because progress markers (hdbChecked, prices, discovered records) live in the
  // ENRICHED OUTPUT — not the base — re-running from the base would re-process the
  // same first N candidates forever and never reach the stragglers beyond the cap.
  // So: unless --input was given explicitly, if a prior enriched output exists and
  // is at least as large as the base, resume from IT. This makes each run ADVANCE
  // through the backlog (and re-runs converge on full coverage). Pass 1/2/3b only
  // ADD records and dedupe, so resuming never loses anything.
  let inputPath = path.resolve(opts.input);
  if (!opts.inputExplicit) {
    const outPath = path.resolve(opts.output);
    if (fs.existsSync(outPath)) {
      try {
        const outData = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        // Resume only if the prior output actually carries ENRICHMENT — i.e. some
        // records have been HobbyDB-checked or priced or PriceCharting-discovered.
        // NOTE: do NOT compare output length to base length. The output is
        // intentionally SMALLER than the base (~16k vs base ~24k) because
        // post-process removes non-Pops and merges duplicates; a size test would
        // wrongly reject a perfectly good enriched file and restart from scratch.
        const enrichedCount = outData.reduce((n, r) =>
          n + ((r.hdbChecked || r.marketValueComplete || r.marketValueLoose ||
                r.pricechartingId || r.upc) ? 1 : 0), 0);
        if (outData.length > 0 && enrichedCount > 0) {
          console.log(`Resuming from prior output (${outData.length} records, ${enrichedCount} already enriched) to advance the backlog.`);
          console.log(`  (pass --input ${opts.input} explicitly to force a fresh build from base.)`);
          inputPath = outPath;
        } else {
          console.log(`Prior output has no enrichment markers — building from base.`);
        }
      } catch (e) {
        console.log(`  (could not read prior output, building from base: ${e.message})`);
      }
    }
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }
  console.log(`Loading: ${inputPath}`);
  const existingData = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  console.log(`  ${existingData.length} existing records`);

  // Sanitise titles in base data on load
  existingData.forEach(r => { if (r.title) r.title = sanitiseTitle(r.title); });
  const enriched = [...existingData];
  const { titleIndex, handleIndex } = buildIndexes(enriched);

  const stats = {
    initial:      existingData.length,
    kenny:        { newCount: 0, enrichedCount: 0 },
    funko:        { totalScraped: 0, newCount: 0, enrichedCount: 0 },
    pricecharting:{ found: 0, notFound: 0, errors: 0 },
    pricechartingCrawl:{ discovered: 0, added: 0, pages: 0, withUpc: 0 },
    hobbydb:      { found: 0, notFound: 0, errors: 0 },
    funkoDetail:  { enriched: 0, notFound: 0, errors: 0 },
  };

  // Pass 1 — Kenny Chan
  if (!opts.skipKenny) {
    stats.kenny = await passKennyChan(enriched, titleIndex, handleIndex);
  } else {
    console.log('\n── Pass 1: Kenny Chan — SKIPPED (--skip-kenny)');
  }

  // Pass 2 — funko.com
  if (!opts.skipFunko) {
    stats.funko = await passFunkoCom(enriched, titleIndex, handleIndex, opts);
  } else {
    console.log('\n── Pass 2: funko.com — SKIPPED (--skip-funko)');
  }

  // Pass 4 — HobbyDB reference numbers
  if (!opts.skipHdb) {
    stats.hobbydb = await passHobbyDb(enriched, opts);
  } else {
    console.log('\n── Pass 4: HobbyDB — SKIPPED (--skip-hdb)');
  }

  // Pass 5 — funko.com product page franchise enrichment
  if (!opts.skipFunkoDetail) {
    stats.funkoDetail = await passFunkoDetails(enriched, opts);
  } else {
    console.log('\n── Pass 5: funko.com detail pages — SKIPPED (--skip-funko-detail)');
  }

  // Pass 3b — PriceCharting catalog crawl (discover missing Pops) — runs BEFORE
  // Pass 3 pricing so newly-discovered records get priced in the same run.
  if (!opts.skipPc) {
    stats.pricechartingCrawl = await passPriceChartingCrawl(enriched, opts);
  }

  // Pass 3 — PriceCharting (before post-processing so merges include PC data)
  if (!opts.skipPc) {
    stats.pricecharting = await passPriceCharting(enriched, opts);
  } else {
    console.log('\n── Pass 3: PriceCharting — SKIPPED (--skip-pc)');
  }

  // ── Post-processing (order matters) ──────────────────────────────────────
  // 1. Remove non-Pop records FIRST, per-record, before any handle merge.
  //    A real Pop and a non-Pop (Wacky Wobbler, Mystery Mini, Pocket Pop, etc.)
  //    can share one HobbyDB handle. If handles are merged first, the union of
  //    their series tags carries the non-Pop tag onto the fused record, and the
  //    non-Pop filter then deletes the whole thing — silently dropping the real
  //    Pop (e.g. "Ronald McDonald" Pop! Ad Icons fused with its Wacky Wobbler
  //    twin). Filtering each raw record on its own merits first means the
  //    non-Pop copy is dropped alone and the Pop copy survives to be merged.
  //    Verified on the full base: rescues ~1,800 Pops, drops 0 legitimate records.
  const cleaned = removeNonPops(enriched);
  enriched.length = 0; enriched.push(...cleaned);

  // 1b. Clean title noise (HTML entities, smart quotes, Funko Pop! prefix,
  //     Bobble-Head suffix) BEFORE handle-merge and number extraction, so those
  //     steps see the cleaned titles. Conservative — preserves #numbers, variant
  //     qualifiers, and series-colon names.
  cleanTitles(enriched);

  // 2. Merge duplicate handles — now safe, the non-Pop twins are already gone.
  const handleMerged = mergeDuplicateHandles(enriched);
  enriched.length = 0; enriched.push(...handleMerged);

  // 3. Dedup funko.com additions against the now-clean HobbyDB records
  const deduped = dedupeAndMerge(enriched);
  enriched.length = 0; enriched.push(...deduped);

  // 3b. Safety net: re-run the non-Pop filter after the funko.com dedup, in case
  //     a funko.com addition carried a non-Pop series tag. After the step-1
  //     reorder this should remove ~nothing from the HobbyDB side.
  const cleaned2 = removeNonPops(enriched);
  enriched.length = 0; enriched.push(...cleaned2);

  // 4. Extract Pop# from titles and clean dirty prices
  extractNumbersFromTitles(enriched);

  // 5. Derive collection-grouping fields (setTag, franchiseSuggestion) LAST, over
  //    the final clean record set, so the series-tag frequency map and console
  //    reads reflect post-merge/post-removal data.
  deriveGroupingFields(enriched);

  // Write output
  const outputPath = path.resolve(opts.output);
  fs.writeFileSync(outputPath, JSON.stringify(enriched, null, 2), 'utf8');

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('\n═══ Final Summary ══════════════════════════════════════════');
  console.log(`  Initial records:          ${stats.initial}`);
  console.log(`  Pass 1 — Kenny Chan:`);
  console.log(`    New records added:      ${stats.kenny.newCount}`);
  console.log(`    Existing enriched:      ${stats.kenny.enrichedCount}`);
  console.log(`  Pass 2 — funko.com:`);
  console.log(`    Pages scraped:          ${stats.funko.totalScraped} products`);
  console.log(`    New records added:      ${stats.funko.newCount}`);
  console.log(`    Existing enriched:      ${stats.funko.enrichedCount}`);
  console.log(`  Pass 5 — funko.com detail pages:`);
  console.log(`    Franchise enriched:     ${stats.funkoDetail.enriched}`);
  console.log(`    Not found:              ${stats.funkoDetail.notFound}`);
  console.log(`    Errors:                 ${stats.funkoDetail.errors}`);
  console.log(`  Pass 4 — HobbyDB:`);
  console.log(`    Records enriched:       ${stats.hobbydb.found}`);
  console.log(`    Not found:              ${stats.hobbydb.notFound}`);
  console.log(`    Errors:                 ${stats.hobbydb.errors}`);
  console.log(`  Pass 3 — PriceCharting:`);
  console.log(`    Market prices found:    ${stats.pricecharting.found}`);
  console.log(`    Not found:              ${stats.pricecharting.notFound}`);
  console.log(`  Output records:           ${enriched.length}`);
  const fromTitle = enriched.filter(r => r.funkoNumberFromTitle).length;
  console.log(`  Pop# extracted from title: ${fromTitle}`);
  console.log(`  (non-Pop HobbyDB records removed in post-process)`);
  console.log(`  Output file:              ${outputPath}`);
  console.log(`  Total time:               ${elapsed}s`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
