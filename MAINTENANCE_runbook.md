# funko_enrich — Maintenance Runbook

How to keep the enriched golden master up to date going forward.

License: MIT © 2026 Chris Ahrendt

---

## How re-runs behave (incremental, not from-scratch)

Every pass skips records it has already completed, so a second run only touches
what is new or incomplete:

- **Pass 3b (crawl):** with no sidecar present, re-scrolls all console sets but
  records already in the catalog dedup-skip via `havePcId` — only genuinely NEW
  Pops are added.
- **Pass 3 (pricing):** skips records that already have BOTH a price AND a UPC.
  Re-prices only records with no price, or priced-but-no-UPC. (Plus stale prices
  when `--reprice-older-than` is set — see below.)
- **Pass 4 (HobbyDB):** skips records with the `hdbChecked` marker.
- **Pass 5 (franchise):** skips records with the `franchiseChecked` marker.
- **Post-process** (dedup, grouping, final write) runs every time over the whole
  set — necessary to merge newly-added Pass 3b records into the canonical set.

Done-markers now survive dedup (`dedupeAndMerge` carries `hdbChecked`,
`franchiseChecked`, `hdbid`, `priceCheckedAt`, plus all the data fields onto the
surviving record), so collapsing duplicates does not cause re-scraping on the next
run.

## Maintenance commands

Pick by intent. All assume the working dir is the repo root and the prior
`funko_data_enriched.json` is present (it is the resume state).

- **Full refresh — catch new Pops + price them (the periodic big run):**
  ```
  node enrich.js --skip-kenny --skip-funko --skip-hdb --skip-funko-detail
  ```
  Runs Pass 3b crawl (adds new Pops) then Pass 3 pricing (prices the new ones).
  Slowest. Run occasionally (e.g. monthly) to pick up newly released figures.

- **Prices only, skip discovery (faster):**
  ```
  node enrich.js --skip-kenny --skip-funko --skip-hdb --skip-funko-detail --no-pc-crawl
  ```
  Jumps straight to Pass 3. Only touches unpriced / incomplete records.

- **Refresh aging prices (the staleness mechanism):**
  ```
  node enrich.js --skip-kenny --skip-funko --skip-hdb --skip-funko-detail --no-pc-crawl --reprice-older-than 90
  ```
  Re-prices any record whose `priceCheckedAt` is older than N days (here 90), OR
  has no `priceCheckedAt` at all (records priced before the timestamp existed are
  treated as stale and refreshed once, then carry a date forward). Without this
  flag, a priced record is never re-priced — prices would otherwise be permanent.

- **Force re-crawl from scratch (rarely needed):**
  Delete the sidecar first, then run the full refresh:
  ```
  del C:\Downloads\Development\funko_enrich\funko_data_enriched.pc3b_progress.json
  node enrich.js --skip-kenny --skip-funko --skip-hdb --skip-funko-detail
  ```

## Safety / resume

- **Pass 3b** checkpoints PER SET (sidecar `funko_data_enriched.pc3b_progress.json`)
  and the completeness gate leaves any stalled/blank set UNMARKED so it retries.
- **Pass 3** checkpoints every 100 records (resume skips already-priced) and
  restarts the browser every 200 (memory).
- Safe to Ctrl-C and resume any time; lose at most ~100 records of pricing work or
  ~1 set of crawl work.
- For a long pricing run, disable Windows sleep/hibernate (power settings) so the
  machine doesn't suspend mid-run. Checkpoints protect data, not against suspend.
- Tee output to a log if you want to grep restarts/warnings later:
  ```
  node enrich.js ... 2>&1 | Tee-Object -FilePath run.log
  ```

## New-field note for FunkoDex import (verified safe)

Pass 3 now writes `priceCheckedAt` (ISO date) on each priced record. The FunkoDex
`CatalogImporter.toEnrichedRecord()` reads fields EXPLICITLY by name and ignores
any field it does not read, so `priceCheckedAt` is silently ignored on import — no
schema break. None of the maintenance changes remove, rename, or retype any field
the app consumes; they only add one ignored field and carry existing markers
through dedup. The import contract is intact.

If you later want the app to SHOW "price as of <date>", add a reader for
`priceCheckedAt` in `toEnrichedRecord` + `EnrichedRecord` + `CatalogMapper` — until
then it is harmlessly carried in the JSON only.

## Known gaps / future

- Re-price staleness is opt-in per run (`--reprice-older-than`). There is no
  automatic scheduling — you decide when to run it.
- "uncertain — skipped" records (matcher declined a wrong-looking PriceCharting
  candidate) stay unpriced by design. Chasing them is a separate refinement pass.
- Some HobbyDB UPCs are 11-digit and dropped by `normalizeUpc` (returns null).
- `[Fall Convention]/[NYCC]`-style regional label pairs can share hdbid/upc.
