#!/usr/bin/env python3
"""
merge_kenny_dupes.py  --  Session 23

Merges 11 Kenny/PriceCharting-stub duplicate PAIRS and deletes 1 pure duplicate.
Each pair is two catalog rows for ONE physical figure: a Kenny row (real name-slug
_id, has the image, no pricing) and a PriceCharting crawl stub (pc-NNNN _id, has
pricing and real series/franchise, no image).

Survivor is always the KENNY row: it holds the _id (never changed -- catalogRefs
may point at it) and the imageUrl (the stub's is ALWAYS empty, and enrich never
refetches images, so losing it loses it forever).

NEITHER SOURCE IS AUTHORITATIVE -- THIS IS THE POINT OF THE SCRIPT
------------------------------------------------------------------
The obvious rules are both wrong, and each was tested against live PriceCharting
pages in S23 rather than assumed:

  "Stub wins" would slugify 9 titles -- PriceCharting strips punctuation, and the
  punctuation IS the product name:
      Sam "Mayday" Malone      -> Sam Mayday Malone
      Pixie (Hanna-Barbera)    -> Pixie Hanna-Barbera
      More Cowbell!            -> More Cowbell
      The Dapper Dans (4-Pack) -> The Dapper Dans 4-Pack
  It would also write 3 wrong prices (see Katniss/Shark below).

  "Kenny wins" would keep the Santa Freddy mis-title and leave every `series` as
  the generic placeholder "Pop! Vinyl" instead of the real line.

So the rule is per FIELD CLASS, with three per-record overrides that were each
resolved by reading the live PC page. Do not "simplify" this into one rule.

CORRUPTION MARKER: a stub whose _id disagrees with its own pricechartingId is
corrupt. Two stubs in this set had it (pc-7531588 holding 7531589; pc-7489644
holding 10805742) and BOTH turned out to hold wrong data. That check is worth
running catalog-wide sometime.

FIELD CLASSES
-------------
  Kenny keeps : _id, handle, imageUrl, title, isChase, isExclusive,
                exclusiveRetailer
  Stub gives  : series, pcSeries, franchiseSuggestion, publisher, releaseDate
  Stub gives  : pricechartingId, pricechartingUrl, ebayEpid, marketValue*
                (pricing only where uncontested)

PER-RECORD OVERRIDES (each verified against the live PC page -- do not revert)
-----------------------------------------------------------------------------
  santa-freddy-funko  : STUB WINS on title/series/isExclusive.
      Kenny titles it "Santa Freddy Funko" -- that is the Funko MASCOT in a
      holiday sweater, a different figure which already exists separately as
      catalog::freddy-funko-santa #9. This record's own UPC (889698724883),
      number (#936) and PC url (funko-pop-GAMES/santa-fre...) all say it is the
      Five Nights at Freddy's Santa Freddy. Kenny's title drifted to the wrong
      product, and its isExclusive=True + "Funko Shop" belong to that mascot
      web-exclusive, not to this standard Pop! Games release.

  katniss-wedding-dress : KENNY WINS on pricing/pcId/pcSeries.
      The live page (funko-pop-movies/katniss-wedding-dress-230) contains pcId
      7489644 eight times and the stub's 10805742 ZERO times, and lists
      $19.99/$23.49/$29.99 -- Kenny's values, not the stub's $19.00/$40.35. The
      stub's pcSeries "The Hunger Games. Hot Topic" is also wrong: the page shows
      no exclusive. The stub is the corrupted row here.

  great-white-shark-bloody : KENNY WINS on pricing + isExclusive.
      Live page (great-white-shark-bloody-758) lists $15.00/$21.00/$25.00 =
      Kenny's values; the stub's marketValueComplete $24.78 is wrong. Every
      "Exclusive" mention on the page is an eBay listing for this exact figure
      described as a TARGET EXCLUSIVE, so Kenny's isExclusive=True is right and
      the stub's False is wrong.

BLANKED (DEC-025 -- blank beats wrong)
--------------------------------------
  black-star : Kenny and stub share pcId 7468817 and the same URL -- same product
      -- but disagree on price: $35.00/$63.64/$66.65 vs $66.89/$72.09/$72.09. One
      scrape is wrong or stale and there is no way to tell which without the page.
      Per Chris's ruling, the pricing is BLANKED and re-resolves on a future
      enrich or eBay pull. Everything else on the record still merges normally.

DELIBERATELY NOT IN THIS SCRIPT
-------------------------------
  hello-kitty-8-bit / pc-7531588 : NOT A DUPLICATE. pcId 7531589 is the CHASE
      variant (Sanrio 45th anniversary 8-bit); pc-7531588's isChase is already
      True. A chase shares the common's UPC and number by design -- that is why a
      title+number+UPC match cannot tell a variant from a duplicate. Both records
      stay. (The stub's _id is off-by-one from its own pcId, but _ids are never
      changed -- fix the content, keep the key.)

USAGE (Windows / PowerShell)
----------------------------
    cd C:\\Downloads\\Development\\funko_enrich
    python merge_kenny_dupes.py

Reads  : funkodex_base_catalog.json            (live original, unmodified)
Writes : funkodex_base_catalog.json.merged     (new file)
Report : merge_kenny_dupes_changelog.txt

Chain it before running anything else (PowerShell, not cmd):

    Move-Item -Force funkodex_base_catalog.json.merged funkodex_base_catalog.json

Nothing is written if any verification fails.
"""

import json
import os
import shutil
import sys
from datetime import date

IN_FILE = "funkodex_base_catalog.json"
OUT_FILE = "funkodex_base_catalog.json.merged"
LOG_FILE = "merge_kenny_dupes_changelog.txt"

# Fields the stub contributes when the Kenny row lacks them or has filler.
STUB_DESCRIPTIVE = ["series", "pcSeries", "franchiseSuggestion", "publisher", "releaseDate"]
STUB_PRICING = [
    "pricechartingId", "pricechartingUrl", "ebayEpid",
    "marketValueLoose", "marketValueComplete", "marketValueNew",
]

# Kenny `series` values that are generic filler, not real data -- always
# overwritten by the stub's real line.
FILLER_SERIES = {"", "pop! vinyl", "pop vinyl", "none"}

# (kenny_id, stub_id, override_key)
#   None          -> standard rules
#   'stub_title'  -> stub wins title/series/isExclusive (Santa Freddy)
#   'kenny_price' -> Kenny keeps pricing/pcId/pcUrl/pcSeries (Katniss, Shark)
#   'blank_price' -> pricing blanked on the survivor (Black Star)
PAIRS = [
    ("catalog::santa-freddy-funko",          "catalog::pc-7516153", "stub_title"),
    ("catalog::pixie-hanna-barbera",         "catalog::pc-7468898", None),
    ("catalog::toshi-funko",                 "catalog::pc-7470202", None),
    ("catalog::black-star",                  "catalog::pc-7468817", "blank_price"),
    ("catalog::the-dapper-dans-4-pack",      "catalog::pc-7491159", None),
    ('catalog::sam-"mayday"-malone',         "catalog::pc-7492539", None),
    ("catalog::more-cowbell!",               "catalog::pc-7531644", None),
    ('catalog::john-"soap"-mactavish',       "catalog::pc-7515532", None),
    ("catalog::eleventh-doctor/mr.-clever",  "catalog::pc-7492111", None),
    ('catalog::samuel-"screech"-powers',     "catalog::pc-7492078", None),
    ("catalog::katniss-wedding-dress",       "catalog::pc-7489644", "kenny_price"),
    ("catalog::great-white-shark-bloody",    "catalog::pc-7523956", "kenny_price"),
]

# Pure duplicate: same UPC/number/title, both have images, neither has pricing.
# Differs only by slug punctuation (deadpool-venom vs deadpool-/-venom).
# Survivor is the ENRICHED row; the Kenny row is deleted.
DELETE_IDS = ["catalog::deadpool-venom"]


def is_blank(v):
    return v is None or v == "" or v == [] or v == {}


def main():
    if not os.path.exists(IN_FILE):
        sys.exit("ERROR: %s not found. Run from the funko_enrich repo root." % IN_FILE)

    with open(IN_FILE, "r", encoding="utf-8") as fh:
        recs = json.load(fh)
    if not isinstance(recs, list):
        sys.exit("ERROR: expected a JSON list, got %s" % type(recs).__name__)

    print("Loaded %d records from %s" % (len(recs), IN_FILE))
    by_id = {r["_id"]: r for r in recs if "_id" in r}

    # ---- pre-flight ---------------------------------------------------------
    missing = []
    for kid, sid, _ in PAIRS:
        if kid not in by_id:
            missing.append(kid)
        if sid not in by_id:
            missing.append(sid)
    for d in DELETE_IDS:
        if d not in by_id:
            missing.append(d)
    if missing:
        sys.exit("ERROR: expected records not found:\n  " + "\n  ".join(missing))

    # Guard: this script must never touch the Hello Kitty chase pair.
    for guard in ("catalog::hello-kitty-8-bit", "catalog::pc-7531588"):
        if any(guard in (k, s) for k, s, _ in PAIRS) or guard in DELETE_IDS:
            sys.exit("ERROR: %s is a chase variant, not a duplicate -- refusing to merge" % guard)

    today = date.today().isoformat()
    log = ["merge_kenny_dupes.py -- %s" % today,
           "Input : %s (%d records)" % (IN_FILE, len(recs)), ""]

    stub_ids_to_drop = []

    for kid, sid, override in PAIRS:
        K = by_id[kid]
        S = by_id[sid]

        log.append("=" * 74)
        log.append("SURVIVOR  %s" % kid)
        log.append("STUB      %s        override=%s" % (sid, override or "none"))
        log.append("-" * 74)

        # sanity: the pair must actually be the same figure
        if str(K.get("funkoNumber")) != str(S.get("funkoNumber")) or \
           str(K.get("upc")) != str(S.get("upc")):
            sys.exit("ERROR: %s / %s disagree on number or UPC -- not a pair" % (kid, sid))

        # ---- title ----------------------------------------------------------
        if override == "stub_title":
            old = K.get("title")
            K["title"] = S.get("title")
            log.append("  TITLE    %r -> %r  (STUB WINS: Kenny title named the" % (old, K["title"]))
            log.append("           Funko mascot; this record's UPC/#936/PC-Games say FNAF)")
        else:
            log.append("  TITLE    kept %r  (Kenny keeps punctuation; PC slugifies)" % K.get("title"))

        # ---- descriptive fields --------------------------------------------
        for f in STUB_DESCRIPTIVE:
            if override == "kenny_price" and f == "pcSeries":
                log.append("  KEEP     pcSeries %r  (stub's is wrong per live page)" % K.get(f))
                continue
            sv = S.get(f)
            if is_blank(sv):
                continue
            kv = K.get(f)
            take = False
            if is_blank(kv):
                take = True
            elif f == "series" and str(kv).strip().lower() in FILLER_SERIES:
                take = True
            elif override == "stub_title" and f == "series":
                take = True
            if take:
                K[f] = sv
                log.append("  STUB     %-20s %r -> %r" % (f, kv, sv))

        # ---- exclusivity ----------------------------------------------------
        if override == "stub_title":
            log.append("  STUB     isExclusive %r -> False, exclusiveRetailer %r -> ''"
                       % (K.get("isExclusive"), K.get("exclusiveRetailer")))
            K["isExclusive"] = False
            K["exclusiveRetailer"] = ""
        else:
            log.append("  KEEP     isExclusive %r / exclusiveRetailer %r"
                       % (K.get("isExclusive"), K.get("exclusiveRetailer")))

        # ---- pricing --------------------------------------------------------
        if override == "blank_price":
            for f in STUB_PRICING:
                if f in ("pricechartingId", "pricechartingUrl"):
                    continue  # same pcId/URL on both -- the product link is fine
                if not is_blank(K.get(f)):
                    log.append("  BLANK    %-20s was %r (Kenny/stub disagree, unverifiable)"
                               % (f, K.get(f)))
                    K[f] = ""
        elif override == "kenny_price":
            log.append("  KEEP     pricing + pcId/pcUrl (Kenny matches the live PC page)")
        else:
            for f in STUB_PRICING:
                sv = S.get(f)
                if not is_blank(sv) and is_blank(K.get(f)):
                    K[f] = sv
                    shown = str(sv)
                    if len(shown) > 46:
                        shown = shown[:46] + "..."
                    log.append("  STUB     %-20s <- %s" % (f, shown))

        K["source"] = "MERGED"
        K["lastUpdated"] = today
        stub_ids_to_drop.append(sid)
        log.append("  SOURCE   -> MERGED")
        log.append("")

    # ---- deletes ------------------------------------------------------------
    drop = set(stub_ids_to_drop) | set(DELETE_IDS)
    before = len(recs)
    recs = [r for r in recs if r.get("_id") not in drop]

    log.append("=" * 74)
    log.append("DELETED %d stub rows (merged into their survivors above)" % len(stub_ids_to_drop))
    for d in DELETE_IDS:
        log.append("DELETED %s (pure duplicate; survivor catalog::deadpool-/-venom keeps image)" % d)
    log.append("  %d -> %d records" % (before, len(recs)))
    log.append("")

    # ---- verification: compare VALUES, not presence (DEC-025) ---------------
    print("\nVerifying...")
    errors = []
    after = {r["_id"]: r for r in recs if "_id" in r}

    for kid, sid, override in PAIRS:
        r = after.get(kid)
        if r is None:
            errors.append("survivor %s missing from output" % kid)
            continue
        if sid in after:
            errors.append("stub %s was not deleted" % sid)
        if is_blank(r.get("imageUrl")):
            errors.append("%s lost its image" % kid)
        if r.get("source") != "MERGED":
            errors.append("%s source is %r" % (kid, r.get("source")))
        sv = str(r.get("series", "")).strip().lower()
        if sv in FILLER_SERIES:
            errors.append("%s series is still filler (%r)" % (kid, r.get("series")))

    # override-specific value checks
    sf = after.get("catalog::santa-freddy-funko")
    if sf:
        if sf.get("title") != "Santa Freddy":
            errors.append("santa-freddy title is %r, expected 'Santa Freddy'" % sf.get("title"))
        if sf.get("isExclusive") is not False:
            errors.append("santa-freddy isExclusive should be False")
    kn = after.get("catalog::katniss-wedding-dress")
    if kn:
        if str(kn.get("pricechartingId")) != "7489644":
            errors.append("katniss pcId is %r, expected 7489644 (live page)" % kn.get("pricechartingId"))
        if str(kn.get("marketValueLoose")) != "19.99":
            errors.append("katniss loose is %r, expected 19.99" % kn.get("marketValueLoose"))
    gw = after.get("catalog::great-white-shark-bloody")
    if gw:
        if str(gw.get("marketValueComplete")) != "21.00":
            errors.append("shark complete is %r, expected 21.00 (live page)" % gw.get("marketValueComplete"))
        if gw.get("isExclusive") is not True:
            errors.append("shark isExclusive should stay True (Target exclusive)")
    bs = after.get("catalog::black-star")
    if bs:
        for f in ("marketValueLoose", "marketValueComplete", "marketValueNew"):
            if not is_blank(bs.get(f)):
                errors.append("black-star.%s = %r -- should be blank" % (f, bs.get(f)))

    # the chase pair must be untouched
    for guard in ("catalog::hello-kitty-8-bit", "catalog::pc-7531588"):
        if guard not in after:
            errors.append("%s was deleted -- it is a chase variant, not a dupe" % guard)
    hk = after.get("catalog::pc-7531588")
    if hk and hk.get("isChase") is not True:
        errors.append("pc-7531588 isChase changed -- it is the chase record")

    for d in DELETE_IDS:
        if d in after:
            errors.append("%s was not deleted" % d)

    expected = before - len(drop)
    if len(recs) != expected:
        errors.append("record count %d, expected %d" % (len(recs), expected))

    if errors:
        print("\nFAILED -- nothing written:")
        for e in errors:
            print("  " + e)
        sys.exit(1)

    print("  OK: %d pairs merged, survivors keep _id + image" % len(PAIRS))
    print("  OK: Santa Freddy title from stub; Katniss/Shark pricing from Kenny")
    print("  OK: Black Star pricing blanked")
    print("  OK: Hello Kitty chase pair untouched")
    print("  OK: %d records out" % len(recs))

    if os.path.exists(OUT_FILE):
        shutil.copy2(OUT_FILE, OUT_FILE + ".bak")
    with open(OUT_FILE, "w", encoding="utf-8") as fh:
        json.dump(recs, fh, ensure_ascii=False, indent=2)

    log.append("VERIFIED OK -- %d records written to %s" % (len(recs), OUT_FILE))
    with open(LOG_FILE, "w", encoding="utf-8") as fh:
        fh.write("\n".join(log) + "\n")

    print("\nWrote %s" % OUT_FILE)
    print("Wrote %s" % LOG_FILE)
    print("\nNext, to chain into the following script (PowerShell):")
    print("    Move-Item -Force %s %s" % (OUT_FILE, IN_FILE))


if __name__ == "__main__":
    main()
