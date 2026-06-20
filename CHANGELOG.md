# funko_enrich — Changelog

Notable changes to the enricher pipeline. Most recent first.

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
