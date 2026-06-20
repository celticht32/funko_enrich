# Installing Node.js and Running the Funko Data Enricher on Windows

## Step 1 - Check if Node.js is already installed

Press **Win + R**, type `cmd`, press Enter. Then type:

```
node --version
```

If you see a version number (e.g. `v22.15.0`) you already have Node.js.
Skip to **Step 3**.

If you see `'node' is not recognized`, continue to Step 2.

---

## Step 2 - Install Node.js

1. Open a browser and go to: **https://nodejs.org**
2. Click the **LTS** download button (Long-Term Support - the stable version).
   As of mid-2026 that is Node.js 24.
3. Run the downloaded `.msi` installer.
4. Click through the defaults. Make sure **"Add to PATH"** is checked (it is by default).
5. When the installer finishes, **close and reopen** your Command Prompt window.
6. Verify:

```
node --version
npm --version
```

Both should print version numbers.

---

## Step 3 - The funko-enricher folder

This folder lives at `funko-enricher/` in the FunkoDex repo and contains:

```
funko-enricher\
  enrich.js
  export-community-delta.js
  fix_typo.js
  test_handle.js
  test_parser.js
  funko_data.json
  funko_data_enriched.json
  package.json
  package-lock.json
  README.md
  INSTALL_AND_RUN.md
  HANDOFF.md
```

`node_modules/` is not committed - install dependencies in Step 5 to create it.

---

## Step 4 - Open a Command Prompt in the folder

In File Explorer, navigate into the `funko-enricher` folder.
Click the address bar at the top, type `cmd`, press Enter.

Confirm you're in the right place:
```
cd
```
It should show the full path to the `funko-enricher` folder.

---

## Step 5 - Install dependencies

Run once only:

```
npm install
```

When it finishes and returns you to the prompt, you're ready.

---

## Step 5b - Confirm Chrome is installed (for Passes 2, 4, 5)

Passes 2, 4, and 5 scrape funko.com and hobbydb.com using a real browser to
bypass bot detection. The script auto-detects Chrome from the standard install
location. If you have Google Chrome installed you're already set - skip ahead.

If Chrome is not installed: https://www.google.com/chrome

If Chrome is installed somewhere non-standard, add `--chrome-path` when you run:
```
node enrich.js --chrome-path "C:\path\to\chrome.exe"
```

Microsoft Edge also works as a fallback and is auto-detected if Chrome isn't found.

---

## Step 6 - Run the enricher

The enricher runs in five passes, executed in the order **1 -> 2 -> 4 -> 5 -> 3**
(PriceCharting runs last). You can run all of them at once or skip passes you
don't need yet with `--skip-kenny`, `--skip-funko`, `--skip-pc`, `--skip-hdb`,
and `--skip-funko-detail`.

**Quick test first** (Kenny Chan + 3 funko.com pages only, skips PriceCharting,
HobbyDB, and the funko.com detail pass):
```
node enrich.js --max-pages 3 --skip-pc --skip-hdb --skip-funko-detail --output test_output.json
```

Check that `test_output.json` appeared and has data. If it does:

**Full run - all five passes:**
```
node enrich.js --input funko_data.json --output funko_data_enriched.json
```

**Full run - skip PriceCharting (much faster, run it separately later):**
```
node enrich.js --input funko_data.json --output funko_data_enriched.json --skip-pc
```

**PriceCharting pass only** (after you've already done the above):
```
node enrich.js --input funko_data_enriched.json --output funko_data_enriched.json --skip-kenny --skip-funko --skip-hdb --skip-funko-detail --pc-limit 500
```

**HobbyDB reference pass only** (fill in UPC/Funko# for records already
enriched by Pass 2):
```
node enrich.js --input funko_data_enriched.json --output funko_data_enriched.json --skip-kenny --skip-funko --skip-pc --skip-funko-detail --hdb-limit 500
```

---

## What each pass does

**Pass 1 - Kenny Chan GitHub** (~30 seconds)
Downloads an MIT-licensed open dataset of ~23,000 Funko records from GitHub
and merges any items not already in your catalog. No scraping - just a
single file download.

**Pass 2 - funko.com listings** (~10 minutes)
Scrapes funko.com's product listing and adds: current retail price,
availability, product URL, and funko.com image. Only covers items currently
for sale - vaulted items are expected to show nothing here.

**Pass 4 - HobbyDB reference numbers** (~5 minutes at the default limit)
Looks up each catalog item's HobbyDB page for its UPC barcode, Funko number,
HobbyDB ID, retailer-exclusive SKUs (Hot Topic, GameStop, Target, Walmart,
Amazon), and `series` — a deduped list of HobbyDB "subject" tags (format,
event, or product-line tags as HobbyDB presents them, not classified as
franchise vs. category). Limited to 200 lookups per run by default
(`--hdb-limit`); records are marked as checked so repeated runs work through
the backlog without re-checking the same items. Use `--retry-no-series` to
re-check `hdbChecked` records that came back with no `series` tags (e.g. to
backfill `series` on records scraped before this field existed).

**Pass 5 - funko.com product detail pages** (varies)
For any record with no `franchise` that has a `productUrl` (not just
funko.com-only records — HobbyDB-origin records that picked up a `productUrl`
via the dedup/merge pass are also eligible), fetches the product page and
reads its breadcrumb to fill in `franchise` and `funkoSection`. Sets `series`
to `["Pop! Vinyl", franchise]` only if the record doesn't already have a
`series` array (so Pass 4's HobbyDB tags aren't overwritten).

**Pass 3 - PriceCharting** (long - see timing below)
Looks up secondary market values (what collectors actually pay) from
PriceCharting.com, which tracks eBay sold listings. Adds loose (out of box)
and sealed (in box) market values. Uses a 2.5 second delay between requests
to be polite to the site. Use `--pc-limit` to cap how many items to look up.
Runs last so it can price records enriched by the earlier passes.

| Pass | Time estimate |
|---|---|
| Pass 1 | < 30 seconds |
| Pass 2 (full catalog) | ~10 minutes |
| Pass 4 (default --hdb-limit 200) | ~5 minutes |
| Pass 5 | varies - only records missing franchise that have a productUrl |
| Pass 3 at --pc-limit 500 | ~40 minutes |
| Pass 3 at --pc-limit 10000 | ~14 hours |

Running Pass 3 overnight with a high limit is a valid strategy. Pass 4 is
designed to be run repeatedly with its default limit to work through a large
catalog over several runs.

---

## When it finishes

You'll see a summary, in this order:

```
=== Final Summary ==============================================
  Initial records:          12453
  Pass 1 - Kenny Chan:
    New records added:      847
    Existing enriched:      203
  Pass 2 - funko.com:
    Pages scraped:          2841 products
    New records added:      47
    Existing enriched:      1203
  Pass 5 - funko.com detail pages:
    Franchise enriched:     312
    Not found:              18
    Errors:                 2
  Pass 4 - HobbyDB:
    Records enriched:       180
    Not found:              15
    Errors:                 5
  Pass 3 - PriceCharting:
    Market prices found:    412
    Not found:              88
  Output records:           13347
  Pop# extracted from title: 96
  (non-Pop HobbyDB records removed in post-process)
  Output file:              C:\...\funko_data_enriched.json
  Total time:               ...
```

`funko_data_enriched.json` is your final file - copy it to your Android device
and import it into FunkoDex via Settings -> Import Enriched Catalog.

---

## Troubleshooting

**`'node' is not recognized`**
Close and reopen Command Prompt after installing Node.js.

**`npm install` fails with permission errors**
Right-click Command Prompt -> **Run as administrator**, then retry.

**Pass 2 shows "0 tiles found" on every page**
funko.com updated their site. See the Troubleshooting section in `README.md`.

**Pass 4 shows mostly "no refs found"**
Expected for some titles - HobbyDB doesn't have a page for every item, or the
handle-to-URL conversion doesn't match. Records are marked `hdbChecked: true`
so they aren't retried every run; use `--retry-no-refs` to give them another
attempt later.

**Want to backfill `series` tags without rebuilding from scratch**
Use `--retry-no-series` to re-check `hdbChecked` records with an empty
`series` array — see `README.md`'s Pass 4 troubleshooting for the full
command.

**Pass 3 mostly "not found"**
Expected - PriceCharting matches ~60-70% of titles. Unusual names and special
characters reduce the match rate. Not a problem; those records just won't have
market values.

**Want to re-run later to pick up new releases**
```
node enrich.js --input funko_data_enriched.json --output funko_data_enriched.json
```
Pass 1 and 2 will add new items; Pass 4 and 5 will enrich newly-added records;
Pass 3 will only look up records still missing pricing from previous runs.
