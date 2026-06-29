# IDEA: Browse-Set Want-List with Marketplace Availability (FunkoDex)

Status: IDEA — not started. Design AFTER enrichment completes (depends on the
final grouping fields; designing against mid-enrichment data would key on the
wrong field — see "Hard dependency" below).

License: MIT © 2026 Chris Ahrendt

---

## What it is

A browse/search view that lets you pick a set or theme (e.g. "Haunted Mansion")
and see every Pop in that set, with the ones you DON'T own clearly marked, so you
can build a want-list. Optionally, for the items you don't own, show whether each
is currently available to buy (eBay first) with an asking price and a buy link.

Essentially: "show me everything in <set>, what I'm missing, and where I can get it."

## Why it's valuable

Turns the catalog from a lookup tool into a collection-completion tool. Pairs
directly with the existing series-completion / franchise-grouping work
(SERIES_COMPLETION_SPEC). The want-list is the natural front-end to set membership.

## Three data dependencies

1. **A reliable grouping field to search/filter on.** "Haunted Mansion" must be a
   queryable value on every Pop in that set. WHICH field holds the specific set
   name (`setTag` vs `pcSeries` vs `series[]` vs `category`) is NOT settled until
   post-process `deriveGroupingFields` runs. Mid-enrichment, the specific value
   may live only in `series[0]` (observed on the Mickey "Disneyland Resort 65th
   Anniversary" record) while the canonical grouping fields are still empty. Lock
   the field against FINAL enriched data.

2. **Full set membership.** "Items in <set> you don't have" requires EVERY Pop in
   that set to be in the catalog — exactly what the Pass 3b crawl-completeness work
   fixed (truncation meant sets were partial). Feature quality == crawl
   completeness. Another reason to design post-enrichment.

3. **Owned/not-owned join.** App-side, already exists in concept: collection
   (`funko::` docs) vs catalog (`catalog::` docs). Filter catalog items in a set,
   mark owned, show the gap. Independent of the enrichment; depends on field #1.

## Marketplace availability (the "where can I buy it" signal)

Realistic scope, ordered by feasibility:

- **eBay active listings — DO THIS FIRST (80/20).** `PriceService` already queries
  eBay SOLD listings for pricing via
  `ebay.com/sch/i.html?LH_Complete=1&LH_Sold=1&_nkw=<q>`. Dropping the
  `LH_Complete`/`LH_Sold` flags returns ACTIVE listings = "buy it now for $X."
  Reuses the existing query construction (incl. variant-specific query for chase
  items), the browser-UA fetch, and the HTML parse pattern. New method
  `fetchEbayActive()` mirroring `fetchEbaySold()`. Show "Available on eBay — from
  $X" + tap-through link per unowned item. eBay is where most secondary-market
  Funko buying happens, so this alone covers most of the practical need.
  - Caveat: HTML scraping is fragile (markup changes) and heavy use risks
    challenge/rate-limit pages (code already notes the UA challenge). Fine at
    personal/low volume. DURABLE upgrade path: eBay Browse API (official, needs
    API key + OAuth) — note as the scale route, same spirit as R2 for catalog
    hosting.

- **Amazon — later, optional.** Product Advertising API exists but requires an
  affiliate account in good standing with sales activity. Real setup friction.

- **PriceCharting — N/A for availability.** It's a price guide, not a marketplace.
  Already used for price; not a "buy now" source.

- **Other retailers (Funko shop, Entertainment Earth, Hot Topic, etc.) — NOT in
  scope.** No general "is this in stock anywhere" API; each is a separate fragile
  scrape or gated API. Avoid the per-retailer integration treadmill.

Recommendation: ship eBay-active only as the availability signal. Don't generalise
to "any site" — that's mostly-no-API integrations with poor ROI.

## Hard dependency / sequencing

- Wait for enrichment to finish (crawl + pricing + post-process → final golden
  master).
- Sample the finished data to lock the grouping field (field #1). This SAME sample
  also unblocks the relink field-mapping and the series-completion feature — all
  three depend on the same unknown (which final field carries the specific set /
  property name). One investigation unblocks all three.
- UI/layout decision: per Chris's preference, show RENDERED options for the
  "browse set → want-list" view (and the availability row) for approval BEFORE
  writing them into a spec/BRD.

## Components (when built)

- Catalog query by grouping field (the want-list browse).
- Owned/not-owned join against `funko::` docs.
- `fetchEbayActive()` in `PriceService` (active-listing variant of
  `fetchEbaySold()`), returning asking price + item URL.
- Want-list UI: set picker → list with owned markers → per-unowned availability
  row (eBay from $X + buy link).

## Related

- SERIES_COMPLETION_SPEC (set membership / franchise grouping) — shares field #1.
- CollectionRelinkService golden-source mapping — shares field #1.
- PriceService eBay tier — reused for availability.

---

## Addendum: variant grouping (discovered during cleanup)

The enriched catalog is FLAT for variants: e.g. Spider-Man #1329 exists as 9
independent top-level records (Spider-Man, (Wood Deco), (Hologram), (Gold Eyes),
...). There is NO variant marker field — no `isVariant`, `variantOf`, `baseHandle`.
They share only `funkoNumber` + base name (in the title parenthetical).

The APP has a variant system (`FunkoItem.variants: List<FunkoVariant>`, `isChase`,
`isMissingOriginal`) but it is for USER-managed variants of owned items, NOT auto-
populated from the catalog's flat variant records. So on import, the 9 records come
in as 9 separate catalog entries — they are NOT grouped as variants.

For ownership tracking this flat structure is CORRECT — collectors own specific
variants individually. But the want-list / series-completion features would benefit
from knowing variants share a base figure (to show "Spider-Man #1329 — you have
2 of 9 variants"). That grouping needs either:
  (a) a catalog field linking variants (e.g. `variantGroup` / `baseFigure` key
      derived in post-process), or
  (b) the app grouping by `funkoNumber` + normalized base-name at display time.

This is part of the SAME unresolved grouping-field question as the relink mapping
and set membership — design it against FINAL enriched data, with rendered UI
options for approval. Do NOT add variant markers blindly now (risks designing
against the wrong field). Captured here so it is not forgotten.
