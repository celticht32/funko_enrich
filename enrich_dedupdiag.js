/**
 * Funko Data Enricher
 * MIT License, Copyright (c) 2026 Chris Ahrendt
 *
 * Enrichment pipeline (Kenny Chan Pass 1 removed — that dataset was deprecated
 * and its per-character shape was the source of most data-quality problems):
 *   Pass 2 — funko.com scrape
 *             Adds: price, available, productUrl, funkoPrimaryImage, pid
 *   Pass 3 — PriceCharting.com scrape
 *             Adds: marketValueLoose, marketValueComplete, marketValueNew,
 *                   pricechartingId, pricechartingUrl
 *             Only runs on records still missing market pricing after Pass 2.
 *   Pass 4 — HobbyDB reference scrape (Reference Numbers / series tags)
 *   Pass 5 — funko.com detail pages (breadcrumb franchise)
 *
 * OUTPUT SHAPE: by default the output is the base catalog document shape
 * (catalog:: ids, string `series`, derived isExclusive/isChase/seriesNumber,
 * scaffolding fields dropped) — i.e. the file IS a base catalog, ready to ship /
 * import with no further translation. Pass --working-shape for the raw enricher
 * shape (array series, no catalog:: ids) if a downstream tool still needs it.
 *
 * Usage:
 *   node enrich.js [options]
 *
 * Options:
 *   --input           Input catalog JSON                   (default: funkodex_base_catalog.json)
 *   --output          Path for enriched output             (default: funkodex_base_catalog.enriched.json)
 *   --working-shape   Emit raw enricher shape instead of the base catalog shape
 *   --catalog-source  `source` value for records lacking one (default: ENRICHED)
 *   --delay           Milliseconds between requests        (default: 1500)
 *   --max-pages       Stop funko.com after N pages         (default: 0 = unlimited)
 *   --skip-funko      Skip Pass 2 (funko.com scrape)
 *   --skip-pc         Skip Pass 3 (PriceCharting scrape)
 *   --pc-limit        Max items to look up on PriceCharting (default: 100000 = all)
 *   --pc-crawl        Pass 3b: discover & add PriceCharting Pops not in catalog (DEFAULT ON)
 *   --no-pc-crawl     Disable Pass 3b (faster runs that don't grow the record set)
 *   --pc-crawl-limit  Cap console sets crawled in Pass 3b (default: no cap)
 *   --pc-fill-upc     Pass 3: also fill UPC on priced-but-no-UPC records (DEFAULT ON)
 *   --no-pc-fill-upc  Disable the UPC top-up
 *   --skip-hdb        Skip Pass 4 (HobbyDB Reference Numbers / series scrape)
 *   --hdb-limit       Max HobbyDB lookups per run        (default: 6000; --hdb-limit 1000000 = uncapped)
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
const cheerio = require('cheerio');

// ─── CLI args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    input:      'funkodex_base_catalog.json',
    output:     'funkodex_base_catalog.enriched.json',
    delay:      1500,
    maxPages:   0,
    skipFunko:  false,
    skipPc:     false,
    // Completeness-maximizing defaults: a plain `node enrich.js` now does the
    // most complete build possible (longest run). Use the --no-* / smaller-limit
    // flags below for quick test runs.
    pcLimit:    100000, // Pass 3: price every unpriced candidate (was 500 cap)
    pcCrawl:    true,   // Pass 3b: discover & add PriceCharting Pops not in catalog
    pcCrawlLimit: Infinity, // no cap on console-set crawl
    pcCrawlOnly: null,      // crawl only these console slugs (comma-separated) — e.g. --pc-crawl-only funko-pop-disney,funko-pop-marvel
    pcFillUpc:  true,   // Pass 3: also revisit priced-but-no-UPC records to fill UPC
    repriceOlderThan: 0, // Pass 3: if >0, re-price records whose priceCheckedAt is
                         // older than this many days (refreshes aging prices). 0=off.
    chromePath: null,
    popsOnly:   false,
    skipHdb:    false,
    hdbLimit:   6000,   // per-run cap on HobbyDB visits (~2.5h at 1500ms). The
                        // candidate filter already skips records that are complete,
                        // so on an enriched catalog a single run usually clears the
                        // whole backlog; on a fresh crawl this bounds one run to a
                        // sane length and the resume/checkpoint design lets repeated
                        // runs converge on full coverage without redoing work.
                        // Pass --hdb-limit 1000000 to force one uncapped run.
    hdbDelay:   1500,   // ms between HobbyDB requests
    hdbAll:          false,  // look up all records, not just missing
    retryNoRefs:     false,  // re-fetch records with hdbChecked but no hdbid
    retryNoSeries:   false,  // re-fetch hdbChecked HobbyDB records missing series tags
    skipFunkoDetail:  false,
    funkoDetailDelay: 1000,  // ms between product page fetches (domcontentloaded = fast)
    popFilter:  true,   // keep only standard Pops from funko.com
  };
  // Parse an integer flag value, falling back to the existing default if the
  // value is missing or non-numeric — a typo like "--hdb-limit abc" otherwise
  // yields NaN, which silently makes `.slice(0, NaN)` return zero candidates and
  // a whole pass do nothing.
  const intArg = (raw, fallback) => {
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) {
      console.warn(`  [warn] ignoring non-numeric flag value "${raw}" — using ${fallback}`);
      return fallback;
    }
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input':       opts.input      = args[++i]; opts.inputExplicit = true; break;
      case '--output':      opts.output     = args[++i]; break;
      case '--delay':       opts.delay      = intArg(args[++i], opts.delay); break;
      case '--max-pages':   opts.maxPages   = intArg(args[++i], opts.maxPages); break;
      case '--skip-funko':  opts.skipFunko  = true; break;
      case '--skip-pc':     opts.skipPc     = true; break;
      case '--pc-limit':    opts.pcLimit    = intArg(args[++i], opts.pcLimit); break;
      case '--pc-crawl':    opts.pcCrawl    = true; break;
      case '--no-pc-crawl':    opts.pcCrawl   = false; break; // opt out of Pass 3b (faster test runs)
      case '--no-pc-fill-upc': opts.pcFillUpc = false; break; // opt out of UPC top-up
      case '--pc-crawl-limit': opts.pcCrawlLimit = intArg(args[++i], opts.pcCrawlLimit); break;
      case '--pc-crawl-only': opts.pcCrawlOnly = (args[++i]||'').split(',').map(s=>s.trim()).filter(Boolean); break;
      case '--pc-fill-upc': opts.pcFillUpc = true; break;
      case '--reprice-older-than': opts.repriceOlderThan = intArg(args[++i], opts.repriceOlderThan); break;
      case '--chrome-path': opts.chromePath = args[++i]; break;
      case '--pops-only':   opts.popsOnly   = true; break;
      case '--no-pop-filter': opts.popFilter = false; break;
      case '--skip-hdb':    opts.skipHdb   = true; break;
      case '--hdb-limit':   opts.hdbLimit  = intArg(args[++i], opts.hdbLimit); break;
      case '--hdb-delay':   opts.hdbDelay  = intArg(args[++i], opts.hdbDelay); break;
      case '--hdb-all':          opts.hdbAll          = true; break;
      case '--retry-no-refs':    opts.retryNoRefs     = true; break;
      case '--retry-no-series':  opts.retryNoSeries   = true; break;
      case '--skip-funko-detail': opts.skipFunkoDetail = true; break;
      case '--funko-detail-delay': opts.funkoDetailDelay = intArg(args[++i], opts.funkoDetailDelay); break;
      case '--scrub-collisions': opts.scrubCollisions = true; break; // run the UPC collision-scrub post-pass (dry-run unless --scrub-apply)
      case '--scrub-apply':      opts.scrubApply      = true; break; // actually blank UPCs (default: report only, no writes)
      case '--working-shape':    opts.workingShape    = true; break; // emit the raw enricher shape (array series, no catalog:: ids) instead of the default base catalog shape
      case '--catalog-source':   opts.catalogSource   = args[++i]; break; // value written to `source` on records that don't already carry one (default: ENRICHED)
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
  return decodeHtmlEntities(t || '').replace(/\s+/g, ' ').trim();
}

/**
 * Decode the HTML entities that leak in from source titles that did NOT come
 * through cheerio's .text() (Kenny Chan JSON, PriceCharting fields, raw
 * attributes). In practice only &amp; appears (536 records: "X &amp; Y
 * (2-Pack)"), but the others are handled defensively and cost nothing. Loops
 * until stable so double-encoded input ("&amp;amp;" → "&amp;" → "&") fully
 * collapses; the loop is bounded and terminates once no entity remains.
 */
function decodeHtmlEntities(s) {
  if (!s || s.indexOf('&') === -1) return s || '';
  let prev = s, out = decodeHtmlEntitiesOnce(s), guard = 0;
  while (out !== prev && guard++ < 5) { prev = out; out = decodeHtmlEntitiesOnce(out); }
  return out;
}

function decodeHtmlEntitiesOnce(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rdquo;/g, '\u201d')
    .replace(/&ldquo;/g, '\u201c')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');   // must be last
}

/**
 * HobbyDB CDN image filenames encode the media category, e.g.
 *   .../image/479339/Thumper_Pins_and_Badges_8505845b-...large.jpg
 *   .../image/798686/Maid_Vinyl_Art_Toys_ad190664-...png
 * When a character has both a Pop figure and merch (pin, keychain, plush, PEZ,
 * shirt) under the same name, HobbyDB sometimes returns the MERCH photo for the
 * figure record. Storing that gives the figure a pin/keychain image (the
 * "Thumper shows a pin" bug). This rejects URLs whose media token is a known
 * non-figure category, so a wrong image is never stored — the record keeps an
 * empty imageUrl (placeholder) instead, which is preferable to a wrong image.
 *
 * Denylist (not allowlist) so new figure media tokens HobbyDB may introduce are
 * not accidentally rejected. Returns true if the URL is acceptable (figure or
 * unknown), false if it is a recognised non-figure image.
 *
 * (The former isFigureImage() merch-denylist helper was removed with Kenny Pass 1;
 * the funko.com and PriceCharting image paths don't use HobbyDB's CDN filename
 * tokens, so the denylist never applied to them.)
 */

/**
 * PriceCharting serves product photos from a Google Cloud Storage CDN, sized by
 * filename:
 *   https://storage.googleapis.com/images.pricecharting.com/<hash>/60.jpg
 * Only 60, 240, 320 and 1600 exist (100/128/300/480/640/1280 all 404). The
 * console listing embeds the 60px thumbnail; we rewrite it to 1600 for a
 * full-resolution image. When the source photo is smaller than 1600 the CDN
 * simply returns it as-is rather than upscaling or 404ing, so asking for 1600
 * always yields the best available and never fails.
 *
 * The HobbyDB `isFigureImage` merch denylist is deliberately NOT applied here:
 * it keys on HobbyDB's filename media tokens, and PriceCharting hashes are
 * opaque. PriceCharting pages are one-image-per-product keyed by
 * pricechartingId, so there is no figure/merch mix-up to guard against.
 *
 * Returns '' for anything that isn't a recognisable PriceCharting CDN URL.
 */
function pcFullSizeImage(src) {
  if (!src) return '';
  const m = String(src).match(
    /^(https?:\/\/storage\.googleapis\.com\/images\.pricecharting\.com\/[A-Za-z0-9]+)\/\d+\.jpg$/);
  return m ? `${m[1]}/1600.jpg` : '';
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
 * Core identity fields (handle, title, imageUrl, series) are never overwritten.
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
                imageUrl:          scraped.funkoPrimaryImage || '',
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
const PC_DELAY       = 1100; // ms between PriceCharting requests — be polite
                             // (lowered from 2500; PriceCharting serves plain
                             // pages without aggressive rate-limiting. If you get
                             // blocked/throttled, raise this back toward 2500.)

/**
 * Reduce a catalog title to a core search query. PriceCharting's search wants
 * the base character/name, not the decorated variant title. We strip
 * parenthetical and bracketed qualifiers ("(Metallic)", "[Chase]"), drop a
 * trailing "#NN", collapse whitespace, and append "funko" so the search scopes
 * to Pops. Example:
 *   "Twinkie The Kid (Glow In The Dark) (Logo Bandana)" → "Twinkie The Kid funko"
 */
function pcSearchQuery(rec) {
  // Accept either a record or a bare title string (back-compat).
  const title = typeof rec === 'string' ? rec : (rec && rec.title) || '';
  const num = typeof rec === 'object' && rec
    ? String(rec.funkoNumber || rec.funkoNumberFromTitle || '').replace(/[^0-9]/g, '')
    : '';
  const base = title
    .replace(/[\(\[][^\)\]]*[\)\]]/g, ' ')   // remove (...) and [...] qualifiers
    .replace(/#\s*\d+/g, ' ')                // remove "#27"
    .replace(/\s+/g, ' ')
    .trim();
  // PriceCharting's search matches "name #NN" (their own docs show "charizard
  // #4" as an example query), and the number is a strong disambiguator among
  // same-named figures. Append it when we have a clean one. Scoring still picks
  // the final row, so a stray number only reorders results, it doesn't force a
  // wrong match through the confidence gate.
  const q = num ? `${base} #${num}` : base;
  return q + ' funko';
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
  // UPC match: the barcode is an exact product key and PriceCharting already
  // resolved it to this product, so we trust it directly. This is the whole point
  // of the UPC-first path — it rescues figures whose NAMES differ enough that the
  // title-based gate below would (correctly, for title matches) reject them, e.g.
  // multi-character 2-packs or oddly-named variants. A single-row UPC hit is exact;
  // a multi-row UPC hit already had title scoring applied to pick among same-UPC
  // rows, so it's still UPC-grounded. We do NOT mark these approximate — the UPC
  // identifies the exact product, so its price is the exact price.
  if (row._matchedBy === 'upc' || row._matchedBy === 'upc-multi') {
    return { ok: true, reason: `upc match (${row._matchedBy})`, approximate: false };
  }

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
  // Match on WORD BOUNDARIES, not raw substrings. A plain `includes` accepts a
  // token that merely sits inside a longer word, which silently matched entirely
  // different figures: "Ram" -> "Bram Stoker" ("ram" inside "bram"), "Poe" ->
  // "Poet Anderson" ("poe" inside "poet"), "Will" -> "Chilly Willy" ("will"
  // inside "willy"). Tokenising the row name and comparing whole words closes
  // that hole while still allowing the row to carry extra words (which is the
  // point of "covered" — "Erza" is covered by "Erza Scarlet").
  const rowWords = new Set(
    String(rowName || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
  return want.every(w => rowWords.has(w));
}


/**
 * Records that must NEVER be matched against PriceCharting, in EITHER direction.
 *
 * These are Toyzilla / Chuck Huber certified SIGNED editions (Kurogiri #789 and
 * Android 17 #529 — both Chuck Huber, who voices Dragon Ball / My Hero Academia
 * roles). Each is a real, distinct product that shares its base figure's UPC and
 * Pop number — correctly, because a signed Pop IS the base figure in its original
 * box with a signature and COA added, not a new SKU. (Do not let a future
 * UPC-mis-staple pass blank these barcodes: the sharing is legitimate, cf. the
 * S22 tiered UPC rule that spared ~258 legitimate shared UPCs.)
 *
 * They cannot be protected by matching logic. Verified in S23, not assumed:
 *   - coreNameCovered("Kurogiri", "kurogiri") === true. The word-boundary fix
 *     blocks WRONG-CHARACTER matches; this is a RIGHT-character, WRONG-PRODUCT
 *     match — the unfixable-from-text class (S22 open item #2).
 *   - Renaming the title to "Kurogiri (Toyzilla Signed Edition)" does NOT help:
 *     coreNameTokens() strips parentheticals (see above), so the title tokenises
 *     to exactly ["kurogiri"] — identical to the bare title. The rename is for
 *     humans reading the catalog; it is NOT a guard.
 *   - dedupeAndMerge's coreNoParens() strips them too, so a PriceCharting crawl
 *     row "Kurogiri #789" matches the signed record AND the base equally; which
 *     one wins is array order, not logic.
 *   - The UPC-first path in searchPriceCharting() is worse still: these carry the
 *     BASE figure's barcode, so a UPC lookup resolves to the base Pop by design.
 *
 * Without this list the pricing pass re-stamps the base figure's identity and its
 * ~$5 price onto a ~$95 signed collectible. Note the trap: these records have NO
 * price precisely because S23 blanked the wrongly-inherited base pricing
 * (DEC-025), and `!hasPrice` is exactly what makes a record a candidate in
 * passPriceCharting. The safe state is what pulls them in.
 *
 * Consequence, accepted deliberately: these records stay unpriced until a real
 * signed-market value is sourced from a listing or packaging. Blank beats wrong.
 *
 * Used in TWO places — grep PC_SKIP_IDS before changing either:
 *   1. passPriceCharting()  — candidate filter (never priced)
 *   2. dedupeAndMerge()     — canonicalByNum index (never a merge target)
 */
const PC_SKIP_IDS = new Set([
  'catalog::kurogiri-toyzilla-signed-edition',   // Kurogiri (Toyzilla Signed Edition) #789
  'catalog::android-17-toyzilla-signed-edition', // Android 17 (Toyzilla Signed Edition) #529
  // NOT catalog::summer-bbq-bash — that record was a mis-identification (S23).
  // hobbyDB 339696 files it under Shirts and Jackets: it is APPAREL that had the
  // real Bash Pop's #623 and UPC 889698506939 mis-stapled onto it, which is what
  // made it look like a signed twin. It has been deleted; the real Bash lives at
  // catalog::bash-pop!-vinyl (Fortnite, Pop! Games, pcId 7516024) and is an
  // ordinary Pop that SHOULD be priced. See fix_bash_misidentification.py.
  // ── S23 mismatch repoints: wrong PriceCharting slug matches, corrected by
  //    hand and pricing blanked. Skip so a re-run does not re-match them. ──
  'catalog::88467.html',                       // Al Chicken Suit->Toy Story #1600
  'catalog::92438.html',                       // Batman Bat-Manga #621
  'catalog::5902.html',                        // Quidditch Harry #08
  'catalog::75374.html',                       // Freddie WWRY #414
  'catalog::75375.html',                       // Freddie IWBTLY
  'catalog::59624.html',                       // Minnie #1188
  'catalog::63983.html',                       // Tiffany #1250
  'catalog::93539.html',                       // Chun-Li #1259
  'catalog::93676.html',                       // Mega Man X #1280
  'catalog::86262.html',                       // Mark (Love Actually) #1960
  'catalog::59623.html',                       // Mickey #1187
  'catalog::88518.html',                       // Superman #613
  'catalog::88532.html',                       // Edison (One Piece) #2135
  'catalog::88157.html',                       // Sweet (Buffy) #1774
  'catalog::89331.html',                       // Rowdy (NFL) #314
  'catalog::89350.html',                       // Viktor (NFL) #319
  'catalog::84907.html',                       // Killer (One Piece) #1895
  'catalog::81204.html',                       // Tiger (American Tail) #1654
  'catalog::93635.html',                       // The Doctor (Star Trek) #1928
  'catalog::87934.html',                       // H.E.R.B.I.E. #1504
  // ── S23 restored owned figures: real Pop! Disney records the dedup pass
  //    removed, but the user OWNS them (catalogRef links + pricePaid). Skip
  //    so dedup never removes them again. See CLAUDE_STATE restore note. ──
  'catalog::pc-12395106',                      // Mia Thermopolis #1732
  'catalog::pc-7488382',                       // Merida #1245
  'catalog::pc-7488126',                       // Anna #1023
  'catalog::pc-10538959',                      // Rapunzel #1641
  'catalog::pc-10539028',                      // Maleficent #1648
  'catalog::mr.-toad-65th-anniversary',        // Mr. Toad 65th #814
]);


/**
 * Search PriceCharting for a record and return the best-matching listing row
 * (with id, name, console, and inline prices). Uses the HTML search-products
 * page through the shared Puppeteer `page` (the JSON /api/products endpoint is
 * unreliable and the plain-fetch path gets blocked), parses the result rows with
 * the same verified listing parser, and picks the best variant by score.
 * Returns a row object or null.
 */
async function searchPriceCharting(page, rec) {
  // ── UPC-first path ─────────────────────────────────────────────────────────
  // UPC is an exact product key. PriceCharting's search box accepts a UPC and
  // resolves it to the matching product, so when the record carries a usable
  // barcode we try that FIRST — it converts many title-search failures (variant
  // 2-packs, oddly-named figures) into confident matches. If the UPC search
  // yields a Funko row we take it; otherwise we fall through to the title search
  // below, which is unchanged. Only valid 12/13-digit barcodes are attempted
  // (normalizeUpc returns null otherwise), so this adds at most one extra fetch
  // and only for records that have a real UPC.
  const upc = normalizeUpc(rec.upc);
  if (upc) {
    try {
      const upcUrl = PC_HTML_SEARCH(upc);
      await page.goto(upcUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const upcHtml = await page.content();
      let upcRows = parsePriceChartingListing(upcHtml).filter(r => /^funko-pop-/.test(r.console || ''));
      // A UPC search ideally resolves to exactly one product. If it returns
      // multiple Funko rows, the UPC was ambiguous on PC's side — fall back to
      // title scoring among them rather than guessing. If exactly one, that's the
      // exact-key match; accept it directly.
      if (upcRows.length === 1) {
        upcRows[0]._matchedBy = 'upc';
        return upcRows[0];
      }
      if (upcRows.length > 1) {
        let best = null, bestScore = -1e9;
        upcRows.forEach((row, i) => {
          const s = scorePcRow(row, rec) - i * 0.01;
          if (s > bestScore) { bestScore = s; best = row; }
        });
        if (best) { best._matchedBy = 'upc-multi'; return best; }
      }
      // upcRows.length === 0 → UPC not in PC's database; fall through to title.
      await sleep(PC_DELAY);  // polite gap between the UPC fetch and the title fetch
    } catch (err) {
      // UPC attempt failed (timeout/parse) — fall through to title search.
    }
  }

  // ── Title path (unchanged) ─────────────────────────────────────────────────
  try {
    const url = PC_HTML_SEARCH(pcSearchQuery(rec));
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
 * Validate a barcode's check digit. Accepts a 12-digit UPC-A or a 13-digit
 * EAN-13 (a leading-zero UPC-A comes through as 13). Returns true only when the
 * trailing check digit is arithmetically correct. Used to refuse a UPC that a
 * scrape may have truncated, mis-read, or pulled from the wrong element before
 * it can be written onto a record — a malformed barcode is worse than none,
 * since a blank field re-resolves cleanly and a wrong one corrupts silently.
 */
function upcaChecksumOk(raw) {
  const d = String(raw || '').replace(/[^0-9]/g, '');
  let u = d;
  if (d.length === 13) u = d.slice(1);        // EAN-13 leading zero → UPC-A
  if (u.length !== 12) return false;
  let odd = 0, even = 0;
  for (let i = 0; i < 11; i++) {
    const n = u.charCodeAt(i) - 48;
    if (i % 2 === 0) odd += n; else even += n;
  }
  const check = (10 - ((odd * 3 + even) % 10)) % 10;
  return check === (u.charCodeAt(11) - 48);
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
  const repriceMs = opts.repriceOlderThan > 0 ? opts.repriceOlderThan * 86400000 : 0;
  const now = Date.now();
  const candidates = enriched
    .map((rec, i) => ({ rec, i }))
    .filter(({ rec }) => {
      // Signed/certified editions: never price-match. They share the base
      // figure's UPC and name, so BOTH the title path and the UPC-first path
      // resolve to the wrong product. See PC_SKIP_IDS for the verification.
      // These records have no price *because* the wrong base pricing was
      // deliberately blanked (DEC-025) — the !hasPrice test below is exactly
      // what would drag them back in.
      if (PC_SKIP_IDS.has(rec._id)) return false;
      const hasPrice = !!(rec.marketValueLoose || rec.marketValueComplete || rec.marketValueNew);
      const hasUpc   = !!(rec.upc && String(rec.upc).trim());
      if (!hasPrice) return true;            // never priced → look up
      if (fillUpc && !hasUpc) return true;   // priced but no UPC → revisit for UPC
      // Stale-price refresh: if enabled, a priced record whose capture date is
      // older than the threshold (or has no date at all) re-enters the pool so
      // its market value gets refreshed.
      if (repriceMs > 0) {
        const t = rec.priceCheckedAt ? Date.parse(rec.priceCheckedAt) : NaN;
        if (isNaN(t) || (now - t) > repriceMs) return true;
      }
      return false;                          // already complete & fresh → skip
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

      // Checkpoint every 100 iterations so an interruption during this
      // (potentially long) pricing pass doesn't lose its work — same pattern as
      // Pass 4. Placed at the TOP of the loop so records that `continue` (not
      // found / uncertain / no price) don't bypass the save. The priced records
      // persist; a restart re-prices at most ~100. Unindented to keep it cheap.
      if (i > 0 && i % 100 === 0) {
        try { fs.writeFileSync(path.resolve(opts.output), JSON.stringify(enriched), 'utf8'); }
        catch (e) { console.log(`  [warn] checkpoint save failed: ${e.message}`); }
      }

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
        // ISO date this price was captured. Enables --reprice-older-than to
        // refresh aging prices on a later run. Records priced before this field
        // existed simply have no timestamp and are treated as "stale" by the
        // reprice filter (so they get refreshed once, then carry a date forward).
        priceCheckedAt:   new Date().toISOString(),
        priceSource:      'pricecharting',  // a real PC price was found; the app's
                                            // live tiers don't need to fill this.
      };
      if (loose)    updates.marketValueLoose    = loose;
      if (complete) updates.marketValueComplete = complete;
      if (mint)     updates.marketValueNew      = mint;
      // Flag approximate matches (variant record priced from the base figure
      // because PriceCharting doesn't list the variant separately).
      if (conf.approximate) updates.marketValueIsApproximate = true;

      // Harvest any metadata into fields the record is MISSING — never overwrite
      // existing values (HobbyDB/funko.com data is treated as authoritative).
      //
      // UPC is special. A barcode is an EXACT product key: transferring it from a
      // PriceCharting product onto a record asserts the two are the same product.
      // On an approximate match (a variant priced from its base figure because PC
      // doesn't list the variant separately) or a loose substring base-name match,
      // that assertion is false — and stapling the base figure's UPC onto the
      // variant is exactly how one barcode ends up shared across different figures
      // (the mis-staple class the fix_*_upc scripts had to clean up). So we only
      // let a PC-page UPC through when the match is UPC-grounded or an EXACT
      // core-name match. Every other meta field (price, series, dates) keeps the
      // fill-if-missing behaviour, since a slightly-off price is harmless where a
      // wrong UPC is corrupting.
      const meta = (detail && detail.meta) || {};
      const upcTransferAllowed =
        match._matchedBy === 'upc' ||
        match._matchedBy === 'upc-multi' ||
        (!conf.approximate && coreNameExact(rec.title, match.name));
      let metaFilled = 0;
      for (const [k, v] of Object.entries(meta)) {
        if (k === 'upc' && !upcTransferAllowed) continue;         // block mis-staple
        if (k === 'upc' && !upcaChecksumOk(v)) continue;          // block malformed barcode
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
    // Final save to capture the last partial batch.
    try { fs.writeFileSync(path.resolve(opts.output), JSON.stringify(enriched), 'utf8'); }
    catch (e) { console.log(`  [warn] final save failed: ${e.message}`); }
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
 * record set beyond the base catalog + funko.com, so it stays on for the golden master.
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
    // The real PriceCharting product id is in the link's title attr. If that's
    // missing, DO NOT fall back to href.split('-').pop() — that returns the
    // trailing Funko number (e.g. ".../shaak-ti-853" → "853"), which is NOT a
    // unique PriceCharting id and repeats across lines, corrupting the havePcId
    // dedupe and the stored pricechartingId. Fall back to the full product slug
    // (the last path segment), which is unique per product.
    const titleId = (a.attr('title') || '').trim();
    const slug = href.split('/').filter(Boolean).pop() || href;
    const id = titleId || slug;
    const name = $(el).find('td.title').text().trim().replace(/\s+/g, ' ');
    const consoleSlug = (href.match(/\/game\/([^/]+)\//) || [])[1] || '';
    out.push({
      id,
      name,
      console: consoleSlug,
      href: href.startsWith('http') ? href : `${PC_BASE}${href}`,
      imageUrl: pcFullSizeImage($(el).find('img.photo').first().attr('src')),
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

  // Index of PriceCharting ids we already have, to dedupe discoveries by pcId
  // (prevents re-adding within/across runs). Catalog-level dedup (same Pop from
  // another source) is handled in post-process dedupeAndMerge.
  //
  // FORMAT TOLERANCE: the stored pricechartingId format changed over time — older
  // runs stored the trailing number from the slug ("853"), newer runs store the
  // full slug ("shaak-ti-853"). To dedupe correctly across that change, register
  // BOTH the raw id and its trailing-number form, and check a discovery's id in
  // both forms too. Without this, records added by a prior run look "new" again
  // (the sets never intersect) and get re-added as duplicates.
  const pcIdForms = id => {
    const s = String(id);
    const forms = new Set([s]);
    const tail = s.match(/(\d+)$/);          // trailing number of a slug
    if (tail) forms.add(tail[1]);
    return forms;
  };
  const havePcId = new Set();
  for (const r of enriched) {
    if (!r.pricechartingId) continue;
    for (const f of pcIdForms(r.pricechartingId)) havePcId.add(f);
  }
  const haveThisPcId = id => {
    for (const f of pcIdForms(id)) if (havePcId.has(f)) return true;
    return false;
  };

  const chromePath = findChrome(opts.chromePath);
  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
  });
  let page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Periodically restart the browser. Pass 3b visits tens of thousands of product
  // pages over many hours on a single Chrome instance; without periodic restarts
  // Chrome's memory grows unbounded and eventually slows or crashes the crawl
  // (Pass 3/4 already do this — 3b is the longest pass and needs it most). Restart
  // every BROWSER_RESTART_INTERVAL product-page fetches.
  const BROWSER_RESTART_INTERVAL = 200;
  let fetchesSinceRestart = 0;
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
    fetchesSinceRestart = 0;
    console.log('  [browser restarted]');
  }

  let discovered = 0, added = 0, pages = 0, withUpc = 0, limitHit = false;
  const crawlLimit = opts.pcCrawlLimit || Infinity;

  // Discover the full Funko console set list from PriceCharting's nav, so the
  // crawl covers every category rather than a hardcoded subset.
  let consoles = await discoverFunkoConsoles(page);
  // Optional slug filter: restrict the crawl to specific consoles.
  if (opts.pcCrawlOnly && opts.pcCrawlOnly.length) {
    const missing = opts.pcCrawlOnly.filter(s => !consoles.includes(s));
    if (missing.length) console.log(`  Note: requested console slug(s) not in discovered list: ${missing.join(', ')}`);
    consoles = consoles.filter(s => opts.pcCrawlOnly.includes(s));
    console.log(`  Crawling only ${consoles.length} of the discovered sets: ${consoles.join(', ')}`);
  }
  const totalSets = consoles.length;   // runtime count — never hardcoded; grows
                                       // automatically if PriceCharting adds sets.

  // Per-set checkpoint: Pass 3b is long and (unlike Pass 4) used to hold all its
  // work in memory until the pass returned, so ANY interruption lost the entire
  // crawl. Now we save the output after each set AND record completed set slugs in
  // a sidecar progress file, so an interrupted run resumes mid-crawl (skipping
  // finished sets) instead of starting over. The file is cleared when the pass
  // completes fully.
  // Derive a distinct sidecar path. Always APPEND the suffix rather than
  // substituting ".json" — if opts.output had no .json extension, a substitution
  // would leave progressPath === output path and saveProgress would overwrite the
  // catalog with the slug list. Appending guarantees a separate file.
  const outResolved = path.resolve(opts.output);
  const progressPath = outResolved.replace(/\.json$/i, '') + '.pc3b_progress.json';
  let doneSets = new Set();
  try {
    if (fs.existsSync(progressPath)) {
      const saved = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
      if (Array.isArray(saved)) doneSets = new Set(saved);
      if (doneSets.size) console.log(`  Resuming Pass 3b — ${doneSets.size} sets already done, skipping them.`);
    }
  } catch (_) { /* corrupt progress file — start fresh */ }
  const saveProgress = () => {
    try {
      fs.writeFileSync(path.resolve(opts.output), JSON.stringify(enriched), 'utf8');
      fs.writeFileSync(progressPath, JSON.stringify([...doneSets]), 'utf8');
    } catch (e) { console.log(`  [warn] checkpoint save failed: ${e.message}`); }
  };

  try {
    outer:
    for (const [setIdx, slug] of consoles.entries()) {
      if (doneSets.has(slug)) { continue; }   // already crawled in a prior run
      const newBefore = discovered;    // to report new Pops found in THIS set
      console.log(`\n  [set ${setIdx + 1}/${totalSets}] ${slug}`);
      // Per-set restart: start each set on a fresh browser to release memory
      // accumulated by the previous set (skip when nothing has been fetched yet,
      // i.e. the very first set, since the browser is already fresh).
      if (fetchesSinceRestart > 0) { await restartBrowser(); }
      const url = `${PC_BASE}/console/${slug}`;
      let stubs = [];
      let setTarget = 0;       // PriceCharting's stated figure count for this set
      let setRowsLoaded = 0;   // rows we actually loaded
      let pageLoadFailed = false;
      try {
        // Load the listing page, with retry-on-empty. Some sets intermittently
        // come back blank (0 rows AND no "Prices for all N" target text) — the
        // page request returned but PriceCharting served an empty/blocked body
        // this session (observed on funko-pop-digital, -asia, -wwe-covers). A
        // blank load is NOT a real empty set, so restart the browser and re-fetch
        // up to 2 more times before accepting it. Sets that are genuinely tiny
        // still load their rows/target on the first try, so this only re-hits the
        // truly-blank ones.
        let loadAttempt = 0;
        while (true) {
          loadAttempt++;
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          const probe = await page.evaluate(() => {
            const t = document.querySelector('#games_table tbody');
            const rows = t ? t.querySelectorAll('tr').length : 0;
            const hasTarget = /for all\s+[\d,]+\s+Funko/i.test(document.body.innerText)
                           || /\/\s*[\d,]+\s+items/i.test(document.body.innerText);
            return { rows, hasTarget };
          });
          if (probe.rows > 0 || probe.hasTarget) break;   // real content present
          if (loadAttempt > 3) break;                     // gave it 3 tries; let the
                                                          // gate leave it for retry
          console.log(`    [empty load] ${slug} returned blank — restarting browser and retrying (attempt ${loadAttempt})`);
          await restartBrowser();
        }
        // PriceCharting console pages lazy-load their full figure list via JS as
        // you scroll — they do NOT use a "next" link or a working ?page= param
        // (verified: large sets show ~150 rows initially but have 500+ total, e.g.
        // funko-pop-rocks = 534). So scroll to the bottom repeatedly until the row
        // count stops growing, then parse the fully-loaded DOM once.
        // PriceCharting states the true set size on the page ("Prices for all N
        // Funko <set> Figures"). Read that target and scroll until the loaded row
        // count reaches it — deterministic completeness instead of guessing from
        // "row count stopped changing", which truncated big sets (Marvel showed
        // 1050 of its real 1870 because lazy-load paused and we accepted it).
        const targetCount = await page.evaluate(() => {
          const text = document.body.innerText;
          // Format A: "Prices for all 1870 Funko <set> Figures"
          let m = text.match(/for all\s+([\d,]+)\s+Funko/i);
          // Format B: "You own: 0 / 520 items"  (collection-tracker header)
          if (!m) m = text.match(/\/\s*([\d,]+)\s+items/i);
          return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
        });
        if (targetCount > 0) console.log(`    target: ${targetCount} figures`);
        setTarget = targetCount;

        // ── Row loading — deterministic scroll-to-target ─────────────────────
        // PriceCharting console pages append rows via a scroll-triggered AJAX
        // fetch (the js-next-page form is only the no-JS fallback; submitting it
        // directly causes a full-page POST navigation that destroys the page
        // context — do NOT call form.submit()). Scrolling is the correct trigger.
        // The previous loop's flaw was giving up after a fixed 12 stalls,
        // accepting a partial load as complete when the next AJAX batch was merely
        // slow/rate-limited — which produced 900-of-1681 on one run and 1681 on
        // the next for the very same page. Fix: keep scrolling as long as we are
        // still SHORT of target, with a generous no-progress budget, nudging the
        // scroll position (up a little, then back to bottom) to re-arm the
        // lazy-load trigger on a stall. Verified: loads 1681/1681 in a single pass.
        const rowCountNow = async () => page.evaluate(() => {
          const t = document.querySelector('#games_table tbody');
          return t ? t.querySelectorAll('tr').length : 0;
        });
        const nudgeScroll = async () => page.evaluate(() => {
          // jump up then back to bottom — re-fires the scroll listener that some
          // lazy-loaders debounce and skip on repeated bottom-hits.
          window.scrollTo(0, Math.max(0, document.body.scrollHeight - 1500));
          window.scrollTo(0, document.body.scrollHeight);
        });

        let rows = await rowCountNow();
        let best = rows;
        let noProgress = 0;
        const MAX_ITERS = 800;            // hard safety cap
        const NO_PROGRESS_LIMIT = 40;     // ~40 idle tries (≈30–40s) with zero new
                                          // rows AND still short of target = give up
        for (let it = 0; it < MAX_ITERS; it++) {
          if (targetCount > 0 && rows >= targetCount) break;   // reached target
          await nudgeScroll();
          await sleep(700);               // let the AJAX batch arrive
          rows = await rowCountNow();
          if (rows > best) { best = rows; noProgress = 0; }
          else {
            noProgress++;
            if (noProgress >= NO_PROGRESS_LIMIT) {
              // Truly stalled short of target after a long patient wait. Take what
              // loaded; the completeness gate below leaves the set UNMARKED so it
              // retries next run rather than being accepted as complete.
              if (targetCount > 0 && rows < targetCount - 5) {
                console.log(`    [warn] scroll stalled at ${rows} of ${targetCount} after ${noProgress} idle tries — set may be incomplete`);
              }
              break;
            }
            // escalating backoff on a stall — the loader may be rate-limiting
            await sleep(noProgress > 15 ? 1500 : 600);
          }
        }
        const html = await page.content();
        stubs = parsePriceChartingListing(html);
        setRowsLoaded = stubs.length;
      } catch (e) {
        console.log('  (page error)');
        pageLoadFailed = true;
        continue;
      }
      pages++;
      console.log(`  ${slug}: ${stubs.length} rows loaded`);
      {
        for (const s of stubs) {
          if (!s.id || haveThisPcId(s.id)) continue;
          for (const f of pcIdForms(s.id)) havePcId.add(f);
          discovered++;
          // Live progress: one product-page fetch per new Pop (~2.5s each).
          process.stdout.write(`\r    +${added + 1} new | ${withUpc} w/UPC | ${(s.name || '').slice(0, 40).padEnd(40)}`);

          // Just download and add. Deduplication against existing catalog records
          // (same Pop already present from HobbyDB/funko.com) is handled in
          // post-process by dedupeAndMerge, which has the fully-populated
          // funkoNumber field and cleaned titles to match on — far more reliable
          // than matching mid-crawl on raw scraped titles.
          const rec = {
            handle: `pc-${s.id}`,
            title: s.name,
            funkoSource: 'pricecharting',
            pricechartingId: String(s.id),
            pricechartingUrl: s.href,
          };
          // PriceCharting product photo (full-res). Previously nothing on the PC
          // path stored an image at all, which is why ~8.5k pc- records shipped
          // with a blank imageUrl and the app showed no picture for any of them.
          if (s.imageUrl) rec.imageUrl = s.imageUrl;
          if (s.loose)    rec.marketValueLoose    = s.loose;
          if (s.complete) rec.marketValueComplete = s.complete;
          if (s.mint)     rec.marketValueNew      = s.mint;

          // Mid-set restart: long sets (e.g. Animation ~2,920 records) would
          // otherwise run thousands of fetches on one browser instance. Restart
          // every BROWSER_RESTART_INTERVAL fetches to cap memory. Done before the
          // fetch so the new `page` is the one used below.
          if (fetchesSinceRestart >= BROWSER_RESTART_INTERVAL) { await restartBrowser(); }
          fetchesSinceRestart++;

          // Product-page visit for UPC + metadata. On failure keep the priced
          // listing-row record so a transient page error never loses the find.
          try {
            const detail = await scrapePriceChartingPrices(page, s.id, s.console, s.href);
            if (detail) {
              if (detail.meta) for (const [k, v] of Object.entries(detail.meta)) {
                if (v && (rec[k] === undefined || rec[k] === null || rec[k] === '')) rec[k] = v;
              }
              if (!rec.marketValueLoose    && detail.loose)    rec.marketValueLoose    = detail.loose;
              if (!rec.marketValueComplete && detail.complete) rec.marketValueComplete = detail.complete;
              if (!rec.marketValueNew      && detail.mint)     rec.marketValueNew      = detail.mint;
            }
            await sleep(PC_DELAY);
          } catch (e) { /* keep listing-row record as-is */ }

          enriched.push(rec);
          added++;
          if (rec.upc) withUpc++;
          if (added >= crawlLimit) { process.stdout.write('\n'); console.log('  [crawl limit reached]'); limitHit = true; break outer; }
        }
        process.stdout.write('\n');   // finish the live progress line for this set
      }
      const newThisSet = discovered - newBefore;

      // Completeness gate: only mark a set DONE (so it's skipped on resume) if it
      // actually loaded acceptably. A set that loaded 0 rows (transient empty page)
      // or stalled well short of PriceCharting's stated target is left UNMARKED so
      // the next run retries it, instead of being silently skipped forever.
      const reachedTarget = setTarget > 0 ? (setRowsLoaded >= setTarget - 5) : (setRowsLoaded > 0);
      const acceptable = !pageLoadFailed && setRowsLoaded > 0 && reachedTarget;

      if (acceptable) {
        console.log(`    set done — ${newThisSet} new from ${slug} (running total: ${discovered} discovered, ${added} added)`);
        doneSets.add(slug);
        saveProgress();   // checkpoint after every set so an interrupt loses ≤1 set
      } else {
        const why = pageLoadFailed ? 'page error'
                  : setRowsLoaded === 0 ? 'loaded 0 rows'
                  : `loaded ${setRowsLoaded} of ${setTarget}`;
        console.log(`    set NOT marked done (${why}) — ${newThisSet} new; will retry next run`);
        // Still persist the records we DID get, just don't mark the set complete.
        saveProgress();
      }
    }
    // Pass completed fully — clear the progress sidecar so the next run does a
    // fresh crawl (picking up any newly-listed Pops) rather than skipping all sets.
    // Skip the clear if we exited early on a crawl limit: progress is incomplete
    // and a resume should continue, not restart.
    if (!limitHit) {
      try { if (fs.existsSync(progressPath)) fs.unlinkSync(progressPath); } catch (_) {}
    }
  } finally {
    try { await browser.close(); } catch (_) {}
  }

  console.log(`  Pages crawled: ${pages} | New Pops added: ${added} | With UPC (scannable): ${withUpc}`);
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

  // Candidates: records with a handle that are still MISSING something HobbyDB
  // supplies (upc, funkoNumber, or series). A record that already has all three
  // gains nothing from a HobbyDB visit, so we skip it — on an already-enriched
  // catalog this avoids re-fetching the ~88% of records that are already
  // complete (the difference between a ~1h and an ~8h run). The retry flags
  // (hdbAll / retryNoRefs / retryNoSeries) override this and force a visit.
  // (skip funko.com-only records — they have no HobbyDB page)
  const hdbComplete = (rec) =>
    !!(String(rec.upc || '').trim()) &&
    !!(String(rec.funkoNumber || '').trim()) &&
    !!(Array.isArray(rec.series) ? rec.series.length : String(rec.series || '').trim());
  const candidates = enriched
    .map((rec, i) => ({ rec, i }))
    .filter(({ rec }) => {
      if (!rec.handle || rec.handle.endsWith('.html')) return false; // funko.com record
      if (opts.hdbAll) return true;
      if (opts.retryNoRefs)   return rec.hdbChecked && !rec.hdbid; // only retry no-refs
      if (opts.retryNoSeries) return rec.hdbChecked && (!rec.series || rec.series.length === 0); // only retry missing series
      if (rec.hdbid || rec.hdbChecked) return false;  // already fetched
      return !hdbComplete(rec);   // skip if it already has upc + funkoNumber + series
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
        .replace(/["!]/g, '')       // literal quotes/bangs (e.g. "The Demon"..., Wooooo!) — no HDB slug equivalent
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
        // HobbyDB is an Angular SPA: 'domcontentloaded' fires on the empty ~1.4KB
        // shell, BEFORE the app fetches item data — reading page.content() then
        // yields a shell with no refs (the cause of the false "no refs found").
        // Wait for network to settle so the app has actually rendered the item.
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 })
          .catch(() => {}); // networkidle can throw on slow pages; the wait below re-checks

        // Confirm the item actually rendered (page grew well past the shell and a
        // reference container exists). Retry once for slow renders.
        const rendered = () => page.waitForFunction(
          () => document.body &&
                document.body.innerHTML.length > 5000 &&
                (/Reference\s*#|UPC|HDBID/i.test(document.body.innerText) ||
                 !!document.querySelector('.spaced-field, .col-md-6 .ng-binding')),
          { timeout: 15000 }
        ).then(() => true).catch(() => false);

        let ok = await rendered();
        if (!ok) ok = await rendered();

        const grab = async () => {
          const html = await page.content();
          return { html, refs: parseHobbyDbRefs(html), series: parseHobbyDbSeries(html) };
        };

        let { html, refs, series } = await grab();

        if (!refs && !series) {
          // Parsed twice, static fallbacks included, still nothing. This record
          // genuinely has no HobbyDB reference data (or no page). Mark checked so
          // we don't re-fetch it every run.
          console.log('no refs found');
          enriched[idx].hdbChecked = true;
          notFound++;
        } else {
          // Merge into record
          const r = enriched[idx];
          if (refs) {
            if (refs.hdbid       && !r.hdbid)       r.hdbid       = refs.hdbid;
            if (refs.upc         && !r.upc && upcaChecksumOk(refs.upc))
                                                    r.upc         = refs.upc;
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

      // Checkpoint every 100 records (was 10). Each write serialises the whole
      // ~25k-record array (~8.5 MB), so writing every 10 over ~19k records meant
      // ~1,900 full writes (~16 GB cumulative I/O + heavy stringify). Every 100
      // cuts that ~10x; on crash we lose at most ~100 records, which resume just
      // re-fetches. Unindented JSON (no `null, 2`) roughly halves the bytes — the
      // app re-parses anyway, so indentation buys nothing at runtime.
      if ((i + 1) % 100 === 0) {
        fs.writeFileSync(path.resolve(opts.output), JSON.stringify(enriched), 'utf8');
      }
    }
  } finally {
    await browser.close();
    // Final save to capture the last partial batch
    fs.writeFileSync(path.resolve(opts.output), JSON.stringify(enriched), 'utf8');
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
      !rec.franchiseChecked &&
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

      // Checkpoint every 100 iterations (top of loop, before any continue/throw)
      // so an interruption during this ~35-min pass persists the franchise data
      // and franchiseChecked markers — otherwise a restart re-scrapes all ~2,000.
      if (i > 0 && i % 100 === 0) {
        try { fs.writeFileSync(path.resolve(opts.output), JSON.stringify(enriched), 'utf8'); }
        catch (e) { console.log(`  [warn] checkpoint save failed: ${e.message}`); }
      }

      try {
        // JSON-LD is in static HTML — domcontentloaded is sufficient and much faster
        await page.goto(rec.productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const html  = await page.content();
        const crumbs = extractBreadcrumb(html);

        // Mark as checked regardless of outcome so a resumed run does not
        // re-scrape this record. Success sets franchise too; failures just carry
        // the marker so they aren't retried every run.
        enriched[idx].franchiseChecked = true;

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
        // NOTE: do NOT mark franchiseChecked on a thrown error (network/timeout) —
        // these are transient and SHOULD be retried on the next run. Only the
        // clean "no breadcrumb"/"no franchise" outcomes above are marked.
      }

      await sleep(opts.funkoDetailDelay);
    }
  } finally {
    await browser.close();
    // Final save to persist the last partial batch of franchise enrichments.
    try { fs.writeFileSync(path.resolve(opts.output), JSON.stringify(enriched), 'utf8'); }
    catch (e) { console.log(`  [warn] final save failed: ${e.message}`); }
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
  const DEDUP_LOG = [];   // [DIAG] every removal recorded with reason + survivor
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
    if (rec.funkoSource === 'pricecharting') return; // handled separately below
    const normTitle = normaliseTitle(rec.title);
    const hobbyIdx = hobbyIndex.get(normTitle);
    if (hobbyIdx === undefined) { kept++; return; }

    // Found a title match — check it's actually a Pop! not a Mystery Mini etc.
    const hobbyRec = enriched[hobbyIdx];
    // Coerce series to an array before calling array methods on it. A base-catalog
    // record carries `series` as a STRING ("Pop! Games"); the enricher's working
    // shape carries an ARRAY. `|| []` only guards null/undefined — a string slips
    // through, has a non-zero .length, skips the empty-branch, and then .some()
    // throws "series.some is not a function". isNonPop() at ~L2514 already coerces
    // the same way; this site was missed. (String -> [String], null -> [].)
    const series = Array.isArray(hobbyRec.series) ? hobbyRec.series
                 : hobbyRec.series ? [hobbyRec.series] : [];
    const isPop = series.length === 0 ||
                  series.some(s => /^pop!/i.test(String(s)) || /^funko pop/i.test(String(s)));
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

    if (typeof DEDUP_LOG !== 'undefined') DEDUP_LOG.push({rule:'funko_hobby', removed:rec.title, removedId:rec._id, removedPcId:rec.pricechartingId||'', into:hobbyRec.title, intoId:hobbyRec._id});
    toRemove.add(i);
    merged++;
  });

  // ── PriceCharting dedup ─────────────────────────────────────────────────────
  // Pass 3b adds PriceCharting records as new (it can't match mid-crawl because
  // PriceCharting titles look very different — "Shaak Ti #853" vs catalog
  // "Shaak Ti"). Here, with funkoNumber populated and titles cleaned, match each
  // PriceCharting record to an existing canonical record by funkoNumber +
  // CORE NAME (title stripped of #number, [brackets], (variant parens) and
  // accessory suffixes). On match, merge PriceCharting data in (fill-only) and
  // drop the duplicate. This is strictly safe: it only merges when the cleaned
  // names agree, so distinct variants are never collapsed.
  const pcDecode = s => (s || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  const coreName = t => pcDecode(t).toLowerCase()
    .replace(/#\s*\d+[a-z]?/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(bottle opener|box|pop! protector)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const coreNoParens = t => coreName(String(t || '').replace(/\([^)]*\)/g, ' '));
  const numOf = r => {
    // Check all three sources: the verified funkoNumber field, the
    // funkoNumberFromTitle field that extractNumbersFromTitles populates (it
    // STRIPS "#nnn" from the title into this field, so by the time dedup runs the
    // title no longer carries it), and finally any "#nnn" still in the title.
    if (r.funkoNumber !== undefined && r.funkoNumber !== null && r.funkoNumber !== '')
      return String(r.funkoNumber).replace(/^0+/, '') || '0';
    if (r.funkoNumberFromTitle !== undefined && r.funkoNumberFromTitle !== null && r.funkoNumberFromTitle !== '')
      return String(r.funkoNumberFromTitle).replace(/^0+/, '') || '0';
    const m = /#\s*(\d+)/.exec(r.title || '');
    return m ? String(parseInt(m[1], 10)) : '';
  };
  const shareAllShortTokens = (a, b) => {
    const ta = a.split(' ').filter(Boolean), tb = b.split(' ').filter(Boolean);
    if (!ta.length || !tb.length) return false;
    const [short, longSet] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
    if (short.length < 2) return false;
    return short.every(t => longSet.has(t));
  };

  // Index canonical (non-PriceCharting, not-yet-removed) records by funkoNumber.
  const canonicalByNum = new Map();
  enriched.forEach((r, i) => {
    if (r.funkoSource === 'pricecharting' || toRemove.has(i)) return;
    // Signed/certified editions are never a merge TARGET. coreNoParens() strips
    // parentheticals, so "Kurogiri (Toyzilla Signed Edition)" and base "Kurogiri"
    // both reduce to "kurogiri" and share #789 — a PriceCharting crawl row for
    // the base would merge into whichever landed in this bucket first (array
    // order, not logic) and refill the base pricing S23 deliberately blanked.
    // Keeping them out of the index means a base row can only match the base.
    if (PC_SKIP_IDS.has(r._id)) return;
    const n = numOf(r);
    if (n) { if (!canonicalByNum.has(n)) canonicalByNum.set(n, []); canonicalByNum.get(n).push(i); }
  });

  let pcMerged = 0, pcKept = 0;
  enriched.forEach((rec, i) => {
    if (rec.funkoSource !== 'pricecharting' || toRemove.has(i)) return;
    // Never remove a skip-listed record as a merge SOURCE. The index guard above
    // keeps these out of canonicalByNum (so they are not merge TARGETS), but this
    // second loop can still fold a pricecharting-source record into a twin and drop
    // it. Six owned Pop! Disney figures (Mia/Merida/Anna/Rapunzel/Maleficent/Mr.Toad)
    // were removed exactly this way in S23, orphaning the user's collection. Skip so
    // they survive every future run.
    if (PC_SKIP_IDS.has(rec._id)) { pcKept++; return; }
    const n = numOf(rec);
    const core = coreName(rec.title), coreNP = coreNoParens(rec.title);
    let matchIdx = -1, matchReason = '';
    if (n && canonicalByNum.has(n)) {
      for (const ci of canonicalByNum.get(n)) {
        if (toRemove.has(ci)) continue;
        const c = coreName(enriched[ci].title), cnp = coreNoParens(enriched[ci].title);
        // Require BOTH the funkoNumber (already matched by the byNum bucket) AND
        // a name agreement: exact core-name match, paren-stripped match, or — only
        // as a fallback — full short-token containment. Number-alone is NOT enough
        // (two different Pops can share a number across lines), which prevents a
        // wrong merge that would silently drop the PriceCharting record's data.
        if (c === core || cnp === coreNP || c === coreNP || cnp === core ||
            shareAllShortTokens(core, c)) {
          matchIdx = ci;
          // [DIAG] record WHICH clause matched, to separate safe exact matches
          // from the loose short-token containment fallback.
          if (c === core) matchReason = 'exact_core';
          else if (cnp === coreNP || c === coreNP || cnp === core) matchReason = 'paren_stripped';
          else matchReason = 'shareTokens_FALLBACK';
          break;
        }
      }
    }
    if (matchIdx === -1) { pcKept++; return; }  // genuinely new PriceCharting Pop

    const tgt = enriched[matchIdx];
    // Copy every PriceCharting-derived field the scraper can populate. The earlier
    // list omitted several (pcSeries — needed for franchiseSuggestion — plus
    // amazonAsin/printRun/publisher/pcDescription) and used the wrong name 'epid'
    // for what the scraper stores as 'ebayEpid', so those were silently dropped on
    // merge. Fill-only: never overwrite a non-empty value already on the canonical.
    for (const f of ['pricechartingId','pricechartingUrl','marketValueLoose',
                     'marketValueComplete','marketValueNew','upc','releaseDate',
                     'ebayEpid','amazonAsin','printRun','publisher','pcDescription',
                     'pcSeries','funkoNumber',
                     // Primary product image. Fill-only, like everything else in
                     // this list: a record that already has an imageUrl (HobbyDB
                     // or funko.com) keeps it; one with none gets PriceCharting's.
                     'imageUrl',
                     // Done-markers: carry these onto the survivor so a later run
                     // doesn't re-scrape a record just because dedup collapsed the
                     // copy that held the marker. Efficiency only — never affects
                     // correctness, only avoids redundant network work.
                     'hdbChecked','franchiseChecked','hdbid','priceCheckedAt']) {
      if (rec[f] && (tgt[f] === undefined || tgt[f] === null || tgt[f] === '')) tgt[f] = rec[f];
    }
    if (typeof DEDUP_LOG !== 'undefined') DEDUP_LOG.push({rule:matchReason, removed:rec.title, removedId:rec._id, removedPcId:rec.pricechartingId||'', removedUpc:rec.upc||'', into:tgt.title, intoId:tgt._id, intoPcId:tgt.pricechartingId||''});
    toRemove.add(i);
    pcMerged++;
  });

  // Rebuild array without removed indices
  const deduped = enriched.filter((_, i) => !toRemove.has(i));
  console.log(`  Merged into HobbyDB records: ${merged}`);
  console.log(`  funko.com-only new records:  ${kept}`);
  console.log(`  PriceCharting merged into existing: ${pcMerged}`);
  console.log(`  PriceCharting-only new records:     ${pcKept}`);
  console.log(`  Records removed (dupes):     ${toRemove.size}`);
  // [DIAG] dump every removal + a reason breakdown
  try {
    const by = {};
    for (const e of DEDUP_LOG) by[e.rule] = (by[e.rule]||0)+1;
    console.log('  [DEDUP-DIAG] removals by reason:', JSON.stringify(by));
    require('fs').writeFileSync('dedup_removals.json', JSON.stringify(DEDUP_LOG, null, 2), 'utf8');
    console.log(`  [DEDUP-DIAG] wrote ${DEDUP_LOG.length} removals to dedup_removals.json`);
  } catch (e) { console.log('  [DEDUP-DIAG] log write failed:', e.message); }
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

// Title words that mark a record as non-Pop merch. NOTE: bare apparel/container
// words (hat, cap, mug, cup, bag, jacket, dress) are deliberately NOT here — a
// Pop can be "wearing a Fruit Hat" or "with Cup", so those words in a title don't
// make it merch. Real apparel/glassware is caught by NON_POP_IMAGE_CATEGORY
// instead (the HobbyDB product category is reliable where the title isn't).
// Likewise "monopoly" is omitted — "Mr. Monopoly" is a real Ad Icons Pop.
const NON_POP_TITLE_WORDS = /\b(backpack|crossbody|lanyard|keychain|soda|mystery minis|wacky wobbler|funkoverse|bitty pop|pocket pop|pin set|enamel pin|zip around|cardigan|hoodie|legging|beanie|cushion|plush|peluche|dorbz|vynl|hikari|rock candy|fabrikations|paka paka|spastik plastik|pint glass|shot glass|insulated glass|toothpick|thermos|tumbler|hacky sack|stress ball|ping pong|card game|cookie cutter|cookie jar|pop protector|popshield|snapback|luggage tag|salt and pepper|tote bag|magnets?|fidget spinner|fidget|funko'?s|funkos|cereal|notebook|journal|sticker|decal|coaster|playing cards?|puzzle|board game|dice|ornament|earbuds|headphones|phone case|air freshener|freshener|water bottle|bottle opener|figural bank|coin bank|mousepad|mouse pad|snow globe|water globe|lunchbox|lunch box)\b|^i'm a fan of /i;
// Product-form merch: these words also name things a Pop can WEAR ("with
// Sunglasses", "No Apron"), so only treat them as merch when the item is the
// product itself — i.e. the word ends the title or follows a franchise/brand
// name, NOT when it's a parenthetical descriptor. Guards against re-flagging
// Pops like "Gremlin (with Sunglasses)" or "The Neighbor (with Apron)".
const NON_POP_TITLE_PRODUCT = /(?<![(,]\s?(?:with |no |in )?)\b(scarf|apron|sunglasses|3d glasses|necktie|slippers|gloves|towel|blanket|pillow)\b\s*$/i;
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

// HobbyDB files each catalog photo under a product-CATEGORY token embedded in the
// image URL (e.g. ".../White_Bone_Demon_Vinyl_Art_Toys_<hash>.jpg" for a Pop, but
// ".../Chewbacca_Pint_Glass_Glasses_and_Barware_<hash>.jpg" for merch). When the
// series tags are missing/wrong (as they are on ~565 legacy records), this image
// category is the only reliable non-Pop signal. These tokens are unambiguous
// merch categories — a real Pop is filed under Vinyl_Art_Toys / Action_Figures,
// never these.
// Hard-merch categories only — a real Pop is never filed under these, so with the
// no-PriceCharting-id guard below it is safe to auto-drop on this signal. Soft
// categories that CAN contain real Pops mis-filed (Whatever_Else, Books,
// Comics_and_Graphic_Novels, Christmas_and_Holiday_Ornaments) are deliberately
// NOT here — those need review, not silent removal.
const NON_POP_IMAGE_CATEGORY = /_(Pins_and_Badges|Shirts_and_Jackets|Glasses_and_Barware|Hats|Bags|Wallets|Lanyards|Luggage_Tags|Display_Cases|Hoodies|Socks|Keychains)_[0-9a-f]{6,}/i;

function isNonPop(rec) {
  // funko.com records already filtered — only check HobbyDB originals
  if (rec.funkoSource) return false;

  // STRONG POP EVIDENCE overrides a bad title — but ONLY when the HobbyDB image
  // category says "figure". HobbyDB sometimes mis-titles a real Pop (e.g.
  // "Castiel FunkO's" is a genuine Pop! Television Supernatural #95, filed under
  // Vinyl_Art_Toys). Series+number is NOT sufficient evidence: FunkO's cereal
  // boxes legitimately carry a Pop! Disney series tag and the box number of the
  // Pocket Pop inside them, and those are filed under Whatever_Else. The image
  // category is the only signal that separates the two.
  {
    const figureImg = /_(Vinyl_Art_Toys|Action_Figures)_[0-9a-f]{6,}/i.test(rec.imageUrl || '');
    const realNum = !['', '__unresolved__'].includes(String(rec.funkoNumber || '').trim());
    const sRaw = Array.isArray(rec.series) ? rec.series : (rec.series ? [rec.series] : []);
    const sLc = sRaw.map(s => String(s).toLowerCase());
    // NON_POP_SERIES tags (dorbz/vynl/mystery minis/...) still win — those are
    // real product lines that are genuinely not Pops, however they're filed.
    const merchSeries = NON_POP_SERIES.some(tag => sLc.some(s => s.includes(tag)));
    if (figureImg && realNum && !merchSeries) return false;
  }


  // Title keyword check
  if (NON_POP_TITLE_WORDS.test(rec.title || '')) return true;
  // Product-form apparel (trailing, not a "(with X)" descriptor)
  if (NON_POP_TITLE_PRODUCT.test(rec.title || '')) return true;

  // Series tag check
  const seriesRaw = Array.isArray(rec.series) ? rec.series : (rec.series ? [rec.series] : []);
  const series = seriesRaw.map(s => String(s).toLowerCase());
  if (NON_POP_SERIES.some(tag => series.some(s => s.includes(tag)))) return true;

  // Image-category check — catches merch whose series tags are missing/wrong (the
  // legacy contamination the series check alone misses). Guarded by "no PriceCharting
  // id": a record PC lists as a Pop is a real figure whose HobbyDB image merely
  // happened to be filed oddly, so we DON'T drop it on image category alone.
  if (NON_POP_IMAGE_CATEGORY.test(rec.imageUrl || '') &&
      !String(rec.pricechartingId || '').trim()) {
    return true;
  }

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

  // Product-type boilerplate that scraped sources (HobbyDB, funko.com product
  // pages) wrap around the character name:
  //   "Funko Pop! Vinyl Figure Easter Angel"      -> "Easter Angel"
  //   "Disney Mickey ... Funko Pop Vinyl Figure"  -> "Disney Mickey ..."
  //   "Red One Nick Funko Pop Vinyl Figure #123"  -> "Red One Nick"
  // Matches only the FULL "...Vinyl Figure[s]" phrase, so the "Freddy Funko"
  // mascot, "Funko HQ", "FunkO's", and a bare "Pop! Vinyl" series suffix are
  // never touched. Trailing form also eats a dangling "#" or "#<number>".
  const BOILER = "(?:funko\\s+)?pop!?\\s+vinyl\\s+figures?";
  s = s.replace(new RegExp("[\\s,:\\-]*" + BOILER + "\\s*#?\\s*\\d*\\s*$", "i"), ""); // trailing
  s = s.replace(new RegExp("^\\s*" + BOILER + "[\\s:,\\-]*", "i"), "");               // leading

  // Leading bare "Funko Pop!" / "Pop!" — but NOT when the next word is a real
  // Pop sub-line (Rides, Deluxe, Town, ...), which is part of the identity.
  s = s.replace(/^(?:Funko\s+)?Pop!?\s+(?!Rides|Deluxe|Town|Vinyl|Moment|Album|Movie|Keychain|Pez|Die|Trains|Minis|Comic)(?=\S)/i, '');

  s = s.replace(/\s*\(Bobble-?Head\)\s*$/i, '');         // trailing (Bobble-Head)
  s = s.replace(/\s{2,}/g, ' ').replace(/\s+#\s*$/, '').trim();
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

// ═══════════════════════════════════════════════════════════════════════════════
// UPC COLLISION SCRUB (post-pass)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Remove UPCs that were wrongly stapled onto the wrong figure upstream (mostly
 * the Kenny Chan source, which attaches one barcode to every record sharing a
 * box number regardless of character). Finish-variants of ONE figure (plain /
 * flocked / GITD) legitimately share a UPC AND a box number — those are left
 * untouched. The tell for a bad link is a UPC group whose records carry
 * DIFFERENT numeric box numbers: a shared barcode across different box numbers
 * is not a variant family, it's a mis-staple.
 *
 * Within each mixed-box group we keep the records on the WINNING box number and
 * blank the UPC on the rest (Option A — surgical, not blank-everything):
 *   - winner = an owned (type=funko) record's box number if one is in the group
 *     (owned records are ground truth and are NEVER blanked), else
 *   - winner = the plurality box number, else
 *   - on a tie with no owned anchor, blank all catalog UPCs in the group (strict).
 * Blanked records also lose pricechartingUrl/pricechartingId so re-enrichment
 * rebuilds the link cleanly by exact name+number.
 *
 * Dry-run by default: writes a changelog and mutates nothing unless apply=true.
 * Returns { blanked, groupsHit, ownedAnchored, tieStrict, changelog }.
 */
function scrubUpcCollisions(enriched, { apply = false } = {}) {
  console.log('\n── Post-process: UPC collision scrub ─────────────────────────');
  console.log(`  mode: ${apply ? 'APPLY (blanking UPCs)' : 'DRY-RUN (report only, no writes)'}`);

  const boxNumOf = rec => {
    const n = rec.funkoNumber;
    if (n === undefined || n === null) return '';
    const s = String(n).replace(/[^0-9]/g, '');
    return s.replace(/^0+/, '') || (s ? '0' : '');
  };

  // Group catalog + owned records by normalized UPC.
  const groups = new Map();
  for (let i = 0; i < enriched.length; i++) {
    const r = enriched[i];
    if (r.type !== 'catalog' && r.type !== 'funko') continue;
    const u = normalizeUpc(r.upc);
    if (!u) continue;
    if (!groups.has(u)) groups.set(u, []);
    groups.get(u).push(i);
  }

  const changelog = [];
  let blanked = 0, groupsHit = 0, ownedAnchored = 0, tieStrict = 0;

  for (const [upc, idxs] of groups) {
    if (idxs.length < 2) continue;
    const boxList = idxs.map(i => boxNumOf(enriched[i])).filter(Boolean);
    if (new Set(boxList).size <= 1) continue;   // consistent box# -> legit variant family

    groupsHit++;
    const ownedBoxes = idxs
      .filter(i => enriched[i].type === 'funko')
      .map(i => boxNumOf(enriched[i]))
      .filter(Boolean);

    let winners = null, mode = '';
    if (ownedBoxes.length) {
      winners = new Set(ownedBoxes); mode = 'owned-anchor'; ownedAnchored++;
    } else {
      const cnt = {};
      boxList.forEach(b => { cnt[b] = (cnt[b] || 0) + 1; });
      const max = Math.max(...Object.values(cnt));
      const tops = Object.keys(cnt).filter(b => cnt[b] === max);
      if (tops.length === 1) { winners = new Set(tops); mode = 'plurality'; }
      else { winners = null; mode = 'tie-strict'; tieStrict++; }
    }

    for (const i of idxs) {
      const r = enriched[i];
      if (r.type === 'funko') continue;          // never blank ground-truth owned records
      const b = boxNumOf(r);
      const doBlank = winners ? !(b && winners.has(b)) : true;
      if (!doBlank) continue;
      changelog.push({
        upc,
        blankedBox: b || '(none)',
        keptBox: winners ? [...winners].join(',') : 'ALL(tie)',
        mode,
        title: r.title,
        source: r.source || '-',
        id: r._id,
      });
      if (apply) {
        r.upc = '';
        if ('pricechartingUrl' in r) r.pricechartingUrl = '';
        if ('pricechartingId'  in r) r.pricechartingId  = '';
      }
      blanked++;
    }
  }

  console.log(`  Mixed-box UPC groups found:    ${groupsHit}`);
  console.log(`    owned-anchored:              ${ownedAnchored}`);
  console.log(`    tie -> strict:               ${tieStrict}`);
  console.log(`  Catalog UPCs ${apply ? 'blanked' : 'to blank'}:        ${blanked}`);
  return { blanked, groupsHit, ownedAnchored, tieStrict, changelog };
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
  // Coerce to array: callers pass rec.series, which is a STRING in base-catalog
  // shape and an ARRAY in working shape. `|| []` does not catch a string, so
  // `.filter` throws "filter is not a function". Same fix as isNonPop()/L2521.
  const arr = Array.isArray(series) ? series : (series ? [series] : []);
  const cands = arr.filter(isNamedSetTag);
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
// BASE CATALOG SHAPE  (unify enricher output with the app's catalog document)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The enricher works in its own shape: series is an ARRAY, records are handle-
// keyed with no _id/type, and several working-only fields (funkoNumberFromTitle,
// raw price, imageName, funkoSource) exist as scaffolding. The base catalog the
// app ships and reads is a different shape: _id "catalog::{handle}", type
// "catalog", series flattened to a single string, plus derived fields
// (isExclusive/isChase/exclusiveRetailer/seriesNumber/category) and the
// scaffolding dropped.
//
// Historically that translation happened later, in the Android CatalogImporter /
// build_base_catalog.py. Doing it HERE means `node enrich.js --base-shape` emits
// a file that IS a base catalog: no downstream reshape, and the derivations run
// once, at scrape time (richer signal), instead of being recomputed from strings
// at import. The derivation logic below is ported verbatim from
// CatalogMapper.deriveSeriesFields so behaviour matches the app exactly.

// Ported from CatalogMapper.EXCLUSIVE_KEYWORDS
const EXCLUSIVE_KEYWORDS = [
  'exclusive', 'funko-shop', 'sdcc', 'nycc', 'eccc', 'c2e2',
  'target', 'gamestop', 'walmart', 'amazon', 'hot topic',
  'box lunch', 'boxlunch', 'entertainment earth', 'walgreens',
  'fye', 'best buy', 'barnes', 'bam', 'primark', 'fanatics',
];

// Ported from CatalogMapper.RETAILER_MAP (insertion order preserved — the first
// keyword that appears in a tag wins, exactly as the Kotlin for-loop does).
const RETAILER_MAP = [
  ['target', 'Target'], ['gamestop', 'GameStop'], ['walmart', 'Walmart'],
  ['amazon', 'Amazon'], ['hot topic', 'Hot Topic'], ['box lunch', 'BoxLunch'],
  ['boxlunch', 'BoxLunch'], ['entertainment earth', 'Entertainment Earth'],
  ['walgreens', 'Walgreens'], ['fye', 'FYE'], ['best buy', 'Best Buy'],
  ['barnes', 'Barnes & Noble'], ['funko-shop', 'Funko Shop'], ['sdcc', 'SDCC'],
  ['nycc', 'NYCC'], ['eccc', 'ECCC'], ['c2e2', 'C2E2'], ['bam', 'Books-A-Million'],
  ['primark', 'Primark'], ['fanatics', 'Fanatics'],
];

const NUMBER_REGEX_BASE = /#\d+/;

function isExclusiveSeries(s) {
  const lc = String(s || '').toLowerCase();
  return EXCLUSIVE_KEYWORDS.some(k => lc.includes(k));
}

function extractRetailer(seriesList) {
  for (const tag of seriesList) {
    const lower = String(tag || '').toLowerCase();
    for (const [key, name] of RETAILER_MAP) {
      if (lower.includes(key)) return name;
    }
  }
  return 'Exclusive';
}

// Ported verbatim from CatalogMapper.deriveSeriesFields.
function deriveSeriesFields(seriesList, title) {
  const list = Array.isArray(seriesList) ? seriesList : (seriesList ? [seriesList] : []);

  const primarySeries = list.find(s =>
    !/^pop!/i.test(s) &&
    s.toLowerCase() !== 'pop! vinyl' &&
    !isExclusiveSeries(s) &&
    s.toLowerCase() !== 'chase pieces'
  ) || list[0] || '';

  const category = list.find(s =>
    /^pop!/i.test(s) &&
    s.toLowerCase() !== 'pop! vinyl' &&
    s.toLowerCase() !== 'pop!'
  ) || '';

  const isExclusive       = list.some(isExclusiveSeries);
  const exclusiveRetailer = isExclusive ? extractRetailer(list) : '';
  const isChase           = list.some(s => s.toLowerCase() === 'chase pieces');
  const numMatch          = NUMBER_REGEX_BASE.exec(title || '');
  const seriesNumber      = numMatch ? numMatch[0] : '';

  return { primarySeries, category, isExclusive, exclusiveRetailer, isChase, seriesNumber };
}

// Working-only fields the base catalog never carries — dropped on output.
const BASE_DROP_FIELDS = new Set([
  'funkoNumberFromTitle', 'price', 'imageName', 'funkoSource',
  'kennySource', 'hdbChecked', 'priceCheckedAt', 'popsOnly',
]);

/**
 * Reshape the enriched record set into the base catalog document shape, in
 * place. Idempotent: a record already in base shape (string series, has _id) is
 * left materially unchanged. Returns the count reshaped.
 */
function toBaseCatalogShape(enriched, opts = {}) {
  console.log('\n── Output: base catalog shape ────────────────────────────────');
  const source = opts.catalogSource || 'ENRICHED';
  const today  = new Date().toISOString().slice(0, 10);
  let n = 0;

  for (let i = 0; i < enriched.length; i++) {
    const r = enriched[i];
    const handle = (r.handle || '').trim();
    if (!handle) continue;   // a record with no handle can't be a catalog doc

    const seriesArr = Array.isArray(r.series) ? r.series
                    : (typeof r.series === 'string' && r.series ? [r.series] : []);
    const d = deriveSeriesFields(seriesArr, r.title || '');

    // Build the base document. Keep every enriched field the base carries, add
    // the identity + derived fields, flatten series, drop scaffolding.
    const out = { ...r };
    for (const f of BASE_DROP_FIELDS) delete out[f];

    out._id               = r._id && String(r._id).startsWith('catalog::')
                              ? r._id : `catalog::${handle}`;
    out.type              = 'catalog';
    out.handle            = handle;
    out.series            = d.primarySeries;          // ARRAY → STRING
    out.category          = (r.category && String(r.category).trim()) || d.category;
    // Derive identity flags only when the record doesn't already carry a real
    // value (never clobber a value an upstream source set deliberately).
    out.isExclusive       = typeof r.isExclusive === 'boolean' ? r.isExclusive : d.isExclusive;
    out.exclusiveRetailer = r.exclusiveRetailer || (out.isExclusive ? d.exclusiveRetailer : '');
    out.isChase           = typeof r.isChase === 'boolean' ? r.isChase : d.isChase;
    out.seriesNumber      = (r.seriesNumber && String(r.seriesNumber).trim()) || d.seriesNumber;
    out.isVaulted         = typeof r.isVaulted === 'boolean' ? r.isVaulted : false;
    out.retailPrice       = typeof r.retailPrice === 'number' ? r.retailPrice
                              : (parseFloat(String(r.price || '').replace(/[^0-9.]/g, '')) || 0);
    out.source            = r.source || source;
    out.lastUpdated       = r.lastUpdated || today;

    enriched[i] = out;
    n++;
  }
  console.log(`  Records reshaped to base catalog format: ${n}`);
  return n;
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
  // through the backlog (and re-runs converge on full coverage). Pass 2/3b only
  // ADD records and dedupe, so resuming never loses anything.
  let inputPath = path.resolve(opts.input);
  if (!opts.inputExplicit) {
    const outPath = path.resolve(opts.output);
    if (fs.existsSync(outPath)) {
      try {
        const outData = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        if (!Array.isArray(outData)) {
          console.log(`  (prior output is not a JSON array — building from base.)`);
        } else {
          // Resume only if the prior output actually carries ENRICHMENT — i.e. some
          // records have been HobbyDB-checked or priced or PriceCharting-discovered.
          // NOTE: do NOT compare output length to base length. The output is
          // intentionally SMALLER than the base (~16k vs base ~24k) because
          // post-process removes non-Pops and merges duplicates; a size test would
          // wrongly reject a perfectly good enriched file and restart from scratch.
          const enrichedCount = outData.reduce((n, r) =>
            n + ((r && (r.hdbChecked || r.marketValueComplete || r.marketValueLoose ||
                  r.pricechartingId || r.upc)) ? 1 : 0), 0);
          if (outData.length > 0 && enrichedCount > 0) {
            console.log(`Resuming from prior output (${outData.length} records, ${enrichedCount} already enriched) to advance the backlog.`);
            console.log(`  (pass --input ${opts.input} explicitly to force a fresh build from base.)`);
            inputPath = outPath;
          } else {
            // A valid-but-tiny/empty output here is suspicious if it exists at all
            // — most likely a truncated checkpoint. Warn rather than silently
            // discarding what might have been real progress.
            console.log(`Prior output has no enrichment markers (${outData.length} records) — building from base.`);
            if (outData.length > 0) {
              console.log(`  [warn] output exists but looks unenriched/partial; if this is`);
              console.log(`  unexpected, check for a *.pre-dedupe.* backup before continuing.`);
            }
          }
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
  let existingData;
  try {
    existingData = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (e) {
    console.error(`\nFailed to parse ${path.basename(inputPath)}: ${e.message}`);
    console.error(`The file is likely corrupted or truncated (e.g. a checkpoint`);
    console.error(`write was interrupted). Options:`);
    console.error(`  • restore from a *.pre-dedupe.* or prior backup if present, or`);
    console.error(`  • run with --input funko_data.json to rebuild from the base.`);
    process.exit(1);
  }
  if (!Array.isArray(existingData)) {
    console.error(`\n${path.basename(inputPath)} did not contain a JSON array. Aborting.`);
    process.exit(1);
  }
  console.log(`  ${existingData.length} existing records`);

  // Sanitise titles in base data on load
  existingData.forEach(r => { if (r.title) r.title = sanitiseTitle(r.title); });
  const enriched = [...existingData];
  const { titleIndex, handleIndex } = buildIndexes(enriched);

  const stats = {
    initial:      existingData.length,
    funko:        { totalScraped: 0, newCount: 0, enrichedCount: 0 },
    pricecharting:{ found: 0, notFound: 0, errors: 0 },
    pricechartingCrawl:{ discovered: 0, added: 0, pages: 0, withUpc: 0 },
    hobbydb:      { found: 0, notFound: 0, errors: 0 },
    funkoDetail:  { enriched: 0, notFound: 0, errors: 0 },
  };

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

  // 2b. Extract Pop# from titles BEFORE dedup, so funkoNumber is populated on
  //     PriceCharting records (parsed from "#nnn") and the dedup step can use it
  //     as the strong join key when matching them to canonical records.
  extractNumbersFromTitles(enriched);

  // 3. Dedup funko.com + PriceCharting additions against the clean HobbyDB records
  const deduped = dedupeAndMerge(enriched);
  enriched.length = 0; enriched.push(...deduped);

  // 3b. Safety net: re-run the non-Pop filter after the funko.com dedup, in case
  //     a funko.com addition carried a non-Pop series tag. After the step-1
  //     reorder this should remove ~nothing from the HobbyDB side.
  const cleaned2 = removeNonPops(enriched);
  enriched.length = 0; enriched.push(...cleaned2);

  // 4b. UPC collision scrub (opt-in). Runs after number extraction so box
  //     numbers are populated, and before grouping so scrubbed records group
  //     cleanly. Dry-run unless --scrub-apply; always writes a changelog next
  //     to the output for review.
  if (opts.scrubCollisions) {
    const scrub = scrubUpcCollisions(enriched, { apply: !!opts.scrubApply });
    const clPath = path.resolve(opts.output).replace(/\.json$/i, '') +
      `.upc-scrub${opts.scrubApply ? '' : '.dryrun'}.json`;
    fs.writeFileSync(clPath, JSON.stringify(scrub.changelog, null, 2), 'utf8');
    console.log(`  changelog: ${clPath}`);
    if (!opts.scrubApply && scrub.blanked > 0) {
      console.log('  (dry-run — review the changelog, then re-run with --scrub-apply)');
    }
  }

  // 5. Derive collection-grouping fields (setTag, franchiseSuggestion) LAST, over
  //    the final clean record set, so the series-tag frequency map and console
  //    reads reflect post-merge/post-removal data.
  deriveGroupingFields(enriched);

  // 6. Mark price provenance. Records PriceCharting could not price are flagged
  //    priceSource:'none' so the FunkoDex app knows to auto-try its live price
  //    tiers (eBay sold, etc.) on display — by UPC when present, by title
  //    otherwise. Records that already carry a priceSource (set when a PC price
  //    was applied) are left as-is.
  let pricedCount = 0, pendingCount = 0;
  for (const r of enriched) {
    const hasPrice = !!(r.marketValueLoose || r.marketValueComplete || r.marketValueNew);
    if (hasPrice) {
      if (!r.priceSource) r.priceSource = 'pricecharting';
      pricedCount++;
    } else {
      r.priceSource = 'none';   // app: try live tiers on view
      pendingCount++;
    }
  }
  console.log(`  priceSource: ${pricedCount} priced, ${pendingCount} pending (app live-tier fill)`);

  // 7. Reshape to the base catalog document format by default, so the output IS
  //    a base file (catalog:: ids, string series, derived identity fields, no
  //    scaffolding). Pass --working-shape to emit the raw enricher shape instead.
  if (!opts.workingShape) {
    toBaseCatalogShape(enriched, { catalogSource: opts.catalogSource });
  }

  // Write output
  const outputPath = path.resolve(opts.output);
  fs.writeFileSync(outputPath, JSON.stringify(enriched, null, 2), 'utf8');

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('\n═══ Final Summary ══════════════════════════════════════════');
  console.log(`  Initial records:          ${stats.initial}`);
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
