# funko_enrich — Changelog

Notable changes to the enricher pipeline. Most recent first.

---

## Fix: non-Pop removal reordered before handle merge — 2026-06-20

### Fixed

- **~1,800 real Pops were being silently deleted from the output.** A real Pop
  and a non-Pop sharing the same HobbyDB handle (e.g. "Ronald McDonald" Pop! Ad
  Icons and its Wacky Wobbler twin; the Office set; Vegeta; Marvel Zombies) were
  fused by `mergeDuplicateHandles`, which unions the duplicates' `series` arrays.
  The fused record then carried the non-Pop series tag, so `removeNonPops`
  deleted the whole thing — taking the real Pop with it. Pass 3 had already
  priced these records in memory (the console showed loose/complete/mint), but
  the record was removed in post-process, so the prices never reached the file.
- **Fix:** post-processing now removes non-Pop records FIRST, per-record, before
  any handle merge, so a non-Pop twin is dropped on its own and the Pop survives
  to be merged/kept. A second non-Pop pass runs after the funko.com dedup as a
  cheap safety net. Order is now: removeNonPops → mergeDuplicateHandles →
  dedupeAndMerge → removeNonPops (safety) → extract Pop# → derive grouping.
- **Verified** against the full 23,940-record base: rescues ~1,800 Pops, drops 0
  legitimate records; all 1,801 mixed Pop/non-Pop handle cases retain a surviving
  Pop copy; rescued records keep their Pass 3 prices and UPCs through the merge.
- **Regeneration required.** The previously committed `funko_data_enriched.json`
  (12,176 records) is missing the ~1,837 deleted Pops, which carry no enrichment
  at all (they were removed before their data could persist). Re-running
  `node enrich.js` re-adds them and enriches them through the normal idempotent
  passes (Pass 4 HobbyDB refs/UPC/number, Pass 3 prices). Expected output ~13,900+
  records. The base `funko_data.json` was never affected — it still holds all of
  them.

---

## Series-completion grouping fields — 2026-06-20

### Added

- **POST-PROCESS 5 — `setTag` + `franchiseSuggestion`.** New final post-process
  emitting two grouping fields the FunkoDex app consumes for series completion.
  `setTag` is the most-specific named set from the `series` array (specific set
  suffix, excluding Pop! lines / exclusives / generic broad lines; lowest-frequency
  tiebreak). `franchiseSuggestion` is a property-level franchise, preferring the
  cleaned PriceCharting `pcSeries` row (retailer/event suffixes stripped) and
  falling back to a property-specific console slug (umbrella consoles excluded).
  Both fields are also added to `MERGE_FIELDS` so they survive duplicate-handle
  merge. Validated on the live 12,176-record output: 13 clean set tags
  (Haunted Mansion 19/19); franchise coverage 57 → 630 with Hocus Pocus resolving.

---

## PriceCharting integration + matching safety — 2026-06-20

### Added

- **Pass 3 — PriceCharting market values.** Searches PriceCharting's HTML search
  page through Puppeteer (the JSON `/api/products` endpoint is unreliable), picks
  the best variant by score, and on a confident match harvests loose/complete/mint
  prices plus metadata (UPC, release date, ePID, ASIN, print run, publisher,
  series, description) from the product page. Complete (in-box) is the primary
  value.
- **Pass 3b — PriceCharting catalog crawl** (`--pc-crawl`). Walks every Funko
  console set (auto-discovered from PriceCharting's category nav; hardcoded
  fallback if discovery fails) and adds Pops not in the catalog, visiting each new
  Pop's product page to harvest its UPC so the record is scannable. Listing rows
  carry all three prices inline. `--pc-crawl-limit N` caps discoveries for a test.
- **`--pc-fill-upc`.** Also revisits already-priced records that lack a UPC, so
  the product-page harvest can backfill the barcode — the path to completing UPC
  coverage.
- **Confidence gate** (`pcMatchConfident`). Only attaches a price on a trusted
  match: exact base/base, or a positive variant-token hit with the core name
  covered. Records whose variant PriceCharting names differently are skipped and
  logged, rather than risk a wrong-variant price.
- **Approximate base-price fallback.** When a variant record matches the *exact
  same base figure* PriceCharting lists only as a base (set-equal core name, no
  conflicting variant tag), it prices from the base figure and sets
  `marketValueIsApproximate: true`. Recovers same-character variants (e.g. Krillin
  Metallic, Beth Harmon Finale) without accepting different figures. Summary line
  reports `Found: N (M approximate)`; approximate rows print a `~approx` tag.

### Fixed

- **Wrong-figure matches** via shared common words (Freddy Frostbear → Baseball
  Freddy): added core-name coverage check.
- **Cross-category matches** (FNAF Game → PlayStation 5 title): search filtered to
  `funko-pop-*` consoles only.
- **Concatenated UPC** from multi-UPC product-page cells: `normalizeUpc` takes the
  first valid 12–13 digit run.
- **Substring false matches** (Piccolo → Orange Piccolo, Robin → Robin as
  Nightwing): approximate fallback requires exact (set-equal) core name.
- **Product-page URLs built from the numeric id** (404s + silent metadata-harvest
  failure): now navigate the listing/search row's real name-slug `href`.
- **Variant-token stopwords** ("Glow In The Dark" false-matching plain rows via
  "in"/"the"): stopwords stripped from variant tokens.
- **Crash on first item** from a leftover `prices.` reference in the success log.

### Notes

- Verified PriceCharting serves pages to a plain Android-UA fetch (no JS
  challenge), enabling the FunkoDex app's lightweight OkHttp re-scrape.
- Product URLs use the name-slug, not the numeric id.
- A production crawl chunk discovered 1000 new Pops (~94% with UPCs) and confirmed
  the pipeline end to end.

---

## Earlier

- Base pipeline: Pass 1 (Kenny Chan merge), Pass 2 (funko.com scrape), Pass 4
  (HobbyDB reference numbers), Pass 5 (funko.com franchise/series), plus
  post-processing (handle merge, funko.com/HobbyDB dedup, non-Pop removal, Pop#
  extraction). Community UPC delta export (`export-community-delta.js`).
