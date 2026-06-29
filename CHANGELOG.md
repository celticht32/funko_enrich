# funko_enrich — Changelog

Notable changes to the enricher pipeline. Most recent first.

---
## Crawl completeness + match-rate + price provenance — 2026-06-28

A long session driven by a full golden-master rebuild. Three themes: making Pass 3b
crawl *verifiably complete* (it was silently truncating big sets), adding match
levers to Pass 3, and recording price provenance so the app can fill the gap.

### Pass 3b — crawl completeness (the big fix)

- **Target-count-driven scrolling.** Sets were truncating at the initial ~150-row
  page (Marvel loaded 1050 of its real 1904; Rocks 150 of 520) because the scroll
  accepted "row count stopped changing" as done. Now it reads PriceCharting's own
  stated total ("Prices for all N Funko … Figures" / "N items") and scrolls until
  the loaded count reaches it — deterministic, not timing-dependent. Falls back to
  stability detection only when no target is on the page.
- **Completeness gate.** A set is marked DONE (added to the sidecar, skipped on
  resume) only if it actually loaded acceptably — reached its stated target, or had
  no target but loaded >0 rows. A set that loads 0 rows or stalls well short is left
  UNMARKED and retries next run, with a `set NOT marked done (…)` message. Fixes the
  silent-skip where a transient empty page (Disney loaded 0) or a stall (Games 300
  of 1219) was wrongly marked complete.
- **Retry-on-empty.** When a set's page comes back blank (0 rows AND no target text
  — observed intermittently on digital/asia/wwe-covers), restart the browser and
  re-fetch up to 3 times before giving up. Targets PriceCharting serving an empty/
  blocked body for a set this session.

### Pass 3 / Pass 5 — crash safety + memory

- Pass 3 (pricing) checkpoints every 100 records (resume skips already-priced) and
  restarts the browser every 200 (memory over tens of thousands of page loads).
- Pass 5 checkpoints every 100 with a `franchiseChecked` marker.

### Pass 3 — match-rate levers

- **UPC-first match path.** When a record has a usable UPC, query PriceCharting by
  UPC first (their search resolves a UPC to the exact product). A single Funko row
  is taken as an exact-key match; multiple rows are title-scored among them; zero
  rows falls through to the unchanged title search. The confidence gate TRUSTS a
  UPC match (skips the name/variant check) since the barcode is exact — this is what
  lets it rescue oddly-named figures the title gate would reject. NOTE: many Funko
  UPCs are simply not in PriceCharting's index (verified: Freddy Frostbear UPC
  returns "No results"), so the real yield is a fraction of UPC-bearing failures.
- **Funko number in the search query.** `pcSearchQuery` now appends the record's
  funko number ("Twinkie the Kid #31 funko") — PriceCharting matches "name #NN" and
  the number disambiguates same-named figures. Scoring still picks the final row.

### Maintenance / provenance

- **`priceCheckedAt`** (ISO date) stamped on each priced record, enabling
  **`--reprice-older-than <days>`** to refresh aging prices on a later run (default
  off — priced records are otherwise permanent).
- **`dedupeAndMerge` now carries done-markers** (`hdbChecked`, `franchiseChecked`,
  `hdbid`, `priceCheckedAt`) onto the surviving record, so collapsing duplicates no
  longer causes re-scraping on the next run.
- **`priceSource` flag** stamped at final write: `'pricecharting'` when a real PC
  price is present, `'none'` when PC could not price it. The app uses `'none'` to
  decide whether to fill via its live tiers (on ADD, per the FunkoDex spec).

### New tools

- **`pc_match_diagnostic.js`** — read-only; breaks unpriced failures down by what
  would fix them (UPC / number / parser / title-only) and prints a verdict on which
  lever is highest-impact. Run after a build.
- **`clean_nonfigures.js`** — removes only pure non-figure merch (socks, drinkware,
  passport, poster, card games, Rock'em Sock'em) by EXACT title, protected by a
  Pop-signal check. Writes a new `*.clean.json`; leaves the original intact; prints
  a removal report. Note: FunkO's cereal, advent calendars, and collectors boxes
  each bundle an exclusive figure and are KEPT.

### Coverage at session end

~25,806 records (down from 45,607 raw via dedup), ~76% priced by PriceCharting. The
unpriced tail is dominated by items PriceCharting genuinely does not carry (non-
figure merch, convention/exclusive variants, multi-character packs, obscure
variants) — a data-availability ceiling, not a matcher weakness. The app's live
tiers (eBay etc.) close part of the rest per-item on add.

---


## PriceCharting dedup rework + deep-scan hardening — 2026-06-22

Pass 3b previously tried to recognise already-owned Pops mid-crawl, but
PriceCharting titles ("Shaak Ti #853") differ too much from catalog titles
("Shaak Ti") for reliable matching during the scrape, so it re-added thousands of
duplicates. Reworked so Pass 3b just downloads-and-adds, and all catalog-level
deduplication happens in post-process where the fields are fully populated.

### Changed

- **Pass 3b is now download-and-add only.** Removed the fragile in-crawl matcher;
  it dedupes only by pricechartingId (within/across runs). Simpler and more robust.
- **`dedupeAndMerge` now also collapses PriceCharting duplicates**, matching each
  PriceCharting record to an existing canonical record by funkoNumber + CORE NAME
  (title stripped of "#nnn", [brackets], (variant parens), HTML entities and
  accessory suffixes). Fill-only and conservative: requires both the number AND a
  name agreement, so distinct Pops that merely share a number are never collapsed.
- **Post-process reordered** so `extractNumbersFromTitles` runs before
  `dedupeAndMerge`, populating funkoNumber on both sides for the match key.

### Fixed (deep scan)

- **Dedup silently matched nothing (critical).** `extractNumbersFromTitles` strips
  "#nnn" from the title into `funkoNumberFromTitle`, but the dedup's number lookup
  only checked `funkoNumber` and the (now-stripped) title, so it found no number
  and merged nothing. Number lookup now also reads `funkoNumberFromTitle`.
- **Listing-row id fallback collided across products.** When the real PriceCharting
  id attribute was absent, the parser used `href.split('-').pop()` — the trailing
  Funko number (".../shaak-ti-853" → "853"), which repeats across lines and
  corrupted the pcId dedupe. Now falls back to the full unique product slug.
- **Merged records lost PriceCharting fields.** The dedup merge list used the wrong
  name `epid` (scraper stores `ebayEpid`) and omitted `pcSeries` (needed for
  franchiseSuggestion), `amazonAsin`, `printRun`, `publisher`, `pcDescription`.
  Now copies every field the scraper produces.
- **Malformed numeric flags silently disabled a pass.** `--hdb-limit abc` yielded
  NaN, making `.slice(0, NaN)` return zero candidates. Numeric flags now validate
  and fall back to the default with a warning.
- **Corrupted/truncated input crashed cryptically.** The main input parse and the
  resume read are now guarded with clear recovery messages and array-shape /
  null-element validation — relevant when a checkpoint write was interrupted.

### Other tuning

- Pass 4 checkpoints every 100 records (was 10) and writes unindented JSON, cutting
  cumulative checkpoint I/O ~20x on a full run (crash still loses ≤100 records).
- Pass 5 marks `franchiseChecked` on clean outcomes so a resumed run skips them
  (transient errors are left unmarked to retry); avoids re-scraping ~2,000 records
  every run. Pass 3b scroll confirms stability with an extra long-wait pass to
  avoid truncating a large set on a slow connection.

---

## Pass 3b: load full set contents via scroll (was capped at ~150/set) — 2026-06-22

### Fixed

- **Large PriceCharting sets were truncated to their first ~150 figures.** Console
  pages (e.g. funko-pop-rocks) show a full count — "all 534 Funko Rocks Figures" —
  but serve only ~150 rows in the initial HTML and lazy-load the rest via JS on
  scroll. The crawl relied on a "next" link (`a#next, a.next, a[rel=next]`) that
  PriceCharting does not use, and `?page=N` is ignored by the server (verified: it
  returns the same first rows). So every large set lost the majority of its figures
  — Rocks captured 150 of 534, and bigger sets (Disney, Marvel, Movies) lost even
  more — potentially thousands of records missing from the golden master.
  Fix: the crawl now loads each console page once and SCROLLS to the bottom
  repeatedly until the `#games_table tbody` row count stops growing (3 stable
  reads), then parses the fully-loaded DOM. Bounded by a 60-scroll hard cap per set
  so it cannot hang. Per-set output now reports `<slug>: N rows loaded` so the full
  count is visible (Rocks should report ~534, not 150).

---

## Resume-guard fix, uncapped passes, crawl progress counter — 2026-06-22

### Fixed

- **Resume guard wrongly rejected valid enriched output, restarting from scratch.**
  The first resume implementation only resumed when the output was ≥ the base
  record count. But the enriched output is intentionally SMALLER than the base
  (~16k vs base ~24k) because post-process removes non-Pops and merges duplicates,
  so the size test always failed and every run rebuilt from base — defeating the
  whole point of resume. The guard now resumes when the output contains
  ENRICHMENT MARKERS (any of hdbChecked / marketValue* / pricechartingId / upc),
  not based on size. Verified: a ~16k output with enrichment now correctly resumes.

### Changed

- **All enrichment passes are now effectively uncapped**, so one run reaches full
  coverage instead of leaving a backlog: `hdbLimit` 5000 → 1000000 (Pass 4 processes
  every HobbyDB candidate, including all Pass 3b discoveries beyond the old 5k cap),
  `pcLimit` already 100000 (Pass 3), `pcCrawlLimit` Infinity (Pass 3b). Combined with
  resume + checkpointing, a long run is crash-safe (a restart continues from the
  banked progress). Lower with `--hdb-limit N` / `--pc-limit N` for quick test runs.

### Added

- **Pass 3b crawl progress counter.** Prints `[set X/total] slug` per set (total
  computed at runtime from the discovered list — never hardcoded, grows if
  PriceCharting adds sets) and a `set done — N new from slug (running total: …)`
  summary. Per-set new-counts reveal slow stretches (many new Pops = many product
  fetches) vs fast ones (already-owned sets), which is the best available read on
  remaining time (a clean clock estimate isn't possible — per-set cost is dominated
  by how many NEW Pops each set contains, not set position).

### Termination audit

- Verified every pass loop has a guaranteed stop (after the Pass 2 runaway):
  Pass 2 has four independent stops (catalog-end, 500-page ceiling, 3× consecutive-
  empty, error break); Pass 3b has a per-set `guard < 50` page cap plus null-on-no-
  next and null-on-error over a finite set list; Pass 3/4/5 iterate fixed candidate
  arrays; all `page.goto`/`waitFor*` calls carry timeouts. Uncapped passes are
  candidate-bounded (finite), not infinite — they can run long, never forever.

---

## Pass 3b console discovery — full ~109-set coverage — 2026-06-22

### Fixed

- **Pass 3b discovered only ~28 of PriceCharting's ~109 Funko console sets**, so
  roughly three-quarters of PriceCharting's Funko catalog was never crawled —
  Town, Deluxe, Monsters, Sanrio, South Park, Trains, Trolls, WWE Covers, and
  ~80 other sets were silently skipped, capping the golden master's breadth.
  Root cause: `discoverFunkoConsoles` scraped `/search-products?q=funko` (which
  surfaces only the popular sets) instead of `/category/funko-pops` (the full
  index). Now it scrapes the category index and unions the result with the
  hardcoded fallback, so discovery can only ADD coverage, never regress. The
  fallback list was expanded from 29 to the full 109 sets harvested from the live
  index, so even a failed page fetch still crawls everything.

---

## Resume-from-output + category-from-console — 2026-06-22

### Fixed

- **Per-run caps (e.g. hdbLimit) could leave a permanent backlog.** Runs reloaded
  from base `funko_data.json` every time, so progress markers (hdbChecked, prices,
  discovered records) — which live only in the enriched OUTPUT — never carried
  forward. A capped pass therefore re-processed the same first N candidates on
  every run and never reached the stragglers beyond the cap. Now, unless `--input`
  is passed explicitly, a run RESUMES from the prior `funko_data_enriched.json`
  when it exists and is ≥ the base size, so each run advances through the backlog
  and re-runs converge on full coverage. Prints "Resuming from prior output…";
  falls back to base if the output looks partial.

### Added

- **Category derived from PriceCharting console (`categoryFromConsole`).** Pass
  3b-discovered records had no `category` (born with only console slug + URL), so
  they imported category-blank and were invisible to the app's dynamic category
  dropdown. `deriveGroupingFields` now maps the console slug to a category
  (`funko-pop-rides` → "Pop! Rides"), fill-only, and seeds `series` on bare
  records. The discovered breadth now displays correctly and feeds the dropdown.

---

### Fixed

- **Pass 2 (funko.com) ran unbounded.** The result-count regex contained literal
  backspace bytes (0x08) where `\b` was intended, so `catalogTotal` never
  detected and the end-of-catalog stop never armed; compounded by fixed-stride
  pagination (`start += 48`) while funko.com serves ~20/page, so the offset raced
  past the real ~2,969-item catalog and the empty-page stop never fired either.
  Now: `start` advances by ACTUAL products returned, the count is detected via a
  JS-wait + robust regex, and a hard 500-page ceiling backstops it. Pass 2 now
  stops cleanly (~149 pages).

### Changed

- **Defaults tuned for the most complete build.** A plain `node enrich.js` now
  runs Pass 3b discovery (`pcCrawl`), UPC fill (`pcFillUpc`), no pricing cap
  (`pcLimit` 500→100000), and a large HobbyDB limit (`hdbLimit` 200→5000). Opt
  out with `--no-pc-crawl` / `--no-pc-fill-upc` / smaller `--pc-limit` / `--hdb-limit`
  for quick runs. Pass 3b is the only pass that grows the record set, so it stays
  on for the golden master.

### Added

- **Title cleanup post-process step (`cleanTitles`, step 1b).** Decodes HTML
  entities (`&amp;`→`&`; ~778 records), straightens smart quotes, strips a leading
  "Funko Pop!"/"Pop!" prefix and a trailing "(Bobble-Head)". Conservative:
  preserves `#numbers`, variant qualifiers, and series-colon names ("Thor:
  Ragnarok", "Soldier: 76") — those are real titles, not noise, and are
  explicitly left intact.

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
