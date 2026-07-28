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
  Funko dataset into the catalog by handle/title. Image URLs from this source
  (HobbyDB CDN) are filtered through `isFigureImage()` (S17) — non-figure media
  (pins/keychains/plush/PEZ/shirts; see `NON_FIGURE_MEDIA`) is rejected so a figure
  record never inherits a merch photo (the "Thumper shows a pin" bug). Rejected →
  `imageName` left empty (placeholder), not a wrong image.
- **Pass 2 — funko.com scrape** (`passFunkoCom`): Puppeteer + stealth scrape of
  funko.com for catalog data.
- **Pass 3 — PriceCharting market values** (`passPriceCharting`): the core
  pricing pass. Searches PriceCharting's HTML search page through Puppeteer,
  picks the best variant by score, applies a **confidence gate**, and on a
  confident match harvests all three grade prices (loose/complete/mint) plus
  metadata (UPC, release date, ePID, etc.) from the product page.
- **Pass 3b — PriceCharting catalog crawl** (`passPriceChartingCrawl`,
  `--pc-crawl`): walks every Funko "console" set on PriceCharting and DOWNLOADS-AND-
  ADDS every Pop (deduping only by pricechartingId), visiting each Pop's product
  page to harvest its UPC so the record is scannable. It does NOT try to match
  against existing catalog records mid-crawl — PriceCharting titles differ too much
  from catalog titles for that to be reliable, so duplicates against the existing
  catalog are collapsed later in post-process `dedupeAndMerge`. Sets are discovered
  from `/category/funko-pops` (the full ~109-set index — NOT `/search-products`,
  which surfaces only ~28 popular sets and was the cause of a major coverage gap),
  unioned with a hardcoded 109-set fallback so discovery can only add, never
  regress. This is the pass that delivers PriceCharting's full breadth. Each
  console page is loaded once and SCROLLED to the bottom until its row count
  stabilizes (PriceCharting lazy-loads figures via JS on scroll — there is no
  "next" link and `?page=N` is ignored, so a single fetch gets only ~150 of a
  set's figures; scrolling pulls all of them, e.g. all 534 for funko-pop-rocks).
  60-scroll hard cap per set.
- **Pass 4 — HobbyDB** (`passHobbyDb`): scrapes HobbyDB reference numbers
  (UPC, Funko #, HDBID, retailer SKUs).
- **Pass 5 — funko.com detail pages** (`passFunkoDetails`): franchise/series
  enrichment from funko.com product pages.

Post-processing always runs (not gated by `--skip-*`), and ORDER MATTERS:
remove non-Pop records FIRST (per-record, before any handle merge), then merge
duplicate handles, **extract Pop# from titles** (so funkoNumber is populated for the
dedup key), then **dedup — funko.com vs HobbyDB AND PriceCharting vs canonical**
(`dedupeAndMerge`), a safety-net non-Pop pass, and finally **derive grouping
fields** (`deriveGroupingFields`). PriceCharting records are added blind by Pass 3b
(download-and-add) and collapsed here, matched to existing records by funkoNumber +
core-name; this is why number extraction must run before dedup. Non-Pop removal must
precede the handle merge: a real
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

**Match order (Pass 3, per record):** (1) UPC-first — if the record has a usable
UPC, query PriceCharting by UPC; an exact Funko row is taken directly (the
confidence gate TRUSTS a UPC match, skipping the name check). (2) Title search with
the funko number appended ("name #NN") — number disambiguates same-named figures;
rows are scored and gated by `pcMatchConfident`. Many Funko UPCs are NOT in
PriceCharting's index, so UPC-first often falls through to title — that is expected,
not a bug. Items PC cannot price get `priceSource:'none'` (app fills via live tiers
on add).

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
# COMPLETE BUILD (default) — Pass 3b discovery, no pricing cap, uncapped HobbyDB,
# UPC fill, and title cleanup are ALL on by default. This is the golden-master run.
node enrich.js

# quick validation run (opt OUT of the heavy passes)
node enrich.js --no-pc-crawl --pc-limit 20 --hdb-limit 20 --output test_output.json
```

**Completeness defaults (changed this session)** — a plain `node enrich.js` is
now the most complete build, not a partial one:

| Option         | Old | New (default) | Disable with         |
|----------------|-----|---------------|----------------------|
| `pcCrawl` (3b) | off | **on**        | `--no-pc-crawl`      |
| `pcFillUpc`    | off | **on**        | `--no-pc-fill-upc`   |
| `pcLimit`      | 500 | **100000**    | `--pc-limit N`       |
| `hdbLimit`     | 200 | **1000000** (uncapped) | `--hdb-limit N` |
| `pcCrawlLimit` | —   | **Infinity**  | `--pc-crawl-limit N` |
| `repriceOlderThan` | — | **0 (off)** | `--reprice-older-than N` (days) |

Pass 3b is the ONLY pass that grows the record set beyond Kenny Chan + funko.com,
so it stays on for the master. **Resume behaviour:** with the caps now uncapped one
run usually clears everything, but resume still protects against crashes and partial
runs. Progress markers (hdbChecked, prices, discovered records) live in the ENRICHED
OUTPUT, not the base — so unless `--input` is passed explicitly, a run RESUMES from
the prior `funko_data_enriched.json` when it contains ENRICHMENT MARKERS (any of
hdbChecked / marketValue* / pricechartingId / upc). NOTE: do NOT gate resume on
output-vs-base SIZE — the output is intentionally smaller than the base (~16k vs
~24k) after non-Pop removal and dedup, so a size test wrongly rejects a good file and
restarts from scratch (this was a real bug, now fixed). A resumed run skips
already-done work (hdbChecked, priced, discovered-by-pcId) and advances anything
outstanding. Pass `--input funko_data.json` explicitly to force a clean rebuild.

**Run-till-flat loop:** re-run while three numbers keep climbing — `records`
(Pass 3b), `priced` (Pass 3), `upc` (Pass 4/fill). Stop when two runs match =
sources' ceiling.

**Title cleanup (post-process step 1b, `cleanTitles`)** runs every build: decodes
HTML entities (`&amp;`→`&`), straightens smart quotes, strips a leading
"Funko Pop!"/"Pop!" prefix and a trailing "(Bobble-Head)". It deliberately does
NOT touch `#numbers`, variant qualifiers ((Flocked)/(Prototype)/(Signed by…)), or
**series-colon titles** like "Thor: Ragnarok" / "Soldier: 76" / "White Lantern:
Batman" — the colon is part of the real name, so stripping it would destroy data
(verified against all 63 such records). Do NOT add a series-colon strip.

**Category from console (`deriveGroupingFields` → `categoryFromConsole`)** runs every
build: Pass 3b-discovered records are born with only a console slug + pricechartingUrl
and no category, so they would import category-blank (wrong in the app, and invisible
to the dynamic category dropdown, which reads distinct catalog categories). The
derivation maps the PriceCharting console slug to a category — `funko-pop-rides` →
"Pop! Rides", `funko-pop-rocks` → "Pop! Rocks" — fills `category` only when blank
(never overwrites HobbyDB/funko.com), and seeds the `series` array on bare records.
This is what makes the discovered breadth show up correctly AND feed the app's
auto-growing category dropdown. Cosmetic edge: a few slugs title-case imperfectly
("Pop! 8 Bit" vs "Pop! 8-Bit"); the app's curated CategoryDef list overrides display
casing on key collision, so add an exact-cased entry there if a label matters.

Audit a run with `node check_test_output.js <file>` (totals + sample URLs to
spot-check on pricecharting.com). Always spot-check a few sample prices/UPCs
against the live site — the console proves the plumbing ran, only eyeballing
proves the match picked the right figure.

Flags: `--skip-kenny/-funko/-hdb/-funko-detail/-pc`, `--pc-limit N`,
`--pc-crawl`/`--no-pc-crawl`, `--pc-crawl-limit N`, `--pc-fill-upc`/`--no-pc-fill-upc`
(revisit priced records missing a UPC), `--hdb-limit N`, `--chrome-path "C:\..."`,
`--input`, `--output`. Console set list for the crawl is auto-discovered; a
hardcoded fallback exists if discovery fails.

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
- `pc_match_diagnostic.js` — read-only match-rate diagnostic; breaks unpriced
  failures down by fixable lever (UPC / number / parser / title-only) + verdict.
- `clean_nonfigures.js` — removes pure non-figure merch by exact title (Pop-signal
  protected); writes a `*.clean.json`, leaves original intact.
- `stamp_pricesource.js` — adds the `priceSource` flag ('pricecharting'|'none') to
  an already-enriched file without re-running the pipeline (local pass, ~2s).
- `export-community-delta.js` — community UPC delta export.
- `funko_data.json` — base input. `funko_data_enriched.json` — output.
- `test_*.js`, `dump-hdb.js`, `fix_typo.js` — one-off probes/utilities.

## DEC-031 — Pass 3b crawl completeness (root fix, do not re-chase)

**Symptom that kept recurring:** full runs silently truncated the crawl — whole
tail-end waves (e.g. Guardians of the Galaxy Holiday Special #1104-1106) never
entered the record set, and NO "may be incomplete" warning appeared in the log.
Each prior fix patched one stall path and the failure reappeared elsewhere.

**Root cause (single class of bug, three surfaces):** the crawl trusted one
fragile signal — `targetCount`, parsed from two English-only regexes. When it
returned 0 (locale/markup/late-load), the code treated "unknown target" as
"done": it accepted the first ~150-row lazy-load batch, never retried, and the
only truncation warning was gated on `targetCount > 0` so it never fired. The
resume gate had the same disease (`setTarget>0 ? … : setRowsLoaded>0`), marking
a truncated unknown-target set COMPLETE and skipping it forever.

**Fix (in enrich.js passPriceChartingCrawl):**
1. Target parsed from MULTIPLE independent signals (en + locale-agnostic "<N>
   Funko", "of/de <N>", collection-tracker "/ N items", table data-attrs); take
   the max. `targetKnown` records whether ANY signal parsed.
2. Unknown target no longer means "done" — it means "crawl to PROVEN
   exhaustion": require UNKNOWN_CONFIRM(3) consecutive fresh-browser attempts
   with zero new rows before accepting. First-batch acceptance is now impossible.
3. Resume gate only marks an unknown-target set done if it was confirmed
   exhausted (recorded in unknownTargetSets), never on "any rows loaded".
4. Unconditional per-set `[set-audit]` line + a run-end completeness summary
   listing every INCOMPLETE and every UNKNOWN-target set. Truncation can never
   again be invisible.

**How to verify a future run is complete:** check the "Pass 3b completeness
audit" block at the end. `✓ All sets loaded to their stated target` = good.
Any set listed under INCOMPLETE or UNKNOWN = figures may be missing there;
re-run (resume re-crawls unfinished sets) or investigate that set's page.
`targetKnown` is hoisted (let, outside the try) so the resume gate can read it.

---

## Session state — 2026-07-28 (fusion guard, non-Pop filter, DQ sweep)

This section is the current working state. If you are a fresh session, read this
first — it supersedes older notes where they conflict.

### Where things stand

`enrich.js` now contains THREE stacked fixes, all taking effect on the NEXT full
re-crawl:
1. **DEC-031** crawl-truncation (see section above) — already verified working on
   the run that produced the 30,353-record catalog.
2. **Fusion guard** (Fix 1 below).
3. **Non-Pop console filter** (Fix 2 below).

The currently-shipped catalog (`funkodex_base_catalog.enriched.json`, 30,353
records) still contains the fusion + Bitty problems — they are fixed in code but
only disappear once the re-crawl regenerates the file.

### Fix 1 — funkoNumber fusion guard (Pass 3 meta loop)

**Symptom:** 71 records had a `funkoNumber` belonging to a DIFFERENT figure than
their title. E.g. one record read title `Drax #50` (2014 GotG Series 1 Drax) but
`funkoNumber: 1106` (2022 Holiday Drax) — two distinct real Pops fused into one,
and one real figure lost from the catalog per fusion. Confirmed by external
lookup on Drax, Gamora (#51 vs #873), Colossus (#60 vs #183) — every case is two
real different Pops, not a mislabel.

**Root cause:** in Pass 3, when `searchPriceCharting` returns an APPROXIMATE match
(`pcMatchConfident` `conf.ok=true` but `conf.approximate=true` — PC matched a
different figure by shared base name), the meta-transfer loop copied every field
fill-if-missing. UPC was guarded (`upcTransferAllowed`), but `funkoNumber` rode
through unguarded. A box number is an exact product identifier — same class as
UPC — so the wrong figure's number got stamped onto a record that kept its own
correct title.

**Fix:** in the meta loop, `funkoNumber` now rides the same gate as UPC —
`if (k === 'funkoNumber' && !exactIdTransferAllowed) continue;` where
`exactIdTransferAllowed` = matched-by-upc OR exact core-name, never approximate.
On an approximate match the field is left EMPTY, and `extractNumbersFromTitles`
then backfills the correct number from the record's own title. (Pass 3b crawl
apply is already safe — there rec and detail come from the same product page.)

**Recovery of the 71:** chosen approach is re-crawl fresh, NOT file-surgery — a
clean run with the guard regenerates both figures correctly from their own PC
pages. Post-run, verify both `Drax #50` AND `Drax #1106` exist as separate
records.

### Fix 2 — non-Pop console filter (isNonPop)

**Symptom:** 412 non-Pop records shipped in the catalog — 298 Bitty Pop, 89
Fantastik Plastik, 25 Mystery Minis. Bitty Pops (0.9" multipack micro-figures)
and Mystery Minis (blind-box minis) are not Pops; Fantastik Plastik is a separate
Funko vinyl line.

**Root cause:** `isNonPop`'s first line `if (rec.funkoSource) return false` skips
all pricecharting records as pre-vetted — but these ARE pricecharting crawl rows,
and their titles are plain character names ("Ralph", "Ursula") so no title/series/
image filter would catch them anyway. The only reliable signal is the PriceCharting
console slug in `pricechartingUrl` (`.../game/<console>/...`).

**Fix:** added `NON_POP_CONSOLES` = {funko-pop-bitty, funko-pop-minis,
funko-pop-fantastik-plastik} + a `pcConsoleOf(rec)` helper, and a check
`if (NON_POP_CONSOLES.has(pcConsoleOf(rec))) return true;` placed BEFORE the
`funkoSource` early-return. Simulated on the real file: drops exactly 412, zero
collateral (30,353 → 29,941).

**KEEP (do not add to NON_POP_CONSOLES)** — these are real Pop sub-lines and
dropping them would delete real figures: the "covers" families (comic-covers,
vhs-covers, movie-posters, magazine-covers, game-covers, art-cover, art-series),
albums, 8-bit, die-cast, plus, moment, deluxe-moment, trading-cards.

NOTE: the bitty console is auto-discovered by `discoverFunkoConsoles()` from PC's
`/category/funko-pops` page, so removing it from the hardcoded `PC_FUNKO_CONSOLES`
fallback list would NOT stop the crawl — the removal filter is the right layer.

### Post-re-crawl verification checklist

1. `Pass 3b completeness audit` block shows `✓ All sets loaded to their stated target`.
2. Fusion check: no record where a `#NN` in the title != `funkoNumber`, EXCLUDING
   ~8 comic-cover false positives (comic covers, "Tales of Suspense #39/40",
   "Avengers #57", "Vol N" — where #NN is a comic issue number, legit content).
3. Bitty / Mystery Minis / Fantastik Plastik count = 0.
4. Both `Drax #50` and `Drax #1106` exist as separate records.
Then rebuild the app asset: `build_catalog_asset.py` → copy `.gz_` to
`app\src\main\assets\`, bump `CatalogPreloader.CATALOG_VER`, verify the APK entry
is ~2.3 MB, fresh-install, confirm logcat `Catalog loaded: <N> items`.

### Open DQ backlog (found this session, NOT yet fixed)

In rough priority:
- **~183 non-Bitty UPC collisions** — different figures sharing one barcode (e.g.
  Mothman #27 / Loch Ness #18 on UPC 883975152741; Naruto #726 / Sasuke #1436).
  Some are legit (other multipack lines, or one figure listed under two PC
  consoles), some are genuine mis-staples. NEEDS per-figure external verification —
  DO NOT auto-fix.
- **17 SKU-as-funkoNumber records** — a retailer SKU landed in `funkoNumber`
  instead of the box number (Raichu #171367, Freddie Mercury #85872, mostly
  Pokémon + convention exclusives; all >50000). Likely a HobbyDB reference-parse
  issue. Small, isolated.
- **141 true-duplicate clusters** — same figure as two records (usually base vs
  pc- crawl record, e.g. Darth Vader #1 twice), identical title+number.
  Mechanically collapsible, low risk.
- **78 leading-zero funkoNumbers** — `#08` vs `#8` inconsistency, mostly "...Box"
  records. Trivial normalize.
- **~39 variant-merge groups** — base + variant that should be one record
  (Wonder Woman Box #08 + Wonder Woman (Metallic) #8), shared UPC is correct.

**Structural health otherwise EXCELLENT:** 0 duplicate _id, 0 handle mismatch,
series 100% string-typed, prices sane, no true shells (the ~5,591 sparse records
are valid base records pending the app's live-tier fill).

**CLEARED this session (not DQ problems):** V #223 (BTS Dynamite V, Funko Item
48113) and L #219 (Death Note L with Cake, Funko Item 93291) — legitimately
single-letter real names, both externally verified. And Bitty/multipack shared
UPCs are correct by design (a Bitty 4-pack shares one barcode across its figures).

### Hard-won process rule (this project)

NEVER adjudicate a figure's identity from inside the file — verify against an
external source (funko.com / PriceCharting / eBay). "Same number across different
names" and "same UPC across different figures" are both CANDIDATES to verify, not
errors to auto-fix: cross-series number reuse is normal (Gamora #51 vs #873, L
#219 Death Note vs a DC figure), and multipack/variant shared UPCs are legitimate.
This session, identity guesses made from the file alone were wrong three times and
caught by the user each time; every fix that stuck was grounded in an external
lookup.
