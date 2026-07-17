#!/usr/bin/env node
/**
 * salvage_enriched.js — finish a crashed enrich.js run.
 * MIT License, Copyright (c) 2026 Chris Ahrendt
 *
 * The enrich run completed all scraping but crashed in the final post-process,
 * leaving the output in MIXED shape: existing records in base-catalog shape plus
 * ~1,399 newly discovered funko.com records still in working shape. This runs the
 * two skipped post-processes using enrich.js's own functions verbatim:
 *   1) removeNonPops        2) toBaseCatalogShape
 * Result is identical to a clean run's output.
 *
 * USAGE (Windows):
 *   node salvage_enriched.js
 *   node salvage_enriched.js --input funkodex_base_catalog.enriched.json ^
 *                            --output funkodex_base_catalog.final.json
 */
const fs = require('fs');
function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag, def) => { const i = a.indexOf(flag); return i >= 0 ? a[i+1] : def; };
  return {
    input:  get('--input',  'funkodex_base_catalog.enriched.json'),
    output: get('--output', 'funkodex_base_catalog.final.json'),
  };
}

const NON_POP_TITLE_WORDS = /\b(backpack|crossbody|lanyard|keychain|soda|mystery minis|wacky wobbler|funkoverse|bitty pop|pocket pop|pin set|enamel pin|zip around|cardigan|hoodie|legging|beanie|cushion|plush|peluche|dorbz|vynl|hikari|rock candy|fabrikations|paka paka|spastik plastik|pint glass|shot glass|insulated glass|toothpick|thermos|tumbler|hacky sack|stress ball|ping pong|card game|cookie cutter|cookie jar|pop protector|popshield|snapback|luggage tag|salt and pepper|tote bag|magnets?|fidget spinner|fidget|funko'?s|funkos|cereal|notebook|journal|sticker|decal|coaster|playing cards?|puzzle|board game|dice|ornament|earbuds|headphones|phone case|air freshener|freshener|water bottle|bottle opener|figural bank|coin bank|mousepad|mouse pad|snow globe|water globe|lunchbox|lunch box)\b|^i'm a fan of /i;
const NON_POP_TITLE_PRODUCT = /(?<![(,]\s?(?:with |no |in )?)\b(scarf|apron|sunglasses|3d glasses|necktie|slippers|gloves|towel|blanket|pillow)\b\s*$/i;


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

// ── run ────────────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs();
  console.log('salvage_enriched');
  console.log('Loading:', opts.input);
  const data = JSON.parse(fs.readFileSync(opts.input, 'utf8'));
  console.log('  records in:', data.length);
  console.log('  working-shape (no _id) records:', data.filter(r => !r._id).length);

  const filtered = removeNonPops(data);
  toBaseCatalogShape(filtered, { catalogSource: 'ENRICHED' });

  const stillNoId = filtered.filter(r => !r._id).length;
  fs.writeFileSync(opts.output, JSON.stringify(filtered, null, 2));
  console.log('\n  records out:', filtered.length);
  console.log('  still missing _id:', stillNoId, '(should be 0)');
  console.log('  written:', opts.output);
  console.log('\nOriginal input untouched. Verify, then rename over your base.');
}
main();
