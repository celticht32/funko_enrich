# FunkoDex Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased] — Session 13 — 2026-06-20

PriceCharting end-to-end: catalog enrichment now carries in-box (Complete) market
values, UPCs, and metadata into the app; barcode scan reads the live Couchbase
catalog instead of the bundled seed; a live PriceCharting refresh tier re-scrapes
the stored product page; and import gained UPC-based de-duplication. Channel3's
manual-key UI was hidden (its tiers still run).

### Added

- **PriceCharting market value through the whole pipeline.** The enricher now
  stores `marketValueComplete` (in-box, the primary displayed value) plus
  `releaseDate`, `ebayEpid`, `amazonAsin`, `printRun`, `publisher`, `pcSeries`,
  `pcDescription`, and `pricechartingUrl`. `EnrichedRecord` and `CatalogMapper`
  carry these into the catalog; `FunkoItem` gained `pricechartingUrl`; the catalog
  read seeds `marketAvg` from `marketValueComplete` as a non-manual baseline a
  live refresh or manual value can still override.
- **Scan reads the Couchbase catalog.** New `lookupCatalogByUpc` queries the
  catalog by UPC first (leading-zero tolerant) via a shared `catalogDocToFunkoItem`
  builder, so every imported/enriched record is scannable. The bundled
  `funko_data.json` is now a fallback seed only. Name-search uses the same builder.
- **Live PriceCharting refresh tier** in `PriceService`. When an item carries a
  `pricechartingUrl`, the refresh re-scrapes that exact page (no search, no
  variant-matching risk) and parses the three grade prices from
  `#used_price`/`#complete_price`/`#new_price`. Plain OkHttp works — verified that
  PriceCharting serves the page to an Android-UA GET with no JS challenge. New
  `PRICECHARTING` price source. Runs before the retail short-circuit, since retail
  (MSRP) is not a market value.
- **UPC-based import de-duplication.** `CatalogImporter` builds a UPC→docId index
  and matches handle → UPC → title, so a record finds its existing twin even when
  handles differ (e.g. a PriceCharting-sourced record vs the same Pop under a
  HobbyDB handle) instead of inserting a duplicate.
- **Approximate base-price fallback for unlisted variants** (enricher +
  `marketValueIsApproximate` threaded through the model to the UI). When a
  variant record (e.g. "Krillin (Metallic)") matches the *exact same base figure*
  on PriceCharting that doesn't list the variant separately, it takes the base
  price flagged approximate rather than skipping. An **exact** core-name match is
  required (set-equal, not just covered), so fuller-named different figures like
  "Orange Piccolo" for "Piccolo" or "Robin as Nightwing" for "Robin" are still
  rejected. The Detail screen shows "Market avg (approx)" with a `~` prefix; the
  flag persists on catalog and owned docs. Recovers same-character variants the
  strict gate was skipping without attaching wrong-figure prices.

### Changed

- **Import no longer skips priced-but-incomplete records.** The old "never
  clobber" insert collision now *merges* (fill-only, never overwriting identity)
  via a shared `mergeRecordInto`, so a colliding record contributes its
  price/metadata instead of being dropped. `pricechartingUrl` persists on owned
  items through `FunkoMapper` for later refresh.
- **Channel3 manual-key UI hidden.** `SettingsScreen` gates the Channel3 key row
  and dialog behind `SHOW_CHANNEL3_KEY_UI = false`. The free Channel3 tier and the
  `funkodex_keys.json` import path still work; only the manual key-entry UI is
  suppressed. HobbyDB and eBay OAuth rows left visible (account logins, not keys).

### Notes

- The enricher (`funko_enrich` repo) did all PriceCharting scraping offline via
  Puppeteer; the in-app refresh tier is a lighter OkHttp re-scrape of the already-
  identified page. On-device confirmation of the OkHttp fetch (residential IP) is
  the one thing still to verify by hitting refresh on a real device.

---

## [Unreleased] — Session 12 — 2026-06-19

Pricing accuracy (variant-aware queries), scanner/Add-screen UX, manual-UPC
validation, and two resource-leak fixes (HTTP responses + camera executor).

### Added

- **Manual UPC check-digit validation.** New `util/UpcValidation.kt` validates
  UPC-A (12 digits) and EAN-13 (13 digits) by their modulo-10 check digit. The
  editable manual-UPC field in `ManualAddSheet` shows an error state for a
  malformed non-empty entry and a check-circle + "Valid UPC" affirmation when
  valid; the Add button is disabled on a non-blank invalid UPC. Blank is still
  allowed (UPC is optional).
- **"Enter details manually" button** on the Add-to-Collection start screen
  (`ScannerStartPrompt`) — a third option below "Start scanning" and "Search by
  name," opening the blank manual-add form (`openManualAddBlank`).
- **Clear button on the detail-edit Image URL field** — a trailing ✕ that empties
  the field when non-empty.

### Changed

- **Variant-aware pricing.** `PriceService` appends chase/exclusive search terms
  (via a shared `variantSuffix` helper) to the eBay, HobbyDB, and Channel3 *name*
  queries, so a chase or retailer-exclusive is priced against its own listings
  rather than the common version (which would dominate a mixed result set and
  under-price the variant). eBay queries the variant first and falls back to the
  broad query when the variant query returns fewer than 3 sales. UPC-keyed lookups
  are unchanged.
- **eBay price band ceiling $500 → $5000.** The old cap clipped genuinely valuable
  variants once they were priced correctly; the $3 floor (shipping/junk guard)
  stays.
- **"Add another" goes straight to the camera.** After a save, the confirmation's
  "Add another" calls `startScanning` (live camera) instead of `reset` (the Idle
  chooser). "Done" still resets to Idle.
- **Conditional manual-add subtitle.** Shows "Future scans of this barcode will
  match instantly" only when a UPC is present; otherwise "Enter the Funko's
  details to add it to your collection."
- **UPCitemdb parsing: regex → typed gson.** Reads `lowest_recorded_price` /
  `highest_recorded_price` from a typed model. Removed a `retail` value that was
  scraped from a `price` field that doesn't exist at item level on the trial plan
  (it only appears in `offers[]`, omitted on trial) — so that tier no longer
  reports a bogus retail number.

### Fixed

- **OkHttp response leak in `PriceService`.** All four network calls (eBay,
  HobbyDB, UPCitemdb, Channel3) now wrap the response in `.use {}`. Previously the
  response was never closed on the `!isSuccessful` early-return path, leaking the
  connection. (`FunkoLookupService` already did this correctly.)
- **Camera executor thread leak.** `ScannerScreen` and `PreScanScreen` created a
  `newSingleThreadExecutor()` for the barcode analyzer on every camera start — in
  Scanner, on every `ON_RESUME` — and never shut it down. The executor is now
  created once per composable via `remember` and shut down in `onDispose`.

### Data

- **`funko_data_enriched.json` malformed-UPC salvage.** 10 malformed 11-digit
  UPCs zero-padded to check-digit-valid UPC-A; 57 unrecoverable malformed UPCs
  (8/9/10/14/17-digit) had their `upc` removed (records kept). With-UPC count
  9,440 → 9,383. This file is the manual-import source, not the bundled asset.

### Notes

- **eBay pricing is not broken.** The HTML-scrape parser was verified against a
  live sold-listings page (Pepe #1678) — 67 `s-card__price` spans matched, 57
  valid prices after filters, low $3.25 / median $19.99 / high $400. The 403s
  seen in logs are a fetch-time bot challenge, not a parse failure.
- **Channel3 tier is dormant** (no API key configured) and was left untouched.
  Its parser's flat price-field names (`lowest_price`, etc.) appear stale against
  the current Channel3 API — re-verify against a captured response before relying
  on that tier.



Scanner, manual-add, image-handling, and pricing work, plus a market-value
field and an architecture design document for community catalog distribution.

### Added

**Manual add of items not in the catalog**

- New `ManualAddSheet` (in `ScannerScreen.kt`) reachable from both the
  "Barcode not in catalog" sheet (UPC carried from the scan, locked) and the
  toolbar manual-search sheet (UPC editable). Progressive disclosure: UPC,
  name, owned/want, and a community-share toggle are always visible; Pop!
  number, franchise, category, exclusive flag/retailer, price paid, condition,
  and image URL are behind a "More details" expander. Only name is required.
- `ManualAddInput` + `ScannerViewModel.confirmManualAdd` build a `FunkoItem`
  (id `funko::{upc}` when a UPC is present) and, when share is on and a UPC
  exists, queue a `CatalogContribution` with `source = "USER_MANUAL"`.
- Removed the Funko *item* number from the form per design; the single number
  field is the Pop! box number → `seriesNumber`.

**Image URL entry on manual add and detail edit**

- Manual-add form and the detail-edit screen both gained an editable Image URL
  field. Detail edit auto-re-downloads the thumbnail on save when the URL
  changed (new `force` flag on `ImageBlobRepository.downloadAndStore`, tracked
  via `Editing.originalImageUrl`).

**Manual market value**

- Reused the existing `marketAvg` field, made editable in detail edit
  ("Market value"). New `marketValueIsManual` flag (persisted via
  `FunkoMapper` / `FIELD_MARKET_VALUE_IS_MANUAL`). A manual value is written as
  a top-priority `MANUAL` price snapshot (new `PriceSource.MANUAL`, tier 0) so
  it shows on the price card; cleared values delete the snapshot
  (`FunkoRepository.deletePriceSnapshot`).
- A manual value is a *fallback*: a real market feed (`snapshot.avg > 0`)
  overwrites it and clears the flag. A retail-only hit (avg = 0) does not.

**Community Catalog Distribution architecture design doc**

- `FunkoDex_Catalog_Distribution_Architecture_v1.0.docx` — design only, not
  built. Golden-master bundled base, core/user field split, community GitHub
  hub with dated update packets, monthly client pull, and per-field conflict
  resolution (always / ask / never-update with resettable locks). Five open
  design decisions and a five-phase build sequence. See FUTURE.md.

### Changed

**eBay pricing: RSS feed → HTML sold-listing scrape**

- The `_rss=1` completed-listings feed is retired; the request now fetches the
  normal sold/completed results page with a browser User-Agent and parses
  eBay's current `s-card__price` spans (skips `strikethrough` was-prices,
  filters $3–$500, uses the **median** for the average). `PriceData.kt`
  `EBAY_RSS` display label dropped "(RSS)". NOTE: live testing showed eBay
  returns **403** to the app's request (bot block); the scrape is fragile and
  this remains effectively unresolved — see FUTURE/eBay. Verified the parser
  against a saved results page (35 prices, median ~$20 for Mr. Toad #1496).

**Punctuation-tolerant catalog name search**

- `FunkoLookupService` name search is now token-based: `normalizeForSearch`
  strips non-alphanumerics, `matchesAllTokens` requires every query token to
  appear. "mr toad", "mr. toad", "toad mr" all match "Mr. Toad". Applied to
  both the Couchbase path (longest token as coarse pre-filter) and the JSON
  fallback.

**Scanner: frame-confirmation + retry**

- `BarcodeAnalyzer` now requires the same value on 3 consecutive frames before
  emitting (kills single-frame misreads). Added a "Scan again" button and an
  empty-state to the NotFound sheet; the NotFound search icon moved to the
  trailing position to match the manual-search sheet.

**http→https for all image loads**

- New `util/ImageUrl.kt` `String.toHttpsImageUrl()` upgrades `http://` image
  URLs to `https://` at every `AsyncImage` site and in the blob downloader.
  Fixes "CLEARTEXT communication not permitted" on http image hosts (e.g.
  media.aent-m.com) without weakening the network security policy.

### Fixed

**Manual market value was wiped on refresh (staleDays overflow)**

- `PriceSource.MANUAL`/`USER_PAID` used `staleDays = Int.MAX_VALUE`;
  `LocalDate.plusDays(Int.MAX_VALUE)` overflows past the max year and throws,
  so `PriceSnapshot.isStale` threw and `getResolvedPrice` discarded the
  snapshot → resolved to 0 → overwrote the manual value. Changed to `36_500`
  (100y) and hardened `isStale` to cap the horizon regardless of source value.

**Failed price refresh blanked an existing manual/cached value**

- A null fetch set `Error("No price data available")`, removing the displayed
  price until the screen was re-entered. Now re-resolves and keeps showing the
  cached/manual price, with a transient "No new market data found" note
  (`noNewPriceData` flag).

**Scanner camera black after screen-saver**

- The camera was bound once in `AndroidView`'s factory and never rebound; after
  screen-off/on the preview surface was stale → black screen until exit/re-enter.
  Added a `DisposableEffect` that re-runs `startCamera` on `ON_RESUME`.

**Manual-add form: Save unreachable; deprecated/unresolved API**

- Made the `ManualAddSheet` column scrollable so Save is always reachable when
  "More details" is expanded.
- `Modifier.menuAnchor()` (deprecated) → `menuAnchor(MenuAnchorType.PrimaryNotEditable)`.
  NOTE: the typed enum is `MenuAnchorType` in material3 1.3.0 — NOT
  `ExposedDropdownMenuAnchorType` (that's the 1.4.0+ name, which failed to
  resolve). Also fixed the same deprecation in `DetailScreen.kt`. See
  LESSONS_LEARNED #30.

---

## [Unreleased] — Session 10 — 2026-06-13

### Changed

**UPC is now set by camera scan only — manual entry removed everywhere**

- Hand-typing a UPC from the printed box text stored a wrong value: the
  human-readable digits under a barcode commonly omit the leading number-system
  digit and the trailing check digit (e.g. box shows "89698 21921" but the
  real UPC-A is `889698219211`). A hand-typed short value fails exact-match
  duplicate detection and would propagate a bad UPC to the community database.
- `DetailScreen.kt` — the edit-screen UPC field is now `readOnly`; the only
  way to set it is the scan icon (camera → `UpcScanDialog`). Caption notes
  "UPC can only be set by scanning the barcode."
- `ScannerScreen.kt` — removed the manual UPC text field from the scanner's
  "not found" sheet; name-search remains as the recovery path when a barcode
  can't be read.

**Detail screen — removed the "Funko ID" row**

- `funkoId` is an internal product-ID/slug populated only when a lookup
  source supplies it, so it was blank ("—") for most items and added no
  collector-facing value. Removed the `DetailRow("Funko ID", …)` from the
  Detail screen. The `funkoId` field remains in the model and is still
  stored/matched against — only the display row was removed.

### Fixed

**Catalog name search returned nothing once category prefs were seeded**

- `CategoryPreferenceRepository.getEnabledCategories()` returned category
  *display names* ("Pop! Disney"), but the search filter in `FunkoLookupService`
  compares category *keys* (`toKey(item.category)` → "pop_disney"). Names never
  equal keys, so the filter silently dropped every result. Because the app
  auto-seeds all categories as enabled on first run (`ensureDefaults`, marker
  `system::cat_prefs_seeded_v3`), the enabled set is never empty — so this broke
  catalog search for effectively every user, not just those who used the filter.
- Fix: `getEnabledCategories()` now derives the key from the doc ID
  (`cat_pref::{key}`), so the enabled set holds keys that match the filter.

**Catalog items with blank/unrecognized categories were hidden from search**

- The category filter hid any item whose `toKey(category)` wasn't in the enabled
  set — which silently dropped items with a blank category or a category not in
  the canonical list (e.g. enriched records whose series tags had no clean
  "Pop! X" line, like "Papa V Perpetua" → series `["Pop! Vinyl","Music"]` →
  category "").
- `FunkoLookupService.searchByName` now hides an item only when its category is
  a RECOGNIZED Pop! line that is explicitly disabled; blank/unknown categories
  pass through.

**Catalog image not backfilled on re-import for items created without one**

- `CatalogImporter` merge path wrote enriched fields but never `imageUrl`, to
  avoid clobbering a good HobbyDB image. Side effect: a doc first created with a
  blank image stayed imageless across all re-imports.
- On update, `imageUrl` is now filled from the record only when the existing
  doc's image is blank (mirrors the existing fill-if-blank UPC pattern) — never
  overwrites a present image.

**"Fetch from catalog" couldn't recover an item with a blank image URL**

- `DetailViewModel.fetchImageFromCatalog` bailed immediately when the item's own
  `imageUrl` was empty. It now resolves a URL from the linked catalog doc
  (`catalogRef` → `imageUrl`, then `funkoImageUrl` fallback), persists it onto
  the item, then downloads — so a blank-image item can recover without a full
  re-import.

**"Fetch from catalog" failures now report the real cause**

- The fetch error was a generic "could not download… no internet / not available
  / exceeds 600KB" list. `ImageBlobRepository` now returns a specific result
  (`Success`, `HttpError(code)`, `TooLarge(bytes)`, `NetworkError`, etc.) and the
  dialog shows the actual reason — e.g. a dead HobbyDB URL now reports a clear
  404 instead of three guesses. Also fixed a latent PNG magic-byte check
  (`bytes[0] == 0x89`). The legacy `downloadAndStore(): Boolean` is preserved for
  fire-and-forget callers.

**Detail screen — Category never displayed; Series mis-imported as "Funko"**

- Two linked problems. (1) The edit form had no Category control and the
  ViewModel had no `updateCategory`, so a scanned item's category could
  never be set or corrected by hand — it showed blank on the Detail screen.
  (2) The Channel3 lookup mapper fell back to `brand` when no `series`
  attribute was returned (`franchise = attributes?.get("series") ?: brand`),
  writing the manufacturer "Funko" into the Series field on every scan that
  lacked taxonomy.
- `FunkoLookupService.kt` — dropped the `brand` fallback; Series is left
  blank when the source has no real series, rather than falsely set to "Funko".
- `DetailViewModel.kt` — added `updateCategory`, which sets `category` and
  re-derives `genre` via `FunkoGenre.fromCategory`.
- `DetailScreen.kt` — added a grouped Category dropdown (driven by
  `FunkoCategories.ALL`), a read-only Genre row on both Detail and edit that
  updates live with category, relabeled Series with a hint, and an info-icon
  explainer describing Series vs Category vs Genre.

**Catalog refresh — "Refresh now" gave no feedback; "Last refreshed" never shown**

- `CatalogRefreshWorker` wrote its timestamp to the catalog marker document,
  but nothing wrote `LAST_REFRESH_KEY` into the settings DataStore the UI
  reads, so the "Last refreshed" line never rendered and the button appeared
  to do nothing.
- `CatalogRefreshWorker.kt::runNow` now returns the enqueued request UUID.
- `CatalogSettingsViewModel.kt` — `refreshNow` observes the worker via
  `getWorkInfoByIdFlow`, writes today's date to the DataStore on success, and
  exposes a `RefreshUiState` (Running / UpToDate / Added / Failed).
- `SettingsScreen.kt` — inline status text by the button: "Refreshing…",
  then "Catalog already up to date" / "Added N new records" / "Refresh failed".
- `libs.versions.toml` — WorkManager bumped 2.9.1 → 2.10.1 for
  `getWorkInfoByIdFlow`.

### Testing

**Device test 7 (App performance) — PASS**

- Verified on device (Galaxy S23, SM-S911U). Performance acceptable —
  responsive in normal use, no notable jank observed.

**Reports — "Est. Market Value" and "Total Retail Value" always showed $0.00**

- Root cause: `FunkoItem.marketAvg` and `retailPrice` were only ever *read*
  into `CollectionStats` (`totalMarketValue` / `totalRetailValue`), never
  *written*. `DetailViewModel.refreshPrices` resolved a `ResolvedPrice` for
  display on the Detail screen's "Market Price" card but never persisted any
  of it back onto the saved `FunkoItem` document — so per-item and aggregate
  totals stayed at their defaults regardless of what the Detail screen showed.
- `DetailViewModel.kt::refreshPrices` — after resolving a price, if
  `resolved.marketAvg` or `resolved.retail` differ from the stored values,
  `repository.saveItem(item.copy(marketAvg = ..., resolvedRetail = ...))` and
  update `_state` so the UI reflects the persisted values immediately.
- **On-device result:** Stitch with Frog (UPC `889698517959`) — Market avg
  $37.94 / Retail $26.93 (UPCitemdb) now persist to the item record; Reports
  "Est. Market Value", "Highest Market Value", and series "Value" all show
  $37.94 after a price refresh.

**Reports — stats not recomputed after returning from Detail screen**

- `ReportsViewModel.refresh()` only ran once in `init {}`. Refreshing a
  price on the Detail screen and navigating back to Reports showed the
  stale `CollectionStats` snapshot from before the refresh.
- `ReportsScreen.kt` — added a `DisposableEffect` + `LifecycleEventObserver`
  that calls `viewModel.refresh()` on `ON_RESUME`, so reopening the Reports
  tab recomputes stats.

**"Total Retail Value" — new `resolvedRetail` field, distinct from catalog
`retailPrice`**

- `item.retailPrice` is catalog-sourced Funko MSRP and also gates
  `PriceService` Tier 1 (a non-zero `retailPrice` short-circuits the entire
  price waterfall on every future refresh, returning `source =
  RETAIL_CATALOG`). Writing a marketplace-resolved retail value (e.g. from
  UPCitemdb) into `retailPrice` would mislabel its provenance and disable
  eBay/Channel3/HobbyDB tiers for that item permanently.
- Added `FunkoItem.resolvedRetail: Double = 0.0` — the best "retail" figure
  from the price waterfall, refreshed independently of catalog data — plus
  `FunkoItem.effectiveRetail` (`retailPrice` if > 0, else `resolvedRetail`).
  All "retail" *display/total* sites now use `effectiveRetail`:
  `FunkoRepository.totalRetailValue`, `DetailScreen`'s Pricing card,
  `ReportsScreen`'s per-series item rows, `PreScanScreen`'s preview label,
  and every retail column/sum in `CollectionExporter` (xlsx + CSV).
  Catalog-input contexts (`ScannerScreen`/`ScannerViewModel` price-paid
  defaults) intentionally continue to use `retailPrice` (catalog MSRP),
  unchanged.
- `FunkoDexDatabase.FIELD_RESOLVED_RETAIL = "resolvedRetail"` /
  `FunkoMapper` — persist/read the new field.

**"I only have the variant — want the original" control looked like static
text, not a button**

- `DetailScreen.kt` — the variant-only flag control (shown for owned items
  not yet flagged) was a `TextButton` with no visible chrome, indistinguishable
  from a label. Changed to `OutlinedButton` so it reads as tappable, matching
  the outlined style of the "FYE Exclusive" chip above it.

### Changed

**Deprecation cleanup (Material icons, CBL, CameraX, Vibrator)**

- `DetailScreen.kt`, `CategoryFilterScreen.kt` — `Icons.Default.ArrowBack` →
  `Icons.AutoMirrored.Filled.ArrowBack` (with the corresponding
  `androidx.compose.material.icons.automirrored.filled.ArrowBack` import —
  `Icons.AutoMirrored` is not a member of the wildcard
  `androidx.compose.material.icons.filled.*` import and needs its own import
  to resolve).
- `PreScanScreen.kt` — `Icons.Default.HelpOutline` →
  `Icons.AutoMirrored.Filled.HelpOutline` (+ import).
- `DetailViewModel.kt` — `db.getDatabase().getDocument(id)` /
  `db.getDatabase().save(doc)` (deprecated CBL 3.x `Database` API) →
  `db.getCollection().getDocument(id)` / `db.getCollection().save(doc)`,
  matching the default-collection convention already used throughout
  `FunkoRepository`.
- `FunkoRepository.kt` — `query.removeChangeListener(token)` (deprecated) →
  `token.remove()` in both `collectionFlow()` and `wantListFlow()`.
- `ScannerScreen.kt` —
  - `@OptIn(ExperimentalGetImage::class)` on `startCamera` removed: this
    CameraX version's `ExperimentalGetImage` is not a `@RequiresOptIn` marker,
    so the `@OptIn` was a no-op flagged by the compiler ("annotation ... is
    not annotated with '@OptIn'. '@OptIn' has no effect."). `ImageProxy.image`
    is not used in this file, so no opt-in is actually required.
  - Legacy haptic fallback (`Vibrator.vibrate(Long)`, API < 31) — the
    `@Suppress("DEPRECATION")` only covered the `val v = ...` declaration, not
    the separate `v?.vibrate(50)` call. Wrapped both in a `run { }` block under
    one `@Suppress("DEPRECATION")`.

---

### Fixed

**Wiring gaps from Session 8 handoff (commits `74c5616`, `6f2c523`)**

- **`ReportsScreen.kt`** — was referenced/imported by `FunkoDexNavHost.kt` but
  absent from the repo (local-only file from a prior session). Created
  `ui/screens/reports/ReportsScreen.kt` and `ReportsViewModel.kt`: summary
  stat cards (owned/want-list/franchises/market value), cost breakdown card,
  `ExportButton()`, per-series completion cards with expandable want-list
  rows, and the existing `REPORTS_EMPTY`/`REPORTS_MARKET_NOTE` help strings
  (previously dead). Unblocked test item **A9**.
- **`CatalogDataSection`** — was defined in `SettingsScreen.kt` but never
  invoked, so the Channel3 API key dialog, HobbyDB/eBay OAuth connect rows,
  and the catalog auto-refresh controls (interval, Wi-Fi-only, "Refresh now")
  were unreachable. Wired into the "Catalog" section of `SettingsScreen`,
  reusing the existing `catalogSettingsViewModel` instance. Unblocked test
  items **B1, B2, B3, B6**.
- **`.gitignore`** — a blanket `reports/` rule (intended for
  `app/build/reports/` Gradle test output) was also matching the new
  `ui/screens/reports/` source package, silently excluding it from `git add`.
  Narrowed to `app/build/reports/`.

**Enriched catalog import — JSON parse failure (`ArrayList cannot be cast to
java.lang.Void`)**

- Root cause: Gson's reflective `TypeToken<List<EnrichedRecord>>` binding
  mis-resolved the `EnrichedRecord` data class's field types under Kotlin's
  emitted bytecode/metadata, throwing on every import attempt regardless of
  field nullability (verified both nullable and non-nullable `List<String>`
  variants parse correctly via plain Java + Gson 2.11.0 reflection — the
  failure is Kotlin-bytecode-specific and not reproducible with `kotlinc`
  unavailable in the sandbox).
- Fix: `CatalogImporter.importFromUri` no longer uses
  `gson.fromJson(json, TypeToken<List<EnrichedRecord>>)`. Parses the JSON tree
  (`JsonParser` → `JsonArray` → `JsonObject`) and maps each object to
  `EnrichedRecord` via explicit field-by-field extension functions
  (`optString`/`optBoolean`/`optStringList`), bypassing Gson's reflective
  `TypeAdapter` entirely. Validated against the full 14,314-record
  `funko_data_enriched.json` with a standalone Gson 2.11.0 build (compiled
  from source in-sandbox) — all records parse, including `series` arrays and
  null `available`/`funkoNumber` fields.
- `EnrichedRecord.kt` — `series: List<String>? = null` → `series: List<String>
  = emptyList()` (the tree parser always supplies a list, never null); removed
  now-redundant `?: emptyList()` elsis at the three call sites and the
  now-unused `gson`/`Gson`/`TypeToken` members/imports in `CatalogImporter.kt`.
- **On-device result (full 14,314-record file, first run):** 13,585 enriched,
  725 added, 4 skipped, 0 errors, completed in 51s — matches
  `HANDOFF.md`'s "~13,583 enriched, ~725 added, ~4 skipped" expectation from
  the 2026-06-12 dry-run estimate. **D1b confirmed PASS.**

**Catalog category data bug — "Pop! Vinyl" stored as `category`, hiding 714
records from search**

- `CatalogMapper.mapRecord`'s `category` field picked the first series tag
  starting with `"Pop!"`, including the generic format descriptor `"Pop!
  Vinyl"`. For the 729 funko.com-sourced `.html`-handle records (series like
  `["Pop! Vinyl", "Music"]`), this produced `category = "Pop! Vinyl"` for 714
  of them — a value that doesn't correspond to any entry in
  `FunkoCategories.ALL`.
- `FunkoLookupService.searchByName`'s category filter compared
  `item.category.contains(key)` where `key` is a normalized slug (e.g.
  `pop_music`) and `item.category` is a display string (e.g. `"Pop! Music"`)
  — `"Pop! Music".contains("pop_music")` is always `false`. Every catalog
  search result was being silently dropped by this filter unless
  `item.category` was empty (the only path that passed).
- Fixes:
  - `CatalogMapper.kt` — `category` selection now excludes `"Pop! Vinyl"` and
    bare `"Pop!"`, mirroring the existing `primarySeries` exclusion. Falls
    back to `""` (uncategorized) when no real Pop! category tag is present.
  - `FunkoLookupService.kt` — category filter now normalizes
    `item.category` via the canonical `FunkoCategories.toKey()` before
    checking set membership against `enabled` (which holds keys, not display
    strings).
  - `CatalogImporter.kt` (merge path) — if an existing doc's stored
    `category` is `"Pop! Vinyl"`, recompute from the record's series and
    overwrite, so **re-running the import self-heals previously-inserted bad
    categories** without a catalog wipe.
- **On-device result (re-import after fix):** 14,310 updated, 0 added, 4
  skipped, completed in 47s — confirms all 14,310 records now match by
  handle (idempotent) and the 714 bad categories were repaired. Verified
  `Search Catalog → "perpetua"` now returns "Papa V Perpetua · Music" (was
  previously zero results).

**File picker — enriched catalog import defaulted away from Downloads**

- `SettingsScreen.kt` — added `OpenDocumentInDownloads`, a small
  `ActivityResultContracts.OpenDocument` subclass that sets
  `EXTRA_INITIAL_URI` to the AOSP Downloads root
  (`DocumentsContract.buildDocumentUri("com.android.providers.downloads.documents",
  "downloads")`, API 26+, matches minSdk 26) so the "Import Enriched Catalog"
  picker opens directly in Downloads instead of the picker's default location.
  Most pickers (incl. AOSP DocumentsUI) honor this; some OEM pickers may
  ignore it.

### Changed

**Deprecation cleanup (Material icons + CBL)**

- `ReportsScreen.kt` — `Icons.Default.TrendingUp` (deprecated, no
  `AutoMirrored` equivalent exists) → `Icons.Default.AttachMoney` for the
  "Market Value" stat card.
- `SettingsScreen.kt` — `Icons.Default.Logout` →
  `Icons.AutoMirrored.Filled.Logout` (Disconnect Google Drive row).
- `FunkoLookupService.kt` — `db.getDatabase().getDocument(docId)` (deprecated
  in the CBL 3.x Collection API) → `db.getCollection().getDocument(docId)`,
  matching the Session 7 Collection API migration pattern already used in
  `CatalogImporter`.

### Commits
`74c5616`, `6f2c523`, `4e6759d`, `d69a4ec`

---

## [Unreleased] — Session 8 — 2026-06-12

### Changed

**Keystore / security-crypto Migration (Play P2 — Session E)**

`SecureKeyStore.kt` rewritten to remove the dependency on
`androidx.security:security-crypto`, which was pinned at `1.1.0-alpha06` —
verified via web search to be the latest available release with no stable
1.1.0 ever published (open Google issue tracker requests for a stable release
and for clearer deprecation signaling).

- New implementation: AES-256-GCM key generated directly in `AndroidKeyStore`
  (alias `funkodex_secure_key`, `PURPOSE_ENCRYPT or PURPOSE_DECRYPT`,
  `BLOCK_MODE_GCM`, `ENCRYPTION_PADDING_NONE`, 256-bit, randomized).
- Ciphertext stored as `base64(iv):base64(ciphertext)` strings in a plain
  `SharedPreferences` file `funkodex_secure_prefs_v2`.
- Public API of `SecureKeyStore` is unchanged — all 12 calling files
  (`OAuthCallbackActivity`, `OAuthConfig`, `OAuthLauncher`,
  `TokenRefreshManager`, `DriveBackupWorker`, `CatalogRefreshWorker`,
  `AppModule`, `FunkoLookupService`, `PriceService`, `HmacKeyStore`,
  `CatalogSettingsViewModel`, `SettingsViewModel`) required no edits.
- `app/build.gradle.kts` and `gradle/libs.versions.toml` — removed
  `security-crypto` dependency and version entry entirely.
- `HmacKeyStore.kt`, `TokenRefreshManager.kt`, `PriceService.kt`,
  `FunkoLookupService.kt`, `app/build.gradle.kts` — updated stale doc
  comments referencing "EncryptedSharedPreferences" to describe the new
  AES/GCM Keystore wrapper.

**No migration from old encrypted prefs (deliberate, user-approved tradeoff):**
The old `funkodex_secure_prefs` (EncryptedSharedPreferences) file is abandoned
on disk — still encrypted, inert, never read or deleted. On upgrade, users
will need to re-enter their Channel3 API key and re-link HobbyDB/eBay accounts
once. A migration shim was drafted but rejected because it would have required
keeping `security-crypto` as a dependency solely to read the old file once,
defeating the purpose of the migration.

### Outstanding
- Device verification: confirm Channel3 key entry, HobbyDB link, and eBay
  link all round-trip correctly through the new AES/GCM wrapper on a real
  device (hardware Keystore behavior not verified by compile/run alone)
- Carried over from Sessions 5–7: full Session 7 functional/device test pass
  (`SESSION_D_TRACKER.md`), unit test suites, Cloud Console OAuth client,
  device tests T-D1–T-D5, Photo Picker smoke test, 16 KB emulator regression

---

## [Unreleased] — Session 7 — 2026-06-12

### Changed

**CBL Collection API Migration (Play P2 — Session D)**

Migrated all database-level Couchbase Lite calls to the Collection API ahead
of CBL 4.x. `database.defaultCollection` (non-null — the default collection
always exists and cannot be deleted) replaces direct `Database` access for
document and query operations:

- `database.getDocument/save/delete` → `collection.getDocument/save/delete`
- `database.createQuery(...)`, `DataSource.database(db)` → `DataSource.collection(col)`
- `database.createIndex(name, index)` → `collection.createIndex(name, index)`
  (same `IndexBuilder`/`ValueIndexItem` signature)
- `database.inBatch(UnitOfWork {...})` — **unchanged**, remains
  database-level (transaction wrapper, not deprecated, not moved to
  Collection in 3.2.x). Operations inside the lambda convert to `collection.X`.

`FunkoDexDatabase.kt` — added `fun getCollection(): com.couchbase.lite.Collection
= getDatabase().defaultCollection`. Return type is fully-qualified to avoid
`kotlin.collections.Collection<T>` shadowing from the implicit Kotlin
collections import (this caused a cascade of ~50 "Unresolved reference"
errors on first attempt — see Lessons Learned below).

12 files converted (~98 call sites):
- `data/db/FunkoDexDatabase.kt` — added `getCollection()`; `ensureIndexes()` (12 sites)
- `data/repository/FunkoRepository.kt` (21 sites)
- `data/repository/AlertRepository.kt` (10 sites)
- `data/repository/ContributionRepository.kt` (8 sites)
- `data/repository/CategoryPreferenceRepository.kt` (16 sites; `inBatch` × 3 stays on `database`)
- `data/repository/ImageBlobRepository.kt` (3 sites)
- `data/preload/CatalogPreloader.kt` (8 sites; `ensureCatalogIndexes` now takes a `Collection` param)
- `data/preload/CatalogImporter.kt` (8 sites; `buildTitleIndex` now takes a `Collection` param)
- `data/preload/CatalogRefreshWorker.kt` (12 sites across 3 functions; `inBatch` × 3 stays on `database`)
- `network/FunkoLookupService.kt` (2 sites)
- `network/ConnectivityObserver.kt` (7 sites)
- `ui/screens/settings/DatabaseTransferViewModel.kt` (export/import/force-restore)

**Force-restore care (`DatabaseTransferViewModel.forceRestoreDatabase`)** —
`db.close()` → wipe `funkodex.cblite2` directory → `db.reopen()` → `liveCollection
= db.getCollection()` obtained AFTER reopen, so it derives from the fresh
`Database` instance via `getDatabase().defaultCollection` rather than a stale
reference.

### Lessons Learned
- `fun getCollection(): Collection` (unqualified) resolves to
  `kotlin.collections.Collection<T>` in files with `import com.couchbase.lite.*`
  — Kotlin's implicit `kotlin.collections.*` import wins. Always fully-qualify
  as `com.couchbase.lite.Collection` for any function/parameter signature named
  `Collection`. One bad declaration cascaded into ~50 compiler errors across
  3 files on first attempt.

### Outstanding
- Full functional/device test pass — see `SESSION_D_TRACKER.md` checklist.
  Backup/restore/force-restore is highest priority given the `inBatch`/
  `reopen()` interaction above.
- All unit test suites (FunkoMapperTest, CollectionStatsTest, FunkoLookupServiceTest, `./gradlew test`)
- 16 KB emulator regression re-run (CBL access patterns changed)
- Carried over from Sessions 5–6: Cloud Console OAuth client, device tests
  T-D1–T-D5, Photo Picker smoke test

---

## [Unreleased] — Session 6 — 2026-06-12

### Changed

**Photo Picker Migration (Play P1)**
- `DetailScreen.kt` — replaced `ActivityResultContracts.GetContent()` with
  `ActivityResultContracts.PickVisualMedia()` + `PickVisualMediaRequest(ImageOnly)`
  for the "Choose from gallery" flow
- Removed the `READ_MEDIA_IMAGES`/`READ_EXTERNAL_STORAGE` runtime permission gate
  (`storagePermission` block) — Photo Picker requires no storage permission
- `AndroidManifest.xml` — removed `READ_MEDIA_IMAGES` and `READ_EXTERNAL_STORAGE`
  permissions entirely (addresses Play Photo and Video Permissions policy)
- Removed now-unused `android.os.Build` import from `DetailScreen.kt`

**P3 Deprecation Cleanup**
- `app/build.gradle.kts` — replaced deprecated `kotlinOptions { jvmTarget = "17" }`
  with `kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }`
- `CollectionScreen.kt` — replaced `com.google.accompanist.flowlayout.FlowRow`
  (`mainAxisSpacing`) with Compose Foundation `FlowRow`
  (`horizontalArrangement = Arrangement.spacedBy(8.dp)`,
  `@OptIn(ExperimentalLayoutApi::class)`); removed `accompanist-flowlayout`
  dependency and version-catalog entry entirely
- `Icons.Default.ArrowBack`/`Icons.Default.Logout` — left unchanged.
  `Icons.AutoMirrored.Filled.*` variants did not resolve against the current
  `compose-bom` (2024.09.00); reverted after compile failure rather than bump
  the BOM for this alone

### Outstanding
- Photo Picker smoke test: gallery pick on API 33+ and API 26–32
- Cloud Console OAuth client + device tests T-D1–T-D5 (carried over from Session 5)

---

## [Unreleased] — Session 5 — 2026-06-12

### Changed

**16 KB Page Size Compliance (Play P0)**
- Bumped `couchbase-lite` 3.2.1 → 3.2.4 (16 KB-aligned `libLiteCore.so`/`libLiteCoreJNI.so`,
  per Couchbase engineering confirmation)
- Bumped `camerax` 1.3.4 → 1.6.1 (16 KB-aligned `libimage_processing_util_jni.so`/
  `libsurface_util_jni.so`)
- `ScannerScreen.kt` / `PreScanScreen.kt` — replaced deprecated
  `ImageAnalysis.Builder().setTargetResolution(Size(1280,720))` with
  `ResolutionSelector`/`ResolutionStrategy(FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)`
- Fixed broken unit test: `ScannerViewModelStateTest.kt` referenced a non-existent
  `selectManualResult()`; replaced with a test of the actual implemented flow
  (`toggleManualSelection` + `confirmBulkAdd` → `ScanState.Saved`)
- Verified via Analyze APK on release build: all `.so` files across all ABIs
  (arm64-v8a, armeabi-v7a, x86, x86_64) — including the previously-contested
  `libbarhopper_v3.so` (ML Kit barcode 17.3.0) — report 16 KB alignment. No
  fallback to `play-services-mlkit-barcode-scanning` needed.
- Smoke-tested on a 16 KB-page-size emulator (catalog preload, barcode scan,
  photo capture) — no errors

**Google Drive Auth Migration (Play P1)**
- Replaced deprecated `GoogleSignIn`/`GoogleAccountCredential` with
  `AuthorizationClient` (DRIVE_FILE scope) — authorization-only, no Credential
  Manager dependency (see `docs/CredentialManager_Migration_SPEC.md`)
- New `data/backup/DriveAuthManager.kt` — single owner of `AuthorizationClient`
  interaction; normalizes results to `Authorized`/`NeedsConsent`/`Failed`
- `SecureKeyStore.kt` — added `isDriveConnected()`/`setDriveConnected()`/
  `clearDriveConnected()` boolean flag; no access token persisted (1h lifetime,
  re-`authorize()` each use)
- `DriveBackupWorker.kt` — worker calls `authorize()` every run; `NeedsConsent`
  → reconnect notification (id 3002), skip without retry; 401/403 mid-flight →
  `clearToken()` + `Result.retry()`
- `SettingsViewModel.kt` — `driveConnected` StateFlow, `connectDrive()`,
  `onConsentResult()`, `disconnectDrive()`, consent `PendingIntent` StateFlow
- `SettingsScreen.kt` — "Connect Google Drive" / "Connected · Tap to back up now"
  / "Disconnect Google Drive" rows; dropped "Signed in as {email}" (no identity
  in AuthorizationResult by design); disconnect cancels periodic worker, connect
  re-schedules it (`ExistingPeriodicWorkPolicy.UPDATE`, idempotent)
- Bumped `play-services-auth` 21.2.0 → 21.6.0; added
  `kotlinx-coroutines-play-services` for `Task.await()`
- Zero remaining references to `GoogleSignIn`/`GoogleAccountCredential`

### Outstanding
- Cloud Console: confirm Android OAuth client ID (`com.funkodex` + signing SHA-1)
- Device tests T-D1–T-D5 (`docs/CredentialManager_Migration_SPEC.md` §9),
  especially T-D3 (lapsed grant)

---

## [Unreleased] — Session 4 — 2026-06-12

### Added

**Enriched Catalog Import**
- Settings → Catalog → "Import Enriched Catalog" — user picks `funko_data_enriched.json`
  via file picker, merges into the live Couchbase catalog
- `EnrichedRecord.kt` — Gson deserialization target for the enriched JSON superset
- `CatalogImporter.kt` — handle-match → normalized-title fallback (ambiguous titles
  excluded) → merge or insert
- Merge path writes only new enriched fields (`isAvailable`, `productUrl`,
  `funkoImageUrl`, `funkoShopId`, `funkoNumber`, `popType`, `retailPrice`,
  `marketValueLoose/New`, `pricechartingId/Url`); never overwrites `imageUrl`, `title`,
  `handle`, `seriesList`; UPC written only if missing
- Insert path applies non-Pop merchandise filter, repairs funko.com page-name handles
  (`NNNNN.html` → title slug), and skips on docId collision (never-clobber guard)
- `CatalogMapper.kt` — added `FIELD_FUNKO_NUMBER`, `FIELD_POP_TYPE` and corresponding
  `mapRecord()` parameters
- Progress dialog (live record counter) and result summary dialog
  (enriched/added/skipped/errors/duration)
- `DEVICE_TEST_PLAN.md` — added Test 9 for on-device import verification

---

## [Unreleased] — Session 3 — 2026-06-04

### Added

**Variant System**
- `FunkoVariant` data class — id, note, photo (ByteArray), pricePaid, condition, dateAdded
- `FunkoItem.variants: List<FunkoVariant>` — variants stored on parent record, not as separate collection entries
- `FunkoItem.isVariant`, `variantNote`, `isMissingOriginal` flags
- Variants serialized as base64 JSON string in `FIELD_VARIANTS` Couchbase field
- Collection stats (totalOwned, totalPaid, ownedCount per series) sum across parent + variants
- Variant count badge on collection card — green when all have photos, red with camera icon when any are missing
- "NO ORIGINAL" badge on collection card (bottom-left) when `isMissingOriginal = true`
- Detail screen variants section — shows each variant with photo thumbnail or red "No photo" placeholder
- Edit screen variants section — editable note, price, delete per variant
- "Got it!" chip at top of detail screen when `isMissingOriginal = true` — opens confirmation dialog, enters edit mode

**Photo System**
- Single camera FAB on edit screen replaces three-button row
- Bottom sheet with three options: Take a photo, Choose from gallery, Fetch from catalog
- Photo target sheet — Main photo / Variation photo / Both after taking/choosing
- `fetchImageFromCatalog` — downloads official Funko image from catalog URL with status dialog (Fetching / Success / Failed with URL shown)
- `userPhoto` field added to `FunkoItem` and read in collection flow — user photos now show on collection card
- Collection card image priority: official URL first → user photo on error → thumbnail blob
- `FunkoMapper.toDocument` uses `existing?.toMutable()` to preserve blobs on save

**Add Flow**
- Nav bar "Add" label (was "Scan")
- `SavedConfirmation` screen after bulk add — "Add another", "I only have the variant — want the original", "Done"
- `AlreadyOwned` bottom sheet — "I have a variant", "I have a variant but NOT the original", "Update existing", Cancel
- Duplicate detection in `confirmBulkAdd` via `findOwnedByNameAndFranchise`
- `markVariantMissingOriginal` — flags item from add confirmation screen

**Detail Screen**
- All fields shown in view mode matching edit screen: Name, Series, Number, Category, Condition, Price paid, UPC, Funko ID, Date added, Notes
- "I only have the variant — want the original" text button in view mode
- UPC field in edit screen with manual entry and barcode scan (camera dialog)
- UPC contribution prompt after saving a new or corrected UPC
- Pending UPC contribution cancelled automatically on item delete or UPC change

**Reports**
- Three-tab layout: Have, Want, Combined — each a focused standalone report
- Have: collection summary + series breakdown with costs
- Want: want list summary + individual items including missing originals
- Combined: series completion bars + expandable want list per series
- Export CSV FAB saves current tab to Downloads as `FunkoDex_Have/Want/Combined_Report_YYYYMMDD.csv`
- `totalWanted` includes missing originals
- `isMissingOriginal` items appear in Want report as "[Name] (original)"

**Backup / Restore**
- Complete overhaul — JSON-based export/import (no Couchbase file copying)
- Export: queries all non-catalog, non-system docs, serializes to JSON with blobs as base64, zips as `FunkoDex_backup_YYYYMMDD_HHmmss.zip`
- Export saves to Downloads automatically AND shows share sheet as optional
- Restore: extracts JSON, deletes non-catalog/non-system docs, reinserts — no file locking, no restart needed
- Old-format backup detection with clear error message
- Force restore option — wipes entire database including catalog, rebuilds from backup + re-preloads catalog on next start
- Restore confirmation dialog shows file location hint
- Success/failure dialogs with clear messaging
- `takePersistableUriPermission` for file picker URI

**Settings**
- Force restore (corrupt database) option in Backup section
- Category filter now correctly applied to catalog search results (was only applied to collection display)
- `system` type added to marker documents — preserved through backup/restore
- `ensureDefaults` re-seeds category prefs if marker exists but docs were wiped (e.g. post-restore)

**System Splash**
- Celtic heart icon from `celticht.svg` (verbatim path data) centered in Android 12 system splash circle
- Navy background matching Compose splash
- Scale 0.5641 — calculated to fit 116.99×108.79 viewBox into 66dp safe zone

**Community Contributions**
- UPC contribution prompt after saving new or corrected UPC in detail edit
- Contribution auto-cancelled when item deleted or UPC changed before upload
- `deletePendingContribution`, `hasPendingContribution` added to `ContributionRepository`

### Changed

- Splash minimum display time: 4200ms (was 3600ms)
- `FunkoDexDatabase._database` changed from `lazy val` to nullable `var` to support force restore reopen
- Backup filename includes timestamp: `FunkoDex_backup_YYYYMMDD_HHmmss.zip`
- `AlreadyOwned` sheet redesigned as bottom sheet with clear variant options
- `SavedConfirmation` buttons: "Add another" (was "Scan another"), "Done"
- Detail view Pricing card simplified — Price paid moved into Details card
- Separate Notes card removed — Notes inline in Details card
- Want report "Items wanted" count includes missing originals

### Fixed

- `fetchImageFromCatalog` was checking `Viewing` state only — now checks `Editing` state too
- `addVariantPhoto` in edit mode now updates draft instead of saving mid-edit
- `removeVariant` now explicitly removes `FIELD_VARIANTS` field when list becomes empty
- `isMissingOriginal` and `isVariant` now use `remove` + conditional set to reliably clear `true` values
- `confirmBulkAdd` returns `Saved` state correctly after successful add
- `clearMissingOriginal` enters edit mode directly instead of silently saving
- Category filter applied to `searchByName` in `FunkoLookupService` (was only applied to collection display)
- Collection card `error` parameter added — falls back to `userPhoto` when `imageUrl` fails to load
- `FunkoMapper.toDocument` preserves existing blobs via `existing?.toMutable()`
- System and catalog marker documents preserved through backup/restore via `type = "system"`

### Files Changed

```
app/src/main/java/com/funkodex/data/model/FunkoItem.kt
app/src/main/java/com/funkodex/data/db/FunkoDexDatabase.kt
app/src/main/java/com/funkodex/data/db/FunkoMapper.kt
app/src/main/java/com/funkodex/data/repository/FunkoRepository.kt
app/src/main/java/com/funkodex/data/repository/CategoryPreferenceRepository.kt
app/src/main/java/com/funkodex/data/repository/ContributionRepository.kt
app/src/main/java/com/funkodex/data/repository/ImageBlobRepository.kt
app/src/main/java/com/funkodex/data/preload/CatalogPreloader.kt
app/src/main/java/com/funkodex/network/FunkoLookupService.kt
app/src/main/java/com/funkodex/ui/FunkoDexNavHost.kt
app/src/main/java/com/funkodex/ui/screens/SplashScreen.kt
app/src/main/java/com/funkodex/ui/screens/SplashViewModel.kt
app/src/main/java/com/funkodex/ui/screens/collection/CollectionScreen.kt
app/src/main/java/com/funkodex/ui/screens/detail/DetailScreen.kt
app/src/main/java/com/funkodex/ui/screens/detail/DetailViewModel.kt
app/src/main/java/com/funkodex/ui/screens/reports/ReportsScreen.kt
app/src/main/java/com/funkodex/ui/screens/reports/ReportsViewModel.kt
app/src/main/java/com/funkodex/ui/screens/scanner/ScannerScreen.kt
app/src/main/java/com/funkodex/ui/screens/scanner/ScannerViewModel.kt
app/src/main/java/com/funkodex/ui/screens/settings/SettingsScreen.kt
app/src/main/java/com/funkodex/ui/screens/settings/DatabaseTransferViewModel.kt
app/src/main/res/drawable/ic_splash_icon.xml
app/src/main/res/values/themes.xml
```

---

## [Unreleased] — Session 2 — 2026-06-03

### Fixed

**Collection**
- Owned items now always appear in the Collection screen regardless of category filter settings
- Category filter key normalization fixed — `"Pop! Heroes"` now correctly maps to `"pop_heroes"` key format
- Category filter no longer hides items with unrecognized category values

**Manual Search / Add**
- Search results list is now fully scrollable with correct bounded height via `BoxWithConstraints`
- Keyboard dismissed on search trigger (IME Done action replaces Search action)
- Items saved with `funko::UUID` IDs — previously saved with `catalog::` IDs which caused overwrites
- After bulk add, returns to scanner idle screen instead of showing stale prompt

**Delete**
- Delete now correctly removes items from both Collection screen and Reports screen
- Reports screen refreshes on every tab visit via `LaunchedEffect(Unit)`

**Reports**
- Series completion now groups by `franchise + category` instead of `franchise` alone
- `getCollectionStats` uses correct owned/wanted filtering

**Scanner**
- Scan tab shows idle screen first instead of auto-starting camera
- Manual search sheet `skipPartiallyExpanded = true`

**Category Defaults**
- All 22 categories default to enabled
- v3 migration force-sets `enabled = true` on all existing category preference documents

### Changed

- Settings — Appearance, Diagnostics, About all converted to single-row → dialog pattern
- Settings — Database section reorganized with Backup group
- Splash screen replaced with animated Celtic heart SVG
- Log retention changed from count-based to age-based (3 days)

---

## [0.1.0] — Session 1 — 2026-06-02

### Added
- Initial working build on API 34 emulator
- Couchbase Lite local database with catalog preloader (23,940 records)
- Collection, Scanner, Reports, Settings screens
- Price alerts via Channel3 API
- Google Drive backup integration
- Community UPC contribution toggle
- Splash screen (static placeholder)

### Fixed
- `collectionFlow()` moved to `Dispatchers.IO` — eliminated 74-second main thread freeze
- `DockedSearchBar` → `OutlinedTextField` — fixed Compose focus/JIT deadlock on API 34
- Splash screen simplified — original caused ART JIT verification overflow
- `confirmBulkAdd` ID generation — fresh `funko::UUID`
- Category preference seed defaults all set to `true`
