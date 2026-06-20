# funko_enrich — Handoff

**Date:** 2026-06-20
**Repo:** github.com/celticht32/funko_enrich
**Local:** C:\Downloads\Development\funko_enrich\

Node.js + Puppeteer pipeline that builds/enriches a Funko Pop catalog
(`funko_data_enriched.json`) the FunkoDex Android app imports. Separate project
from the app. See `CLAUDE.md` for the full pipeline description and `README.md`
(`enrich_README.md`) for the run guide.

---

## Current state

**Latest (2026-06-20, with FunkoDex Session 15): grouping fields added.**
POST-PROCESS 5 (`deriveGroupingFields`) now emits two fields the app's
series-completion feature consumes:
- `setTag` — the most-specific named set a figure belongs to (e.g. "Haunted
  Mansion Mini Vinyl Figures"), from the `series` array. Rule: a tag ending in a
  specific set suffix (Mini Vinyl Figures / Advent Calendar / Mystery Box / Vinyl
  Sets / …), excluding Pop! lines, retailer/convention exclusives, and the generic
  broad lines (Disney/Funko Mini Vinyl Figures, Advent Calendar). Lowest-frequency
  tiebreak. Verified: 13 clean sets, Haunted Mansion 19/19.
- `franchiseSuggestion` — a property-level franchise. Prefers the cleaned
  PriceCharting `pcSeries` (split on `.`/`,`, drop retailer/event noise →
  "Dragon Ball Z", "Hocus Pocus", "Garfield"), falling back to a property-specific
  console slug. Umbrella consoles (disney/animation/movies/marvel/…) yield nothing.
  Verified: coverage 57 (console-only) → 630 (pcSeries-first); Hocus Pocus resolves.

Both are SUGGESTIONS — the app's user-assigned franchise always wins; setTag drives
the secondary named-set completion. Computed from data already on the record, no
extra network. Runs as the final post-process before write, so it sees the full
crawled/merged set.

**Run note:** default `--input` is `funko_data.json` (the 23,940 base). For a clean
rebuild that loads the base, omit `--input` (current S15 rebuild does this). For an
incremental EXTEND that preserves prior enrichment, pass
`--input funko_data_enriched.json`. Always back up `funko_data_enriched.json`
before a run that writes to it.


The PriceCharting integration is complete and validated against a full production
crawl run:

- **Pass 3 (pricing)** works end to end: HTML-search → variant scoring →
  confidence gate → product-page price + metadata harvest. Verified parsers
  against real saved pages.
- **Pass 3b (catalog crawl, `--pc-crawl`)** auto-discovers all ~29 Funko console
  sets and adds missing Pops, visiting each product page to harvest its UPC. A
  production chunk discovered **1000 new Pops, ~94% with UPCs** in one run.
- **`--pc-fill-upc`** revisits already-priced records that lack a UPC to backfill
  it (the path to completing UPC coverage).
- **Approximate base-price fallback** (latest change): when a variant record
  matches the exact same base figure that PriceCharting doesn't list separately,
  it prices from the base figure and sets `marketValueIsApproximate: true` rather
  than skipping. Exact core-name match required, so different figures (Orange
  Piccolo, Robin as Nightwing) still skip. The app shows these as
  "Market avg (approx)" with a `~`.

A 200-item production slice returned 57 exact + some approximate matches, with a
high uncertain-skip rate that is mostly correct (the slice was variant-heavy:
Imperial Palace, prototypes, box sets).

---

## Bugs fixed this round (all verified against real pages)

- **Wrong-figure matches** (Freddy Frostbear → Baseball Freddy, IG-11 → The
  Child): added `coreNameCovered` so a shared common word can't carry a match.
- **Cross-category matches** (FNAF Game → a PlayStation 5 title): search filtered
  to `funko-pop-*` consoles only.
- **Concatenated UPC** (two UPCs in one product-page cell joined into a 24-digit
  string): `normalizeUpc` takes the first valid 12–13 digit run.
- **Substring false matches** (Piccolo → Orange Piccolo): the approximate
  fallback requires `coreNameExact` (set-equal), not just covered.
- **Product-page URL built from numeric id** (404s, silent metadata-harvest
  failure): now navigates the listing/search row's real name-slug `href`.
- **Leftover `prices.` reference** crashing the first item: fixed to use the
  loose/complete/mint locals.

---

## Next steps

1. **Scale the production crawl** in chunks (`--pc-crawl-limit`, raise
   `--pc-limit`). Resumable — priced+UPC'd records skip on re-runs. Full catalog
   across all 29 sets with per-Pop UPC harvest is a multi-day job; run in chunks.
2. **Re-run the 200-item slice** with the approximate fallback and check the new
   `Found: N (M approximate)` line — that M is how many old skips were recovered.
   If M is small, the batch was genuinely unrecoverable and the gate was right.
3. **Spot-check** sample prices/UPCs against pricecharting.com after each chunk
   (`check_test_output.js` prints sample URLs). The console proves plumbing; only
   eyeballing proves the matched figure is correct.
4. **Watch the uncertain count.** If it's high on a *mainstream* batch (not a
   variant-heavy slice), revisit the gate; on variant/merch-heavy slices a high
   skip rate is expected and correct.

---

## Known limits / open items

- **Not every PriceCharting product page has a UPC** ("none"), so UPC coverage
  is "most," not "all." HobbyDB (Pass 4) is the other UPC source.
- **Crawl-discovered records use `handle: pc-{id}`** and dedup on PriceCharting
  id only; a Pop already in the catalog under a HobbyDB handle without a PC id
  could double-add. The app-side importer matches on UPC to catch some of this.
- **A synonym map was considered and rejected** for the current data — there were
  few true vocabulary mismatches; the dominant pattern was "PriceCharting lists
  only the base figure," which the approximate fallback handles. Revisit a synonym
  map only if a future batch shows many SE↔Special-Edition style misses.
- **ToS:** this scrapes data PriceCharting sells API access for. Polite delays are
  in place; be aware of the risk at scale.

---

## Sync note

`CLAUDE.md`, `HANDOFF.md`, and `CHANGELOG.md` here are the **enricher's** docs.
They were briefly overwritten by the FunkoDex app's docs of the same name and
recreated. Do not copy the app's CLAUDE/HANDOFF/CHANGELOG over these — they are
different projects.
