# FunkoDex — Enriched Catalog Import Feature
## Session Handoff Document

> **STATUS: HISTORICAL / SUPERSEDED.** This document was the pre-implementation
> plan for the "Import Enriched Catalog" feature. The feature described below
> is now implemented in the app (`EnrichedRecord.kt`, `CatalogImporter.kt`,
> `CatalogMapper.kt`, and the Settings screen import flow) — see the root
> `HANDOFF.md` and `CHANGELOG.md` for current status. The "Three passes"
> description of the enricher below is also outdated: `enrich.js` now has
> five passes, including a Pass 4 (HobbyDB reference numbers) that adds the
> `upc`, `funkoNumber`, `popType`, and retailer-SKU fields referenced in
> `EnrichedRecord.kt`'s "HobbyDB enriched fields" section but not described
> here. See `funko-enricher/README.md` for the current, accurate pass
> descriptions and CLI flags. This file is retained for its design rationale
> (image field decisions, merge logic) but should not be used as a build
> checklist.

**Project:** FunkoDex Android App  
**GitHub:** github.com/celticht32/FunkoDex  
**License:** MIT, Copyright (c) 2026 Chris Ahrendt  
**Toolchain:** AGP 8.13.2 / Gradle 8.13 / Kotlin 2.0.21 / KSP 2.0.21-1.0.28 / compileSdk 36  
**Database:** Couchbase Lite 3.x

---

## What We're Building

A Settings menu item — **"Import Enriched Catalog"** — that lets the user pick an
enriched `funko_data_enriched.json` file from their device and merge it into the
live Couchbase Lite catalog. This handles both:

- **New fields on existing catalog docs** (upsert / merge)
- **Net-new records** not in the original Kenny Chan dataset (insert)

This replaces the idea of a startup migration or bumping `CATALOG_VER`. The user
controls when it runs, sees progress, and gets a summary when it finishes.

---

## Background — How the Catalog Works

The app ships `funko_data.json` in `app/src/main/assets/`. On first launch,
`CatalogPreloader.preloadIfNeeded()` reads it and writes Couchbase Lite documents
of type `"catalog"`.

**Doc ID format:** `catalog::{handle}`  
**Marker doc:** `system::catalog_loaded` with field `version = "1"` — gates the
initial load. We are NOT bumping this version; the import UI handles existing
installs instead.

**Two completely separate document types:**
- `TYPE_CATALOG = "catalog"` — reference data, read-only from user's perspective
- `TYPE_FUNKO = "funko"` — user's owned/wanted items

Replacing/updating catalog docs is safe. It cannot touch user collection data.

---

## Key Files

| File | Package | Role |
|---|---|---|
| `FunkoDexDatabase.kt` | `com.funkodex.data.db` | DB constants, field names, index creation |
| `CatalogPreloader.kt` | `com.funkodex.data.preload` | Initial asset seed on first install |
| `CatalogMapper.kt` | `com.funkodex.data.preload` | Maps raw JSON fields → Couchbase document map |
| `FunkoMapper.kt` | `com.funkodex.data.db` | Maps user FunkoItem ↔ Couchbase document |

---

## CatalogMapper.mapRecord() — Current Signature

```kotlin
fun mapRecord(
    handle:      String,
    title:       String,
    imageName:   String   = "",
    seriesList:  List<String> = emptyList(),
    upc:         String?  = null,
    price:       Double   = 0.0,
    vaulted:     Boolean  = false,
    source:      String   = "KENNY_CHAN",
): Map<String, Any>
```

Fields already in `buildMap`: `type`, `handle`, `title`, `imageUrl`, `seriesList`,
`series`, `category`, `isExclusive`, `exclusiveRetailer`, `isChase`, `seriesNumber`,
`retailPrice`, `isVaulted`, `source`, `lastUpdated`, `upc` (if non-null).

---

## New Fields Being Added

These come from the enricher scrape of funko.com and need to be added to
`CatalogMapper.mapRecord()` and written to catalog docs during import.

| Enriched JSON field | Couchbase field name | Type | Notes |
|---|---|---|---|
| `price` | `retailPrice` | Double | Already exists in mapper — pass through |
| `available` | `isAvailable` | Boolean | New — add to mapper |
| `productUrl` | `productUrl` | String | New — add to mapper |
| `funkoPrimaryImage` | `funkoImageUrl` | String | New — separate from `imageUrl` |
| `pid` | `funkoShopId` | String | New — Funko's internal SFCC product ID |
| `upc` | `upc` | String | Already exists in mapper |
| `marketValueLoose` | `marketValueLoose` | String | New — PriceCharting OOB price |
| `marketValueNew` | `marketValueNew` | String | New — PriceCharting sealed price |
| `pricechartingId` | `pricechartingId` | String | New — PriceCharting product ID |
| `pricechartingUrl` | `pricechartingUrl` | String | New — PriceCharting page URL |

**Image field decision (deliberate):**  
- `imageUrl` = HobbyDB CDN image — **never overwrite**, vaulted items keep their image
- `funkoImageUrl` = funko.com CDN image — new field, only written if non-blank  
- In-app display: `funkoImageUrl.ifBlank { imageUrl }` for best-available image

---

## Updated CatalogMapper Signature (to implement)

```kotlin
fun mapRecord(
    handle:       String,
    title:        String,
    imageName:    String        = "",
    seriesList:   List<String>  = emptyList(),
    upc:          String?       = null,
    price:        Double        = 0.0,
    vaulted:      Boolean       = false,
    source:       String        = "KENNY_CHAN",
    available:    Boolean?      = null,           // NEW
    productUrl:   String?       = null,           // NEW
    funkoImageUrl:String?       = null,           // NEW
    funkoShopId:     String?       = null,           // NEW
    marketValueLoose:String?       = null,           // NEW — PriceCharting
    marketValueNew:  String?       = null,           // NEW — PriceCharting
    pricechartingId: String?       = null,           // NEW — PriceCharting
    pricechartingUrl:String?       = null,           // NEW — PriceCharting
): Map<String, Any>
```

Add to `buildMap` in `mapRecord()`:
```kotlin
if (available != null)    put("isAvailable",  available)
if (productUrl != null)   put("productUrl",   productUrl)
if (!funkoImageUrl.isNullOrBlank()) put("funkoImageUrl", funkoImageUrl)
if (!funkoShopId.isNullOrBlank())   put("funkoShopId",       funkoShopId)
if (!marketValueLoose.isNullOrBlank()) put("marketValueLoose", marketValueLoose)
if (!marketValueNew.isNullOrBlank())   put("marketValueNew",   marketValueNew)
if (!pricechartingId.isNullOrBlank())  put("pricechartingId",  pricechartingId)
if (!pricechartingUrl.isNullOrBlank()) put("pricechartingUrl", pricechartingUrl)
```

Add constants to `CatalogMapper`:
```kotlin
const val FIELD_IS_AVAILABLE  = "isAvailable"
const val FIELD_PRODUCT_URL   = "productUrl"
const val FIELD_FUNKO_IMAGE   = "funkoImageUrl"
const val FIELD_FUNKO_SHOP_ID = "funkoShopId"
```

---

## Enriched JSON Record Shape

The enricher outputs records with this shape (superset of Kenny Chan format):

```json
{
  "handle": "batman-dark-knight-batman",
  "title": "Batman (Dark Knight) - Batman",
  "imageName": "https://hobbydb-production...cdn.../batman.jpg",
  "series": ["Pop! Heroes", "DC Comics"],
  "pid": "059836",
  "price": "11.99",
  "available": true,
  "productUrl": "https://www.funko.com/products/batman-dark-knight-batman",
  "funkoPrimaryImage": "https://funko.com/cdn/shop/products/batman.png",
  "funkoSource": "funko.com"
}
```

Note: `price` comes from the scraper as a String (e.g. `"$11.99"`) — strip the `$`
and parse to Double on import.

---

## What Needs to Be Built

### 1. Update `CatalogMapper.kt`
- Add 4 new parameters (available, productUrl, funkoImageUrl, funkoShopId)
- Add 4 new constants
- Add conditional puts to `buildMap`

### 2. New `EnrichedRecord.kt` data class
In `com.funkodex.data.preload`:
```kotlin
data class EnrichedRecord(
    val handle:           String?       = null,
    val title:            String?       = null,
    val imageName:        String?       = null,
    val series:           List<String>? = null,
    val pid:              String?       = null,
    val price:            String?       = null,   // "$11.99" — parse on use
    val available:        Boolean?      = null,
    val productUrl:       String?       = null,
    val funkoPrimaryImage:String?       = null,
    val funkoSource:      String?       = null,
    val upc:              String?       = null,
)
```

### 3. New `CatalogImporter.kt`
In `com.funkodex.data.preload`. Core logic:

```kotlin
suspend fun importFromUri(uri: Uri): ImportResult
```

- Opens the URI via `context.contentResolver.openInputStream(uri)`
- Parses JSON as `List<EnrichedRecord>` using Gson
- Runs in batches of 500 inside `database.inBatch`
- For each record:
  - Doc ID = `"catalog::${record.handle}"`
  - If doc exists → **merge**: only write non-null new fields, never overwrite
    `imageUrl`, `title`, `handle`, `seriesList`
  - If doc missing → **insert**: call `CatalogMapper.mapRecord()` with all fields
- Emits progress via `Flow<ImportProgress>` so the UI can show a counter
- Returns `ImportResult(enriched=N, added=M, skipped=K, errors=E)`

**Upsert merge logic (existing docs):**
```kotlin
val existing = database.getDocument(docId)
if (existing != null) {
    val mutable = existing.toMutable()
    // Only write new fields — never overwrite core identity fields
    record.available?.let      { mutable.setBoolean("isAvailable", it) }
    record.productUrl?.let     { if (it.isNotBlank()) mutable.setString("productUrl", it) }
    record.funkoPrimaryImage?.let { if (it.isNotBlank()) mutable.setString("funkoImageUrl", it) }
    record.pid?.let            { if (it.isNotBlank()) mutable.setString("funkoShopId", it) }
    record.upc?.let            { if (it.isNotBlank()) mutable.setString("upc", it) }
    record.price?.let          { p ->
        val parsed = p.replace("[^0-9.]".toRegex(), "").toDoubleOrNull()
        if (parsed != null && parsed > 0) mutable.setDouble("retailPrice", parsed)
    }
    mutable.setString("lastUpdated", LocalDate.now().toString())
    database.save(mutable)
    enrichedCount++
} else {
    // Insert full record via CatalogMapper
    ...
}
```

### 4. Settings Screen — Menu Item + File Picker

In your Settings composable, add:

```kotlin
var showImportDialog by remember { mutableStateOf(false) }
var importResult by remember { mutableStateOf<ImportResult?>(null) }

val filePicker = rememberLauncherForActivityResult(
    contract = ActivityResultContracts.OpenDocument()
) { uri ->
    uri?.let { viewModel.importEnrichedCatalog(it) }
}

// Menu item
SettingsItem(
    title = "Import Enriched Catalog",
    subtitle = "Load enriched funko.com data from a JSON file",
    onClick = { filePicker.launch(arrayOf("application/json")) }
)

// Progress / result dialog
if (showImportDialog) {
    ImportProgressDialog(
        progress = viewModel.importProgress.collectAsState().value,
        result = importResult,
        onDismiss = { showImportDialog = false }
    )
}
```

### 5. ViewModel additions

In whatever ViewModel backs the Settings screen:

```kotlin
val importProgress = MutableStateFlow<ImportProgress?>(null)

fun importEnrichedCatalog(uri: Uri) {
    viewModelScope.launch {
        catalogImporter.importFromUri(uri)
            .collect { progress ->
                importProgress.value = progress
            }
    }
}
```

---

## Progress / Result Data Classes

```kotlin
data class ImportProgress(
    val processed: Int,
    val total: Int,
    val enriched: Int,
    val added: Int,
)

data class ImportResult(
    val enriched: Int,
    val added: Int,
    val skipped: Int,
    val errors: Int,
    val durationMs: Long,
)
```

---

## Enricher Tool (already built)

A Node.js three-pass enricher (`funko-enricher.tar.gz`) was built this session.
It runs three passes and outputs `funko_data_enriched.json`.

**Three passes:**
- Pass 1 — Kenny Chan GitHub (`github.com/kennymkchan/funko-pop-data`, MIT, ~23k records)
  Single file download, fills catalog gaps, no scraping.
- Pass 2 — funko.com scrape
  Adds: `pid`, `price`, `available`, `productUrl`, `funkoPrimaryImage`
- Pass 3 — PriceCharting.com scrape (eBay sold listing aggregator, free, no key)
  Adds: `marketValueLoose`, `marketValueNew`, `pricechartingId`, `pricechartingUrl`

**New fields from Pass 3** (add to `CatalogMapper` and `EnrichedRecord`):
```kotlin
// EnrichedRecord additions
val marketValueLoose:  String? = null,
val marketValueNew:    String? = null,
val pricechartingId:   String? = null,
val pricechartingUrl:  String? = null,

// CatalogMapper additions
const val FIELD_MKT_VALUE_LOOSE = "marketValueLoose"
const val FIELD_MKT_VALUE_NEW   = "marketValueNew"
const val FIELD_PC_ID           = "pricechartingId"
const val FIELD_PC_URL          = "pricechartingUrl"
```

**Workflow:**
1. Run enricher on PC → produces `funko_data_enriched.json`
2. Copy file to Android device (Downloads, Google Drive, etc.)
3. Open FunkoDex → Settings → Import Enriched Catalog
4. Pick the file → importer runs → summary shown

**Quick run (skip slow PriceCharting pass):**
```
node enrich.js --input funko_data.json --output funko_data_enriched.json --skip-pc
```

---

## What NOT to Do

- Do NOT bump `CATALOG_VER` in `CatalogPreloader` — that path is abandoned
- Do NOT replace the `funko_data.json` asset for existing installs
- Do NOT overwrite `imageUrl` (HobbyDB) — only write `funkoImageUrl` as new field
- Do NOT overwrite `title`, `handle`, or `seriesList` on existing docs
- Do NOT use a WorkManager job — this is user-triggered, runs on demand

---

## Files to Touch

```
app/src/main/java/com/funkodex/data/preload/
  CatalogMapper.kt          ← add 4 params + constants
  EnrichedRecord.kt         ← new data class
  CatalogImporter.kt        ← new, core upsert logic

app/src/main/java/com/funkodex/ui/settings/
  SettingsScreen.kt         ← add menu item + file picker + dialog
  SettingsViewModel.kt      ← add importEnrichedCatalog() + importProgress flow
```
