# FunkoDex — Claude Project Context

## What this is

FunkoDex is an Android Kotlin/Jetpack Compose app for managing a Funko Pop collection.
Built entirely in Claude across multiple sessions. This file gives Claude the full
context needed to work on the codebase without re-explaining architecture.

**71 Kotlin source files. Feature-complete at the code level through
Sessions 1–13. Sessions 7–8 (CBL Collection API + Keystore migrations) and
Session 11 (scanner/manual-add/pricing/image work) were the prior big code
changes; Session 12 added manual-UPC validation, variant-aware pricing, an
"enter details manually" entry point, and two resource-leak fixes (HTTP
responses + camera executor). Session 13 wired PriceCharting end-to-end:
the enricher carries `marketValueComplete`/UPCs/metadata into the catalog,
scan-by-UPC now reads the Couchbase catalog (not the bundled JSON seed), a
live PriceCharting refresh tier re-scrapes the stored product page, import
gained UPC-based de-dup and merges instead of skipping priced-but-incomplete
records, and the Channel3 manual-key UI was hidden (its tiers still run). The
enricher's variant matcher also gained an approximate base-price fallback
(`marketValueIsApproximate`, shown as "Market avg (approx)" with a `~`): a
variant the catalog has but PriceCharting lists only as a base figure takes the
base price, flagged, when the core name matches exactly — wrong-figure matches
still skip. A full production crawl run (1000 new scannable Pops, ~94% with UPCs)
validated the pipeline end to end.
Full functional/device test pass remains the standing focus — see Testing
below; on-device confirmation of the scan-from-catalog and live-refresh paths
is the immediate Session 13 verification. A Community Catalog Distribution
architecture (golden-master base + GitHub update packets) is designed but not
built — see FUTURE.md.**

---

## Testing — current focus

A full, code-verified functional test plan covering every feature built to
date lives in **`COMPLETE_TEST_PLAN.md`** (Parts A–E: core collection, OAuth/
Drive/community integrations, backup/restore/force-restore, automated/unit
tests, 16 KB regression — every UI label and dialog title verified against
source). Progress is tracked in **`TEST_TRACKER.md`** — check items off there
as they run, with one-line results in its log section.

**Highest priority:** Part C3, force restore — exercises the Session 7
`db.reopen()` → fresh `Collection` accessor path, the biggest regression risk
from the Collection API migration. Run Part C last (it wipes the database).

**Two known wiring gaps — RESOLVED Session 9 (commits `74c5616`, `6f2c523`):**
- `ReportsScreen.kt` + `ReportsViewModel.kt` created at
  `ui/screens/reports/`, wired into `FunkoDexNavHost.kt`. A9 unblocked.
- `CatalogDataSection` is now invoked from the "Catalog" section of
  `SettingsScreen.kt`. B1–B3, B6 unblocked.

Both untested-but-reachable as of Session 9; see `TEST_TRACKER.md`.

---

## Technology stack

| Layer | Technology |
|---|---|
| Language | Kotlin 2.0, coroutines |
| UI | Jetpack Compose + Material 3 |
| Database | Couchbase Lite 3.2.4 (Community — free, no server, offline-first; ≥3.2.3 required for 16 KB page-size compliance). All data access goes through `database.defaultCollection` via the Collection API (`DataSource.collection`, `collection.save/getDocument/delete/createQuery/createIndex`) — Session 7. `inBatch()` remains database-level. |
| DI | Hilt (KSP processor) |
| Background | WorkManager + HiltWorker |
| Networking | OkHttp 4.12 + Gson |
| Camera | CameraX + ML Kit Barcode (CameraX ≥1.4.x required for 16 KB compliance) |
| Images | Coil 2.7 |
| Export | Apache POI (Excel) |
| Widget | Jetpack Glance 1.1.0 |
| Security | AES-256-GCM via AndroidKeyStore (SecureKeyStore, Session 8) + Android Keystore HMAC |
| OAuth | Chrome Custom Tabs + PKCE (HobbyDB, eBay) |
| Browser | androidx.browser 1.8.0 (Chrome Custom Tabs for OAuth) |
| Logging | FunkoDexLogger (rotating file, configurable level, crash handler) |
| Prefs | DataStore Preferences |

---

## Package structure

```
com.funkodex/
├── FunkoDexApp.kt              CrashHandler+Logger init first, HiltWorkerFactory,
│                               channels, 5 workers scheduled
├── MainActivity.kt             Deep-link NAVIGATE_TO_ITEM handling (funko:: validated),
│                               onNewIntent
├── auth/
│   ├── OAuthConfig.kt          HobbyDB + eBay endpoint constants, redirect URIs, scopes
│   ├── OAuthCallbackActivity.kt Handles funkodex://oauth/{hobbydb|ebay} redirects,
│                               PKCE token exchange, broadcasts ACTION_SUCCESS/FAILURE
│   ├── OAuthLauncher.kt        Builds PKCE auth URL, opens Chrome Custom Tab
│   ├── PkceHelper.kt           RFC 7636 code_verifier/challenge; OAuthSession in-memory store
│   ├── TokenRefreshManager.kt  Silent token refresh with per-provider Mutex; 5-min buffer;
│   │                           handles token rotation; hasHobbyDbRefreshToken/hasEbayRefreshToken
│   └── TokenKeeperWorker.kt    @HiltWorker — weekly proactive token refresh to keep
│                               refresh tokens alive (eBay 18-month expiry, HobbyDB similar)
├── data/
│   ├── backup/                 DriveBackupWorker, GitHubUploadWorker
│   ├── db/                     FunkoDexDatabase (all constants + 9 indexes), FunkoMapper
│   ├── export/                 CollectionExporter, ExportScreen (ExportButton), ExportViewModel
│   ├── model/                  FunkoItem (30 fields, incl. resolvedRetail +
│   │                           effectiveRetail computed getter), PriceData, PriceAlert (+upc field),
│   │                           CategoryPreference, PendingUpcScan, CatalogContribution
│   ├── preload/                CatalogPreloader, CatalogMapper, CatalogRefreshWorker
│   │                           (Kenny Chan + community UPC + HobbyDB vaulted refresh),
│   │                           CatalogImporter + EnrichedRecord (user-triggered enriched
│   │                           catalog JSON import: handle match → title fallback →
│   │                           merge/insert, non-Pop filter, .html handle repair),
│   │                           PriceAlertWorker (@HiltWorker + POST_NOTIF guard)
│   └── repository/             FunkoRepository (+updateWidget +getOwnedFiltered),
│                               CategoryPreferenceRepository, AlertRepository (+upc field),
│                               ContributionRepository, ImageBlobRepository, PhotoRepository
├── di/AppModule.kt             All @Provides — 13 providers; OkHttp writeTimeout(30s)
├── network/                    ConnectivityObserver (+POST_NOTIF guard), FunkoLookupService,
│                               PriceService (PriceCharting re-scrape → retail →
│                               eBay → UPCitemdb → Channel3 → HobbyDB)
├── security/                   SecureKeyStore (AES-256-GCM via AndroidKeyStore,
│                               Session 8 — Channel3, HobbyDB, eBay tokens,
│                               install ID; prefs file funkodex_secure_prefs_v2),
│                               HmacKeyStore (Keystore HMAC)
├── util/                       FunkoDexLogger (rotating file, async queue),
│                               CrashHandler, LogLevel enum
└── ui/
    ├── FunkoDexNavHost.kt      5-tab + Detail + CategoryFilter + deepLinkItemId
    ├── help/                   HelpContent (28 strings), HelpBanner, HelpCard, HelpEmptyState
    └── screens/
        ├── SplashScreen.kt
        ├── collection/         CollectionScreen + CollectionViewModel
        │                       (My Dex — owned items only; search/sort/franchise
        │                       filter; category prefs do NOT filter this screen)
        ├── detail/             DetailScreen + DetailViewModel (2-phase price, photo,
        │                       alerts, variants, UPC scan + community contribution prompt)
        ├── prescan/            PreScanScreen + PreScanViewModel — "Check" tab:
        │                       read-only camera "do I already own this?" duplicate
        │                       checker (4s auto-reset, no add flow)
        ├── reports/            ReportsScreen + ReportsViewModel — summary stats,
        │                       cost breakdown, ExportButton, per-series
        │                       completion + want-list (Session 9)
        ├── scanner/            ScannerScreen (all ScanState branches + POST_NOTIF),
        │                       ScannerViewModel (ConnectivityObserver, no deprecated API),
        │                       BatchScanScreen/VM, BarcodeAnalyzer
        └── settings/           SettingsScreen (Drive sign-in/out, import file picker,
                                    Import Enriched Catalog row + progress/result dialogs,
                                    Diagnostics: log level + VERBOSE warning + share log,
                                    HobbyDB OAuth sign-in, eBay OAuth sign-in),
                                CatalogSettingsViewModel (+OAuth helpers),
                                CategoryFilterScreen/VM, DatabaseTransferViewModel,
                                SettingsViewModel (+logLevel StateFlow + setLogLevel)

  > **Note:** `CatalogDataSection` (Channel3/HobbyDB/eBay "Lookup sources"
  > rows + "Refresh now") is now invoked from the "Catalog" section of
  > `SettingsScreen.kt` (Session 9). Reachable but untested — see
  > `TEST_TRACKER.md`.
```

---

## Key architectural decisions

### Database — Couchbase Lite Community
No server, no sync subscription, 100% offline. Document types:
- `funko::{upc|uuid}` — personal collection items
- `catalog::{handle}` — global product catalog (Kenny Chan + PriceCharting market
  values/UPCs/metadata + community UPCs)
- `price::{itemId}::{source}` — cached market price snapshots
- `alert::{itemId}` — price drop alerts (includes `upc` field)
- `pending_upc::{upc}` — offline UPC scan queue
- `contrib::{upc}` — pending community UPC contributions
- `cat_pref::{category}` — category filter preferences
- `system` type docs — internal markers; preserved through backup/restore (never exported, never deleted)

All constants in `FunkoDexDatabase.kt`. The Mapper handles `FunkoItem` ↔ Document conversion.

### Price waterfall (`PriceService.kt`)
0. **PriceCharting (live re-scrape)** — *Session 13.* When an item carries a
   `pricechartingUrl` (set by the enricher and stored in the catalog), the refresh
   re-fetches that exact product page via OkHttp and parses the three grades from
   `#used_price`/`#complete_price`/`#new_price`. Complete (in-box) is the displayed
   market value. No search, no variant-matching risk — it re-reads the already-
   identified page. Runs *before* retail, since retail (MSRP) is not a market value
   and would otherwise short-circuit the market tiers. Verified PriceCharting serves
   the page to a plain Android-UA GET (no JS challenge); on-device residual-IP
   confirmation is the standing Session 13 to-do. Source enum `PRICECHARTING`.
1. **Retail** — instant, from catalog data. Returns and stops (retail only).
2. **eBay sold listings** — real sold prices, scraped from the sold-listings HTML
   (`s-card__price` spans; the `_rss=1` feed is retired, so the `EBAY_RSS` enum
   name is historical). No auth. Parser verified live Session 12. Chase/exclusive
   items query the variant's listings first, falling back to the broad query.
3. **UPCitemdb** — 100/day free, UPC required. Typed gson parsing (Session 12).
4. **Channel3** — free tier (100/day) then premium with user's API key. **Dormant
   unless a Channel3 key is configured.** Its manual-key settings UI was hidden in
   Session 13 (`SHOW_CHANNEL3_KEY_UI = false`); the free tier and the
   `funkodex_keys.json` import path still function.
5. **HobbyDB** — `TokenRefreshManager.getValidHobbyDbToken()`, silent refresh.
   Searches by name (variant terms appended Session 12); takes top relevance hit.

The network tiers close their `Response` via `.use {}` (Session 12 leak fix).
The eBay/HobbyDB/Channel3 name queries share a `variantSuffix` helper; UPC-keyed
lookups don't use it (a UPC is already variant-specific).

### Scan / UPC lookup (`FunkoLookupService.kt`)
*Session 13:* `lookupByUpc` now queries the **Couchbase catalog** first
(`lookupCatalogByUpc`, leading-zero tolerant), so every imported/enriched record
is scannable. The bundled `funko_data.json` is a fallback seed only. Catalog docs
become `FunkoItem`s via the shared `catalogDocToFunkoItem` builder (also used by
name-search), which seeds `marketAvg` from the catalog's `marketValueComplete`
and carries `pricechartingUrl` for the live refresh tier. It also reads
`marketValueIsApproximate` — set by the enricher when a variant was priced from
its base figure (PriceCharting didn't list the variant). DetailScreen's
`MarketPriceCard` shows such values as "Market avg (approx)" with a `~` prefix so
an estimated price is never mistaken for an exact one.

### OAuth flow (`auth/` package)
PKCE (RFC 7636) — no client secret in APK. Code verifier stored in `OAuthSession` (memory only).
`OAuthCallbackActivity` uses `lifecycleScope` (no leak), `finish()` on Main thread.
Broadcasts restricted to own package via `setPackage(packageName)`.

### Token refresh strategy
- **On-demand** (`TokenRefreshManager`): called by `PriceService` and `CatalogRefreshWorker`
  before every API call. 5-minute buffer. Per-provider `Mutex` prevents refresh storms.
- **Proactive** (`TokenKeeperWorker`): weekly `@HiltWorker`. Keeps refresh tokens alive
  even when the app is opened infrequently. eBay refresh tokens last 18 months;
  without weekly use the refresh token itself can expire. Uses KEEP policy.

### Security model (all implemented)
- `allowBackup=false`, HTTPS-only, 10-domain allowlist
- No secrets in APK — Channel3 key, HobbyDB/eBay tokens, and install ID stored
  in `funkodex_secure_prefs_v2`, each value AES-256-GCM encrypted directly via
  `AndroidKeyStore` (alias `funkodex_secure_key`) — `SecureKeyStore.kt`
  (Session 8; replaced the deprecated `androidx.security:security-crypto`
  EncryptedSharedPreferences). Old `funkodex_secure_prefs` file abandoned on
  disk, not migrated — upgrading users re-enter Channel3 key and re-link
  HobbyDB/eBay once.
- HMAC key in hardware-backed Android Keystore
- Deep-link `itemId` validated against `funko::` prefix (SEC-B fix)
- VERBOSE log shows data-privacy warning (SEC-C fix)
- OkHttp `writeTimeout(30s)` (SEC-D fix)
- `POST_NOTIFICATIONS` runtime check before every `nm.notify()` (Android 13+)
- All `PendingIntent` use `FLAG_IMMUTABLE`
- OAuth broadcasts restricted to own package

### Logging system (`util/` package)
- `FunkoDexLogger` — async rotating file (`filesDir/logs/funkodex_YYYY-MM-DD.log`),
  7-day retention, 5MB rotation, level gate
- `CrashHandler` — `Thread.UncaughtExceptionHandler` installed before all other init;
  writes to `filesDir/logs/crash_TIMESTAMP.log`
- Level: VERBOSE/DEBUG/**INFO**/WARN/ERROR — persisted in DataStore, configurable in Settings
- Share from Settings > Diagnostics > Share log file

### Workers (all scheduled in `FunkoDexApp.onCreate()`)
| Worker | Type | Frequency | Notes |
|---|---|---|---|
| `CatalogRefreshWorker` | Plain CoroutineWorker | 7 days (KEEP) | Kenny Chan + community UPC + HobbyDB vaulted |
| `PriceAlertWorker` | @HiltWorker | Daily (KEEP) | POST_NOTIFICATIONS guard |
| `DriveBackupWorker` | @HiltWorker | Daily (UPDATE) | WiFi only, POST_NOTIFICATIONS guard |
| `GitHubUploadWorker` | @HiltWorker | Daily, opt-in | HMAC-signed community contributions |
| `TokenKeeperWorker` | @HiltWorker | Weekly (KEEP) | Proactive OAuth token refresh |

---

## Manual steps required before first build

All bundled assets (catalog dataset, splash font, launcher icons) are
committed to the repo — no manual download/generation needed for a clean
clone. Remaining steps:

1. `local.properties`: add `workerUrl=https://funkodex-contrib.YOUR.workers.dev` (optional)
2. Gradle sync — all 52 deps resolve automatically

**Already included in the repo:**
- `app/src/main/assets/funko_data.json` — Kenny Chan dataset (23,940 records)
- `app/src/main/res/font/cinzel_decorative_{regular,bold,black}.ttf`
- Launcher icons — all mipmap densities pre-generated (`launcher-icon/` holds the SVG sources)

**Channel3 API key:** entered in Settings > Data Sources (not `local.properties`).
**HobbyDB / eBay:** one-time OAuth sign-in from Settings > Data Sources.
**eBay `CLIENT_ID`:** replace placeholder in `OAuthConfig.eBay.CLIENT_ID` after
registering at `developer.ebay.com`.

---

## Running tests

```bash
./gradlew test                     # 6 unit test files, no device needed
./gradlew connectedAndroidTest     # instrumented (device/emulator required)
```

Test files:
- `data/db/FunkoMapperTest.kt` — Couchbase document roundtrip (9 tests)
- `data/repository/CollectionStatsTest.kt` — FunkoItem defaults + arithmetic (11 tests)
- `network/FunkoLookupServiceTest.kt` — record mapping (8 tests)
- `ui/screens/scanner/ScannerViewModelStateTest.kt` — 20 Mockk tests (all 10 ScanState branches)
- `auth/PkceHelperTest.kt` — RFC 7636 crypto incl. official test vector (9 tests)
- `security/SecureKeyStoreTokenTest.kt` — token parsing/expiry logic (15 tests)

---

## Migration specs (read BEFORE touching dependencies or auth)

- **`docs/PlayStore_Readiness_Migration_SPEC.md`** — 16 KB page-size compliance and
  deprecation cleanup. Hard rules from it: Couchbase Lite must stay ≥3.2.3, CameraX
  ≥1.4.x; **do NOT migrate to Couchbase Lite 4.0.x** — it removes APIs and changes
  semantics beyond the 3.2.x Collection API this codebase now uses; do NOT add
  extractNativeLibs/useLegacyPackaging workarounds. (The database-level → Collection
  API migration that this spec scheduled was completed in Session 7 — all data
  access already uses `database.defaultCollection`.)
- **`docs/CredentialManager_Migration_SPEC.md`** — Google Drive auth migration off the
  deprecated GoogleSignIn API. Uses AuthorizationClient only (authorization), NOT
  Credential Manager (authentication) — read §1 before assuming otherwise.

## Future work

See **`GITHUB_SETUP.md`** for complete step-by-step GitHub + Cloudflare Worker setup.

See **`FUTURE.md`** for 25 detailed enhancement items with implementation instructions,
all designed to be implementable in a single Claude session. Groups: Auth, Prices,
Collection features, Platform, Data/Sync, QA, UI/UX, Security, Performance, i18n.

## Recently completed (from FUTURE.md)
- **F-QA-1:** ScannerViewModelStateTest wired with Mockk — 20 tests covering all 10 ScanState branches
- **F-PERF-1:** Coil ImageLoader singleton — 30% memory cache, disk cache, global crossfade(150ms)
- **F-PLAT-4:** Quick-scan home screen shortcut — long-press app icon → opens scanner directly
- **F-AUTH-2:** Re-auth notification — TokenKeeperWorker posts notification when refresh token expires
- **F-UI-2:** Haptic feedback — 50ms vibration pulse on successful barcode scan

## Remaining limitations

- Couchbase Lite Community is unencrypted on disk (accepted — collector data, not financial)
- eBay pricing (Tier 2a): the `_rss=1` feed is retired; the app scrapes the
  sold-listings HTML. The parser is current (verified live Session 12). The 403s
  seen in logs are a fetch-time bot challenge from datacenter IPs — it may work on
  a real device's residential connection. Don't assume the tier is dead; verify
  on-device. Pricing is variant-aware for chase/exclusive items.
- Play Integrity API in Cloudflare Worker not yet implemented (optional hardening)
- eBay `CLIENT_ID` requires developer.ebay.com registration
- Wear OS companion, tablet two-pane layout, value-over-time chart not built
- 
---

## Lessons learned (see LESSONS_LEARNED.md)

1–9: Architecture, security, data, SVG, dev workflow, dependency management
10–15: OAuth PKCE, install ID storage, deep-link validation, central logger, CrashHandler,
        POST_NOTIFICATIONS guards
26–29: Gson TypeToken on data classes, display-field taxonomy integrity, resolved-vs-persisted
        writes, fallback values not feeding tier/source fields
30: Pin version-sensitive API symbol names (e.g. material3 `MenuAnchorType` in 1.3.0) against
        the pinned dependency — never infer from memory; check existing project usage first.
        Corollary: clear deprecated APIs (they get removed later), but verify the replacement
        symbol against the pin too
31–33: `Int.MAX_VALUE` staleDays overflows LocalDate.plusDays() (broke manual market value);
        CameraX preview goes black after screen-off (rebind on ON_RESUME); eBay price RSS retired
        — HTML scrape works (parser verified live Session 12), 403s are fetch-time bot blocks
34–36: Close every OkHttp `Response` with `.use {}` even on error-return paths (leak);
        a per-`ON_RESUME` `newSingleThreadExecutor()` with no shutdown leaks a thread —
        own it in `remember` + `onDispose`; price a variant against its own listings
        (append chase/exclusive to the *name* query) — a mixed result set under-prices it
