# CLAUDE.md — funko_enrich

`funko_enrich` is a **Node.js + Puppeteer** pipeline that builds and enriches a
Funko Pop catalog (`funko_data_enriched.json`) from a base dataset
(`funko_data.json`, ~23,940 records). It is a **separate project** from the
FunkoDex Android app; this repo produces the enriched catalog the app imports.
GitHub: `github.com/celticht32/funko_enrich`.

This file orients an AI assistant working on the enricher. The companion
`enrich_README.md` (published as `README.md`) is the user-facing run guide.

---

## What it does

`node enrich.js [flags]` reads `funko_data.json`, runs a series of enrichment
passes, applies post-processing, and writes the output file. Each pass is
independently skippable so a run can target just the work that's needed.

### Passes (in `enrich.js`)

- **Pass 1 — Kenny Chan merge** (`passKennyChan`): merges the Kenny Chan GitHub
  Funko dataset into the catalog by handle/title.
- **Pass 2 — funko.com scrape** (`passFunkoCom`): Puppeteer + stealth scrape of
  funko.com for catalog data.
- **Pass 3 — PriceCharting market values** (`passPriceCharting`): the core
  pricing pass. Searches PriceCharting's HTML search page through Puppeteer,
  picks the best variant by score, applies a **confidence gate**, and on a
  confident match harvests all three grade prices (loose/complete/mint) plus
  metadata (UPC, release date, ePID, etc.) from the product page.
- **Pass 3b — PriceCharting catalog crawl** (`passPriceChartingCrawl`,
  `--pc-crawl`): walks every Funko "console" set on PriceCharting (auto-discovered
  from their category nav) and adds Pops not already in the catalog, visiting each
  new Pop's product page to harvest its UPC so the record is scannable.
- **Pass 4 — HobbyDB** (`passHobbyDb`): scrapes HobbyDB reference numbers
  (UPC, Funko #, HDBID, retailer SKUs).
- **Pass 5 — funko.com detail pages** (`passFunkoDetails`): franchise/series
  enrichment from funko.com product pages.

Post-processing always runs (not gated by `--skip-*`), and ORDER MATTERS:
remove non-Pop records FIRST (per-record, before any handle merge), then merge
duplicate handles, dedup funko.com vs HobbyDB, a safety-net non-Pop pass, extract
Pop# from titles, and **POST-PROCESS 5 — derive grouping fields**
(`deriveGroupingFields`). Non-Pop removal must precede the handle merge: a real
Pop and a non-Pop (Wacky Wobbler, Mystery Mini, etc.) can share one HobbyDB
handle, and merging first unions their series so the non-Pop tag contaminates the
fused record and the whole thing — including the real Pop — gets dropped.
POST-PROCESS 5 emits two fields the FunkoDex series-completion feature consumes,
computed from data already on each record (no network):
- `setTag` — most-specific named set from the `series` array (specific set suffix;
  excludes Pop! lines, retailer/convention exclusives, and generic broad lines;
  lowest-frequency tiebreak).
- `franchiseSuggestion` — property-level franchise, preferring the cleaned
  PriceCharting `pcSeries` row (retailer/event suffixes stripped), else a
  property-specific console slug (umbrella consoles excluded).
Both are suggestions; the app's user-assigned franchise is authoritative. Added to
`MERGE_FIELDS` so they survive duplicate-handle merge.

---

## PriceCharting matching — the heart of Pass 3

Cross-database variant matching is the hard part. Our catalog and PriceCharting
name variants differently, and a wrong-variant price is worse than no price (a
chase can be worth far more than the common figure). So Pass 3 is deliberately
conservative. Key helpers in `enrich.js`:

- `pcSearchQuery(title)` — strips parenthetical/bracketed qualifiers and `#NN`,
  appends "funko", so the search uses the core character name.
- `variantTokens(title)` — the meaningful words inside qualifiers, stopwords
  removed (so "Glow In The Dark" → `[glow, dark]`, not matching plain rows via
  "in"/"the").
- `scorePcRow(row, rec)` — ranks search rows by variant-token overlap + funko
  number, penalising unwanted variant tags.
- `coreNameTokens` / `coreNameCovered` / `coreNameExact` — name-overlap checks
  that stop same-number / shared-word false matches ("Freddy Frostbear" →
  "Baseball Freddy") and substring false matches ("Piccolo" → "Orange Piccolo").
- `pcMatchConfident(row, rec)` — the gate. Returns `{ ok, reason, approximate }`:
  - base record + base row, exact core name → confident.
  - record's variant token appears in row + core name covered → confident.
  - **approximate fallback:** record wants a variant PriceCharting lists only as a
    base figure, and the row is the *exact same* character (set-equal core name,
    no conflicting variant tag) → confident but `approximate: true`. Recovers
    same-character variants (Krillin Metallic) without accepting different figures
    (Orange Piccolo, Robin as Nightwing).
  - otherwise → `ok: false`, skipped and logged as uncertain.

`approximate` matches set `marketValueIsApproximate: true` on the record; the
FunkoDex app reads that flag and displays "Market avg (approx)" with a `~`.

Search is constrained to `funko-pop-*` consoles so a video game / card of the
same name can't match. `normalizeUpc` takes the first valid 12–13 digit run so a
multi-UPC product-page cell can't produce a concatenated invalid barcode.

---

## Verified facts (do not re-derive from memory)

- **PriceCharting serves product/listing pages to Puppeteer and to a plain
  Android-UA fetch** (no JS challenge) — confirmed via `test_okhttp_pricecharting.js`.
  This is why the FunkoDex app can use a lightweight OkHttp re-scrape.
- **Product URLs use the name-slug, not the numeric id**
  (`/game/funko-pop-ad-icons/twinkie-the-kid-27`). Scrape via the listing row's
  `href`, never reconstruct from id.
- **Prices** are in `#used_price` / `#complete_price` / `#new_price` as `$N.NN`
  text (commas for thousands; grail prices like $2,338 are real, not parse bugs).
- **Listing rows carry all three prices inline but NO UPC**; UPCs come only from
  product pages. Hence Pass 3b visits each new Pop's product page.
- **The confidence gate skipping a lot on a variant-heavy batch is usually
  correct**, not a bug. One 200-item slice heavy with Imperial Palace / prototype /
  box-set items skipped ~55%; mainstream batches skip far less.

---

## Run patterns

Test small first, then scale in chunks (it's resumable — priced+UPC'd records
skip on re-runs):

```
# small validation run
node enrich.js --skip-kenny --skip-funko --skip-hdb --skip-funko-detail \
  --pc-crawl --pc-crawl-limit 10 --pc-fill-upc --pc-limit 20 --output test_output.json

# production chunk
node enrich.js --skip-kenny --skip-funko --skip-hdb --skip-funko-detail \
  --pc-crawl --pc-crawl-limit 500 --pc-fill-upc --pc-limit 200 --output funko_data_enriched.json
```

Audit a run with `node check_test_output.js <file>` (totals + sample URLs to
spot-check on pricecharting.com). Always spot-check a few sample prices/UPCs
against the live site — the console proves the plumbing ran, only eyeballing
proves the match picked the right figure.

Flags: `--skip-kenny/-funko/-hdb/-funko-detail/-pc`, `--pc-limit N`,
`--pc-crawl`, `--pc-crawl-limit N`, `--pc-fill-upc` (also revisit priced records
missing a UPC), `--chrome-path "C:\..."`, `--input`, `--output`. Console set list
for the crawl is auto-discovered; a hardcoded fallback exists if discovery fails.

---

## Handling a pasted run (workflow)

When the user pastes enrich.js console output or uploads a `test_output.json` /
`funko_data_enriched.json`, this is what they want done with it — don't just
summarize the totals.

**1. Read the summary line.** `Found: N (M approximate) | UPCs filled: U |
Uncertain (skipped): S | Not found: F | Errors: E`. Errors should be 0 — any
non-zero error count is a real bug to investigate. `M approximate` is how many
were priced from a base figure (variant not separately listed).

**2. Classify the uncertain skips — this is the main thing they want.** Each
skip prints `→ "matched row name"`. Read those annotations and sort the skips:
- **Correct skip — not in PriceCharting:** tees, backpacks, hats, "Box" collector
  sets, pins, advent calendars, prototypes. No real Pop equivalent. Right to skip.
- **Correct skip — different figure:** the matched name is clearly another
  character ("Freddy Frostbear" → "Baseball Freddy", "Piccolo" → "Orange
  Piccolo"). The gate did its job.
- **Possibly-false skip — worth a look:** the matched name is the *same*
  character but a different/renamed variant ("Hagrid (With Tree)" → "Rubeus
  Hagrid"). These are the only ones worth investigating; if there are many,
  consider whether the gate or a synonym/vocabulary issue is the cause.
Tell the user which bucket dominates. A high skip rate made of buckets 1–2 is
expected and correct on a variant/merch-heavy slice — say so, don't alarm.

**3. Flag outlier prices, don't assume bugs.** Grail prices ($2,750 Vegeta, $262
Electro) are usually real — PriceCharting genuinely lists them. If a price looks
suspicious, the test is the saved product page, not a guess. A `$?` in a grade
means that grade had no data (fine if the others are present).

**4. Spot-check is mandatory before scaling.** The console proves the plumbing
ran; only opening 2–3 sample `pricechartingUrl`s (or running
`check_test_output.js`) proves the *matching picked the right figure*. Remind the
user to do this; a confident-but-wrong match still prints a clean `✓`.

**5. Remember the output file is post-processed.** Its record count is the
deduped/filtered number (~12k), NOT the 23,940 input — that's expected, not data
loss. The file is a test/production artifact, not a count check.

**6. If a parser looks wrong, ask for the saved HTML page.** The entire
debugging method here is verifying selectors against a real page the user saves
from their browser (Ctrl+S → "Webpage, HTML only"). Never patch a parser by
guessing at structure — request the page, verify against it, then fix.

---

## Environment / conventions

- Windows host; commands in cmd/PowerShell syntax.
- `npm install` required before first run (deps gitignored). Needs Chrome
  installed (auto-detected, or `--chrome-path`).
- Deps: cheerio, node-fetch, puppeteer / puppeteer-extra + stealth.
- Be polite: `PC_DELAY` 2.5s between PriceCharting requests; browser restarts
  every 200 records.
- Standing rule: verify HTML structure against a real saved page before trusting
  a parser; never assume selectors from memory. Flag opinions vs verified facts.

---

## Repo files

- `enrich.js` — the pipeline (all passes + post-processing).
- `enrich_README.md` — user run guide (publish as `README.md`).
- `check_test_output.js` — audit script for an output file.
- `export-community-delta.js` — community UPC delta export.
- `funko_data.json` — base input. `funko_data_enriched.json` — output.
- `test_*.js`, `dump-hdb.js`, `fix_typo.js` — one-off probes/utilities.
