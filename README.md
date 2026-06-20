# Funko Data Enricher
MIT License, Copyright (c) 2026 Chris Ahrendt

Five-pass enrichment pipeline that builds on your existing `funko_data.json`
(HobbyDB/Kenny Chan base catalog) and adds data from four free sources.

## Setup

```
npm install
```

## Usage

```
node enrich.js [options]
```

| Option | Default | Description |
|---|---|---|
| `--input` | `funko_data.json` | Base catalog JSON |
| `--output` | `funko_data_enriched.json` | Enriched output |
| `--delay` | `1500` | Milliseconds between funko.com listing page loads (Pass 2) |
| `--chrome-path` | auto-detect | Path to Chrome/Edge executable |
| `--max-pages` | `0` (unlimited) | Stop funko.com listing scrape after N pages (Pass 2) |
| `--pops-only` | off | Scrape funko.com's Pop!-only filter URL instead of all products (Pass 2) |
| `--no-pop-filter` | off | Disable the standard-Pop title filter on funko.com results (Pass 2) |
| `--skip-kenny` | off | Skip Pass 1 |
| `--skip-funko` | off | Skip Pass 2 |
| `--skip-pc` | off | Skip Pass 3 |
| `--pc-limit` | `500` | Max items to look up on PriceCharting (Pass 3) |
| `--pc-crawl` | off | Enable Pass 3b: crawl PriceCharting to discover missing Pops |
| `--pc-crawl-limit` | none | Cap new Pops discovered by the crawl (for test runs) |
| `--pc-fill-upc` | off | Also revisit already-priced records that lack a UPC, to backfill it |
| `--skip-hdb` | off | Skip Pass 4 |
| `--hdb-limit` | `200` | Max HobbyDB lookups per run (Pass 4) |
| `--hdb-delay` | `1500` | Milliseconds between HobbyDB requests (Pass 4) |
| `--hdb-all` | off | Look up all records on HobbyDB, not just those missing UPC/Funko# (Pass 4) |
| `--retry-no-refs` | off | Re-fetch only records previously checked but with no HobbyDB refs found (Pass 4) |
| `--retry-no-series` | off | Re-fetch only records previously checked (`hdbChecked`) but with no `series` tags found (Pass 4) — use to backfill `series` on records scraped before `parseHobbyDbSeries` existed, without rebuilding from scratch |
| `--skip-funko-detail` | off | Skip Pass 5 |
| `--funko-detail-delay` | `1000` | Milliseconds between funko.com product detail page fetches (Pass 5) |

### Quick test (3 funko.com pages, no PriceCharting/HobbyDB/detail passes)
```
node enrich.js --max-pages 3 --skip-pc --skip-hdb --skip-funko-detail --output test_output.json
```

### Full run (all five passes)
```
node enrich.js --input funko_data.json --output funko_data_enriched.json
```

### Re-run to pick up new pricing/refs only (catalog already enriched)
```
node enrich.js --input funko_data_enriched.json --output funko_data_enriched.json --skip-kenny --skip-funko --hdb-limit 500 --pc-limit 1000
```

---

## The Five Passes

Execution order is **1 -> 2 -> 4 -> 5 -> 3** (PriceCharting runs last so it can
price records enriched by the earlier passes).

### Pass 1 - Kenny Chan GitHub Dataset
- Source: `github.com/kennymkchan/funko-pop-data` (MIT license, ~23k records)
- Downloads the JSON directly from GitHub at run time - no scraping
- **Adds** records not in your HobbyDB base (catalog gap fill)
- **Fills** missing `imageName` on existing records where Kenny has it
- Fields added: `kennySource: true` (audit flag on new records)

### Pass 2 - funko.com Listing Scrape
- Source: funko.com product listing pages (current inventory only)
- Default: paginates `/all-funko-products/`; with `--pops-only`, uses the
  Pop!-filtered listing instead (`/fandoms/?prefn1=productType&prefv1=Pop!`)
- 48 products per page
- **Enriches** existing records with funko.com-specific data
- **Adds** any net-new records not in passes 1 or base
- Fields added: `pid`, `price`, `available`, `productUrl`, `funkoPrimaryImage`, `funkoSource`
- By default, a title filter keeps only standard Pops (`--no-pop-filter` disables this)
- Note: vaulted/retired items won't appear here - that's expected

### Pass 3 - PriceCharting Market Values
- Source: pricecharting.com (eBay sold-listing aggregator, free data, no API key)
- Only runs on records that don't already have any market price
- **Search:** uses PriceCharting's HTML search page through Puppeteer (the JSON
  `/api/products` endpoint is unreliable / blocked). The query is the record's
  *core* name with variant qualifiers and `#NN` stripped, plus "funko" — e.g.
  "Twinkie The Kid (Glow In The Dark)" searches as "Twinkie The Kid funko".
  Searching the full decorated title was the old cause of false "not found".
- **Variant matching:** the search returns all variants of a figure; the best
  row is chosen by score (variant-token overlap + funko-number match, penalising
  unwanted variant tags). A **confidence gate** then decides whether to trust it:
  - record has no variant qualifiers + row is also base → priced
  - record's variant token (e.g. "metallic", "chase") appears in the row → priced
  - record wants a variant but no token matched (e.g. catalog "Glow In The Dark"
    vs PriceCharting "Chase GITD") → **skipped and logged as uncertain**, rather
    than risk attaching the wrong variant's price. Stopwords (in/the/of/…) are
    ignored so they can't cause a false match.
  Summary line reports Found / Uncertain (skipped) / Not found / Errors.
- Captures **all three grades** inline from the search row: `marketValueLoose`
  (out of box), `marketValueComplete` (in box — primary), `marketValueNew`
  (mint). The product page is then visited to harvest metadata.
- **Also harvests metadata** into fields the record is MISSING (never overwrites):
  `upc`, `funkoNumber`, `pcSeries`, `releaseDate`, `ebayEpid`, `amazonAsin`,
  `printRun`, `publisher`, `pcDescription`.
- Through Puppeteer + stealth, browser restart every 200 records, 2.5s delay.
- Use `--pc-limit` to cap how many items to look up. Runs after Passes 1/2/4/5.
- **Completing UPC coverage:** by default Pass 3 skips any record that already
  has a price. With `--pc-fill-upc` it ALSO revisits priced records that have no
  UPC, so the product-page metadata harvest can backfill the barcode. This is the
  way to fill UPCs on records that were priced before the metadata harvest worked.
  A record is only skipped once it has both a price and a UPC. (The confidence
  gate still applies — an uncertain variant match attaches neither price nor UPC,
  since a wrong UPC would make the app's barcode scan resolve the wrong figure.)

### Pass 3b - PriceCharting Catalog Crawl (find missing Pops)
- **OFF by default** — enable with `--pc-crawl`.
- Walks PriceCharting's Funko "console" set listing pages and adds any Pop whose
  PriceCharting id we don't already have as a new record. Listing rows carry all
  three prices inline, so discovered Pops arrive already priced.
- **Visits each new Pop's product page to harvest the UPC** (and release date,
  ePID, etc.) — the listing row has no UPC, and the UPC is what makes a record
  scannable in the app. This is the slow part: one extra page fetch per new Pop,
  so a full crawl is hours, not minutes. On a product-page failure the priced
  listing-row record is still kept (just without a UPC).
- Use `--pc-crawl-limit N` to cap discoveries for a test run (e.g. stop after 20
  new Pops). Summary reports `New Pops discovered` and `With UPC (scannable)`.
- New records get `handle: pc-{id}`, `funkoSource: 'pricecharting'`, the PC
  id/url, inline prices, and (when the product page has it) UPC + metadata.
- **Console sets are discovered automatically** at run time from PriceCharting's
  Funko category nav, so the crawl covers every funko-pop-* set and picks up new
  categories PriceCharting adds. A hardcoded fallback list is used only if that
  discovery fails.
- Not every PriceCharting product page has a UPC filled in, so UPC coverage will
  be "most," not "all."

### Pass 4 - HobbyDB Reference Numbers
- Source: hobbydb.com catalog item pages (Puppeteer, reuses Pass 2's browser session)
- Candidates: records with a non-`.html` handle missing `upc` or `funkoNumber`
  (records added by Pass 2 with a `NNNNN.html`-style handle have no HobbyDB page
  and are skipped)
- `--hdb-all` looks up every eligible record regardless of existing data;
  `--retry-no-refs` re-checks only records previously marked `hdbChecked` with
  no refs found; `--retry-no-series` re-checks only records previously marked
  `hdbChecked` with an empty `series` array
- Fields added when present on the HobbyDB page: `hdbid`, `upc`, `funkoNumber`,
  `hotTopicSku`, `gamestopSku`, `targetSku`, `walmartSku`, `amazonSku`, and
  `series` — a deduped list of HobbyDB "subject" tags scraped via
  `parseHobbyDbSeries` (selector `a[href*="/subjects/"][href$="-series"]`,
  which also matches `-event-series` hrefs). This is a raw tag list (format,
  event, or product-line tags as HobbyDB presents them) — not classified as
  franchise vs. category, since some pages (e.g. Saint Cloth Myth EX) expose
  only one tag total with no distinct franchise tag. `series` is filled only
  if the record doesn't already have one.
- Marks every checked record `hdbChecked: true` (whether or not refs were found)
  so subsequent runs skip already-checked records unless `--hdb-all` or
  `--retry-no-refs` is set
- Saves output incrementally every 10 records, and restarts the browser every
  200 records to control memory growth

### Pass 5 - funko.com Product Page Franchise Enrichment
- Candidates: **any** record with an empty `franchise` that has a
  `productUrl` (widened from the original `funkoSource === "funko.com"`-only
  gate, so HobbyDB-origin records that picked up a `productUrl` via the
  dedup/merge pass are also eligible — records with no `productUrl` at all
  have no funko.com page to check and are left as-is)
- Fetches each record's `productUrl` and reads the JSON-LD `BreadcrumbList`
  (`Funko -> Section -> Franchise -> Product`)
- Fields added: `franchise` (breadcrumb position 3), `funkoSection` (breadcrumb
  position 2, e.g. "Fandoms", "Sports", "Music"); `series` is set to
  `["Pop! Vinyl", franchise]` to match the HobbyDB format **only if the
  record doesn't already have a `series` array** (e.g. one filled by Pass 4's
  `parseHobbyDbSeries`) — Pass 5 no longer clobbers Pass 4's series tags.
- Reuses the Puppeteer browser from Passes 2/4; paced at `--funko-detail-delay`

---

## New Fields Added

| Field | Source pass | Description |
|---|---|---|
| `kennySource` | 1 | `true` on records added from Kenny Chan's dataset |
| `pid` | 2 | Funko's internal SFCC product ID |
| `price` | 2 | Current listed retail price (string, e.g. `"$11.99"`) |
| `available` | 2 | Boolean - in stock on funko.com |
| `productUrl` | 2 | Direct product page URL |
| `funkoPrimaryImage` | 2 | Funko CDN image URL |
| `funkoSource` | 2 | `"funko.com"` (audit trail) |
| `marketValueLoose` | 3 | Secondary market value, out of box |
| `marketValueComplete` | 3 | Secondary market value, in box (primary) |
| `marketValueNew` | 3 | Secondary market value, mint/sealed |
| `pricechartingId` | 3 | PriceCharting product ID |
| `pricechartingUrl` | 3 | Direct PriceCharting page URL |
| `hdbid` | 4 | HobbyDB's own numeric catalog item ID |
| `upc` | 4 | Barcode (most valuable for FunkoDex scanning) |
| `funkoNumber` | 4 | Funko's official Pop number, digits only, max 6 (e.g. `"203"`) |
| `hotTopicSku` / `gamestopSku` / `targetSku` / `walmartSku` / `amazonSku` | 4 | Retailer SKUs for exclusives, where present |
| `hdbChecked` | 4 | `true` once a record has been checked against HobbyDB (controls re-fetch behavior) |
| `series` | 4, 5 | Pass 4: deduped HobbyDB "subject" tags via `parseHobbyDbSeries` (raw, unclassified). Pass 5: `["Pop! Vinyl", franchise]` for records still missing `series` after Pass 4. |
| `franchise` | 5 | Franchise/category from funko.com breadcrumb |
| `funkoSection` | 5 | Top-level funko.com section (e.g. "Fandoms") |
| `popType` | post-processing | e.g. "Pop!", "Pop! Deluxe", "Pop! Rides" |
| `funkoNumberFromTitle` | post-processing | Pop # extracted from title text, kept separate from verified `funkoNumber` |

Fields already in base data (`handle`, `title`, `imageName`, `series` on
non-funko.com-only records) are **never overwritten** - only new/missing
fields are filled in. The four post-processing steps that run after all five
passes (in order) are: merge duplicate handles, dedupe funko.com additions
against HobbyDB records, remove non-Pop HobbyDB records, and extract Pop#
from titles / clean prices.

---

## Timing Estimates

| Pass | Rate | ~12k records |
|---|---|---|
| Pass 1 Kenny Chan | Single download | < 30 seconds |
| Pass 2 funko.com listings | 1500ms/page, 48/page | ~10 minutes |
| Pass 4 HobbyDB | 1500ms/record, limit 200 | ~5 minutes per run (default limit) |
| Pass 5 funko.com detail | 1000ms/record | varies - only runs on funko.com-only records missing series |
| Pass 3 PriceCharting | 2500ms x 2 req/item | ~14 hrs at `--pc-limit 10000` |

For Pass 3, use `--pc-limit 500` for a first run (~40 minutes). For Pass 4,
the default `--hdb-limit 200` keeps each run to a few minutes; run repeatedly
to work through a large backlog - already-checked records (`hdbChecked: true`)
are skipped on subsequent runs unless `--hdb-all` or `--retry-no-refs` is set.

---

## Troubleshooting

**Pass 2 shows "0 tiles found" on every page**
funko.com changed their HTML structure. Open the page in a browser, inspect a
product card, find its CSS class or `data-*` attribute, and add it to the
`tileSelectors` array around line 140 of `enrich.js`.

**Pass 3 shows mostly "not found"**
PriceCharting title matching is fuzzy but sometimes misses. Items with special
characters, abbreviations, or unusual series names are harder to match. This is
expected - expect ~60-70% match rate on a typical catalog.

**Pass 4 shows "no refs found" for many records**
HobbyDB doesn't have a catalog page for every item, or the handle-to-URL
conversion doesn't match HobbyDB's URL convention for that title. Records are
still marked `hdbChecked: true` so they won't be retried every run; use
`--retry-no-refs` to give them another attempt after `enrich.js`'s handle
normalization logic is updated.

**Want to backfill `series` tags on records scraped before `parseHobbyDbSeries` existed**
Records already marked `hdbChecked: true` won't be re-fetched by a normal run.
Use `--retry-no-series` (with `--skip-kenny --skip-pc --skip-funko
--skip-funko-detail` and a high `--hdb-limit` to cover the whole dataset) to
re-fetch only `hdbChecked` records with an empty `series` array — without
rebuilding from scratch:
```
node enrich.js --skip-kenny --skip-pc --skip-funko --skip-funko-detail --retry-no-series --hdb-limit 100000 --input funko_data_enriched.json --output funko_data_enriched.json
```

**Want to re-run after new Funko releases**
```
node enrich.js --input funko_data_enriched.json --output funko_data_enriched.json
```
Pass 1 will add new Kenny Chan records; Pass 2 will add new funko.com items;
Pass 4 and 5 will pick up refs/franchise data for newly-added records; Pass 3
will only look up records still missing pricing.

---

## Chrome Requirement (Passes 2, 4, 5)

Passes 2, 4, and 5 use **puppeteer-core** + **puppeteer-extra-plugin-stealth**
to drive a real browser instance, sharing one browser session across all
three. This bypasses funko.com's and HobbyDB's bot detection, which blocks
plain HTTP requests with a 403.

**Chrome is required.** The script auto-detects it from these locations in order:
- `C:\Program Files\Google\Chrome\Application\chrome.exe`
- `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`
- `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`
- `C:\Program Files\Microsoft\Edge\Application\msedge.exe` (fallback)

If Chrome is not in a standard location, pass the path explicitly:
```
node enrich.js --chrome-path "C:\path\to\chrome.exe"
```

If Chrome is not installed at all, download it from https://www.google.com/chrome
