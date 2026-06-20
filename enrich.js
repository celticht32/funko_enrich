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
 *   --pc-limit        Max items to look up on PriceCharting (default: 500)
 *   --skip-hdb        Skip Pass 4 (HobbyDB Reference Numbers / series scrape)
 *   --hdb-limit       Max HobbyDB lookups per run        (default: 200)
 *   --hdb-delay       Milliseconds between HobbyDB requests (default: 1500)
 *   --hdb-all         Re-check all HobbyDB records, ignoring hdbChecked
 *   --retry-no-refs   Re-fetch hdbChecked records that have no hdbid
 *   --retry-no-series Re-fetch hdbChecked records missing series tags
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
    pcLimit:    500,
    chromePath: null,
    popsOnly:   false,
    skipHdb:    false,
    hdbLimit:   200,    // max HobbyDB lookups per run
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
      case '--input':       opts.input      = args[++i]; break;
      case '--output':      opts.output     = args[++i]; break;
      case '--delay':       opts.delay      = parseInt(args[++i], 10); break;
      case '--max-pages':   opts.maxPages   = parseInt(args[++i], 10); break;
      case '--skip-kenny':  opts.skipKenny  = true; break;
      case '--skip-funko':  opts.skipFunko  = true; break;
      case '--skip-pc':     opts.skipPc     = true; break;
      case '--pc-limit':    opts.pcLimit    = parseInt(args[++i], 10); break;
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
  let catalogTotal = -1; // detected from first page, -1 = unknown

  try {
    while (true) {
      if (opts.maxPages > 0 && pageNum > opts.maxPages) {
        console.log(`  Reached max-pages limit (${opts.maxPages}).`);
        break;
      }

      const pageSize = 48;
      const start    = (pageNum - 1) * pageSize;

      // Stop if we know the total and have already fetched it all
      if (catalogTotal > 0 && start >= catalogTotal) {
        console.log(`  Reached catalog end (${catalogTotal} items). Stopping.`);
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

        const html     = await page.content();

        // Extract total item count from SFCC page on first page only
        // SFCC renders it as e.g. "1-20 of 2,925 Items" in a .results-hits or similar element
        if (catalogTotal < 0) {
          const totalMatch = html.match(/(\d[\d,]*)\s+Items?/i);
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
const PC_DELAY       = 2500; // ms between PriceCharting requests — be polite

/**
 * Search PriceCharting for a Funko title, return the best match product object.
 * The /api/products search endpoint returns JSON catalog data (no auth, no
 * price) and is reachable with a plain fetch. Returns null if not found.
 *   Response: { products: [ { id, product-name, console-name } ] }
 */
async function searchPriceCharting(title) {
  try {
    const res = await fetchWithRetry(PC_SEARCH_URL(title), {}, 2, 3000);
    if (!res || !res.ok) return null;
    const data = await res.json();
    if (!data.products || data.products.length === 0) return null;
    // Best match = first result (PriceCharting already ranks by relevance)
    return data.products[0];
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
 * Fetch a PriceCharting product page through the shared Puppeteer page (real
 * browser + stealth) and parse all three grades. PriceCharting blocks plain
 * fetches of product pages, so the price scrape must go through the browser —
 * the same approach the HobbyDB pass uses. `page` is an already-open Puppeteer
 * page. Returns { loose, complete, mint, url } or null on failure.
 */
async function scrapePriceChartingPrices(page, productId, consoleName) {
  const consoleSlug = (consoleName || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-');
  const url = `${PC_BASE}/game/${consoleSlug}/${productId}`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // The price table is server-rendered; a short settle is enough.
    const html = await page.content();
    const prices = parsePriceChartingHtml(html);
    if (!prices.url) prices.url = url;
    return prices;
  } catch (err) {
    return null;
  }
}

async function passPriceCharting(enriched, opts) {
  console.log('\n── Pass 3: PriceCharting market values ───────────────────────');

  // Only look up records that don't already have market pricing (any grade).
  const candidates = enriched
    .map((rec, i) => ({ rec, i }))
    .filter(({ rec }) =>
      !rec.marketValueLoose && !rec.marketValueComplete && !rec.marketValueNew)
    .slice(0, opts.pcLimit);

  console.log(`  Candidates (no market price yet): ${candidates.length} (limit: ${opts.pcLimit})`);
  console.log(`  Estimated time: ~${Math.ceil(candidates.length * PC_DELAY / 60000)} minutes`);

  let found = 0, notFound = 0, errors = 0;

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

      // Step 1: catalog search (plain fetch is fine for the JSON search API).
      const match = await searchPriceCharting(rec.title);
      await sleep(PC_DELAY);
      if (!match) {
        console.log('not found');
        notFound++;
        continue;
      }

      // Step 2: price scrape via the browser.
      const prices = await scrapePriceChartingPrices(page, match.id, match['console-name']);
      await sleep(PC_DELAY);
      if (!prices || (!prices.loose && !prices.complete && !prices.mint)) {
        console.log(`found (id:${match.id}) — no price data`);
        notFound++;
        continue;
      }

      // Step 3: merge into record. Complete (in-box) is the primary value.
      const updates = {
        pricechartingId:  String(match.id),
        pricechartingUrl: prices.url,
      };
      if (prices.loose)    updates.marketValueLoose    = prices.loose;
      if (prices.complete) updates.marketValueComplete = prices.complete;
      if (prices.mint)     updates.marketValueNew      = prices.mint;

      enriched[idx] = { ...enriched[idx], ...updates };
      found++;
      console.log(`✓ loose:$${prices.loose || '?'} complete:$${prices.complete || '?'} mint:$${prices.mint || '?'}`);
    }
  } finally {
    try { await browser.close(); } catch (_) {}
  }

  console.log(`  Found: ${found} | Not found: ${notFound} | Errors: ${errors}`);
  return { found, notFound, errors };
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
  'pricechartingId', 'pricechartingUrl',
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

  // Load base data
  const inputPath = path.resolve(opts.input);
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

  // Pass 3 — PriceCharting (before post-processing so merges include PC data)
  if (!opts.skipPc) {
    stats.pricecharting = await passPriceCharting(enriched, opts);
  } else {
    console.log('\n── Pass 3: PriceCharting — SKIPPED (--skip-pc)');
  }

  // ── Post-processing (order matters) ──────────────────────────────────────
  // 1. Merge duplicate handles first — clean the base data before any dedup/removal
  const handleMerged = mergeDuplicateHandles(enriched);
  enriched.length = 0; enriched.push(...handleMerged);

  // 2. Dedup funko.com additions against the now-clean HobbyDB records
  const deduped = dedupeAndMerge(enriched);
  enriched.length = 0; enriched.push(...deduped);

  // 3. Remove non-Pop HobbyDB records
  const cleaned = removeNonPops(enriched);
  enriched.length = 0; enriched.push(...cleaned);

  // 4. Extract Pop# from titles and clean dirty prices
  extractNumbersFromTitles(enriched);

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
