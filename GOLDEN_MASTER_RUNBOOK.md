# Golden-master run sequence — funko_enrich

Goal: the most complete enriched catalog possible. After the defaults change,
a plain `node enrich.js` IS the complete build (Pass 3b discovery on, no pricing
cap, large HobbyDB limit, UPC fill on). These are the commands and the
stop-condition logic.

All commands run from `C:\Downloads\Development\funko_enrich`.

## What each pass contributes

- **Pass 1 (Kenny Chan)** — seeds records from the GitHub dataset. Fixed source.
- **Pass 2 (funko.com)** — adds funko.com's current-catalog products (~2,969
  items). Bounded; re-running finds the same products. Does NOT keep growing.
- **Pass 3b (PriceCharting crawl)** — DISCOVERS and ADDS Pops from PriceCharting's
  ~29 Funko console sets that aren't already in the catalog, already priced. This
  is the only pass that grows the set beyond Kenny Chan + funko.com. ON by default.
- **Pass 4 (HobbyDB)** — adds `hdbid`, `upc`, `funkoNumber`, `series` to records
  that lack them. The main UPC/ref source. Idempotent (skips `hdbChecked`).
- **Pass 5 (funko.com details)** — franchise tags from product pages.
- **Pass 3 (PriceCharting prices)** — fills market values on unpriced records;
  with UPC fill on, also tops up UPCs on priced-but-UPC-less records.
- **Post-process** — removeNonPops (per-record, FIRST) → merge handles → dedup →
  safety non-Pop pass → extract Pop# → derive grouping. Collapses to final count.

## The sequence

### 1. Let the CURRENT run finish

Don't interrupt it. When the Final Summary prints, capture three numbers:

```
node -e "const d=require('./funko_data_enriched.json'); console.log('records', d.length, '| priced', d.filter(r=>r.marketValueComplete).length, '| upc', d.filter(r=>r.upc).length)"
```

### 2. Run the full complete build

With the new defaults, this single command does Pass 3b discovery, no pricing
cap, 5000 HobbyDB lookups, and UPC fill:

```
node enrich.js
```

This is the long one (Pass 3b crawl + large Pass 4 + full Pass 3 — many hours).
It is idempotent: HobbyDB/funko.com work already done is skipped; the new work is
Pass 3b discovery and enriching whatever is still bare.

After it finishes, capture the three numbers again.

### 3. Re-run while the numbers still climb

Run `node enrich.js` again. Compare the three numbers to the previous run:

- **records** climbing  → Pass 3b is still discovering new Pops. Run again.
- **priced** climbing    → Pass 3 still finding prices. Run again.
- **upc** climbing       → Pass 4 / UPC-fill still finding UPCs. Run again.

Stop when two consecutive runs produce the same three numbers. That is the
sources' ceiling — remaining gaps are records the sources genuinely lack
(obscure variants, prototypes, regionals), which no re-run can fill.

Expected: convergence in ~2–4 runs total.

### 4. Targeted mop-up (optional, only if a specific gap remains)

These re-scan records already marked checked, so they are NOT part of normal
runs — use only to chase a specific shortfall:

```
node enrich.js --retry-no-refs       # retry HobbyDB on records checked but with no hdbid
node enrich.js --retry-no-series     # retry HobbyDB on records missing series tags
```

### 5. Layer on funko.com facets (series/license/fandom)

After the catalog is complete and stable, run the standalone facet harvester for
funko.com's own Series/License/Fandom tags on current-catalog items:

```
node harvest_facets.js --limit 3      # smoke test: confirm facets actually narrow
node harvest_facets.js                # full run once the smoke test looks right
```

If the smoke test shows `skipped (count did not narrow ...)` on everything, the
click selector needs adjusting to funko.com's live DOM — capture the output.

### 6. Verify, then push

```
node -e "const d=require('./funko_data_enriched.json'); console.log('records', d.length); console.log('ronald', d.filter(r=>r.title==='Ronald McDonald').length); console.log('priced', d.filter(r=>r.marketValueComplete).length)"
```

Expect `ronald` = 1 (post-process reorder keeps the Pop, drops its Wacky Wobbler
twin). Then commit + push `enrich.js`, `harvest_facets.js`, the regenerated
`funko_data_enriched.json`, `CHANGELOG.md`, `CLAUDE.md`, and import into FunkoDex.

## Quick / partial runs (when you don't want the full build)

The complete build is now the default, so quick runs need explicit opt-outs:

```
node enrich.js --no-pc-crawl              # skip Pass 3b discovery (much faster)
node enrich.js --no-pc-crawl --pc-limit 50 --hdb-limit 50   # tiny test run
node enrich.js --skip-funko --skip-pc     # HobbyDB-only pass
```

## Defaults changed (for the record)

| Option        | Old   | New (complete-by-default) |
|---------------|-------|---------------------------|
| `pcCrawl`     | off   | **on** (Pass 3b discovery) |
| `pcFillUpc`   | off   | **on** (UPC top-up)        |
| `pcLimit`     | 500   | **100000** (no real cap)   |
| `hdbLimit`    | 200   | **5000**                   |
| `pcCrawlLimit`| —     | **Infinity**               |

Disable any with `--no-pc-crawl`, `--no-pc-fill-upc`, `--pc-limit N`, `--hdb-limit N`.
