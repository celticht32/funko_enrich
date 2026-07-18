#!/usr/bin/env python3
"""
fix_bash_misidentification.py  --  Session 23

Undoes an S23 error and restores the real Bash Pop. Run AFTER
fix_signed_editions.py and merge_kenny_dupes.py (catalog at 20,566).

WHAT WENT WRONG (read this before touching any of these records)
----------------------------------------------------------------
S23 treated `catalog::summer-bbq-bash` as a Toyzilla/Chuck Huber SIGNED Pop,
grouping it with the genuinely-signed Kurogiri and Android 17. It is not. It is
not a Pop at all.

hobbyDB 339696 ("Summer BBQ Bash", https://www.hobbydb.com/marketplaces/hobbydb/
catalog_items/summer-bbq-bash) files it under **Shirts and Jackets**. The page
mentions "Shirt" 35 times and Fortnite/Funko Pop zero times. It is APPAREL that
had the real Bash Pop's funkoNumber (623) and UPC (889698506939) mis-stapled onto
it -- the same mis-staple class the S22 cleanup blanked 361 of, and exactly the
kind of non-Pop S22 removed 537 of.

The error chain, so it isn't repeated:
  1. A dupe scan matched it to `catalog::bash-pop!-vinyl` on title+number+UPC.
     Those matched only BECAUSE of the mis-staple.
  2. The slug "summer-bbq-bash" was read as a Toyzilla "Summer BBQ Bash" event.
     "Bash" is the Fortnite character's name; the shirt is unrelated.
  3. Chris was asked to confirm a premise that was already wrong ("is the twin a
     dupe of the signed Pop?") and reasonably answered within it. The Chuck Huber
     sourcing only ever covered Kurogiri and Android 17 -- Huber voices Dragon
     Ball/MHA and has no Fortnite connection.
  4. fix_signed_editions.py then renamed the shirt "Bash (Toyzilla Signed
     Edition)", stamped it MANUAL_VERIFIED, added it to PC_SKIP_IDS, and deleted
     `bash-pop!-vinyl` -- a REAL Pop record -- as its duplicate.

The lesson is the one already in the handoff, from the other direction: a
title+number+UPC match cannot tell a duplicate from a variant OR from a
mis-stapled non-Pop. Identity fields are shared by design (variants) and by
defect (mis-staples). Only the product page settles it.

THE REAL BASH (verified against the live PriceCharting page)
------------------------------------------------------------
https://www.pricecharting.com/game/funko-pop-games/bash-623 -- "Bash #623 Funko
POP Games": Fortnite x44, NYCC x17, Walmart x12, UPC 889698506939 present, pcId
7516024 (x8). It is the 2020 NYCC Fall Convention exclusive, shared with Walmart.
Live prices at time of check: $7.99 / $12.00 / $14.29 (the catalog's
$11.00/$12.78/$12.78 are a stale scrape of the same product -- same pcId, same
page -- so they are kept rather than blanked; a future enrich refreshes them).

WHAT THIS SCRIPT DOES
---------------------
  1. DELETE  catalog::summer-bbq-bash          -- non-Pop apparel
  2. RESTORE catalog::bash-pop!-vinyl          -- verbatim from the pre-delete
                                                  state, then healed
  3. MERGE   catalog::pc-7516024 into it       -- series/franchise/pcId/pricing
  4. DELETE  catalog::pc-7516024               -- merged away

Survivor is `catalog::bash-pop!-vinyl`: it holds the name-slug _id (never
changed; catalogRefs may point at it) and the only image -- HobbyDB
"Bash_Vinyl_Art_Toys" 848307, a Pop photo. The stub has no image.

The restored record is byte-identical to its pre-delete state except for the
fields the PC stub fills and the title cleanup, so this is a true revert plus the
merge that should have happened.

ALSO REQUIRED (not done by this script)
---------------------------------------
enrich.js PC_SKIP_IDS must drop 'catalog::summer-bbq-bash', leaving two entries
(Kurogiri and Android 17, which ARE genuinely signed and still need the guard).
The restored Bash is a normal Pop and SHOULD be priced by enrich.

USAGE (Windows / PowerShell)
----------------------------
    cd C:\\Downloads\\Development\\funko_enrich
    python fix_bash_misidentification.py

Reads  : funkodex_base_catalog.json         (live, expects 20,566)
Writes : funkodex_base_catalog.json.bashfix
Report : fix_bash_misidentification_changelog.txt

Chain it (PowerShell, not cmd):
    Move-Item -Force funkodex_base_catalog.json.bashfix funkodex_base_catalog.json

Net: 20,566 -> 20,565 (drop shirt + stub, restore the Pop).
Nothing is written if any verification fails.
"""

import json
import os
import shutil
import sys
from datetime import date

IN_FILE = "funkodex_base_catalog.json"
OUT_FILE = "funkodex_base_catalog.json.bashfix"
LOG_FILE = "fix_bash_misidentification_changelog.txt"

SHIRT_ID = "catalog::summer-bbq-bash"      # non-Pop apparel -> delete
BASH_ID = "catalog::bash-pop!-vinyl"       # real Pop -> restore as survivor
STUB_ID = "catalog::pc-7516024"            # PC record for the same Pop -> merge + delete

# Verbatim pre-delete state of catalog::bash-pop!-vinyl, taken from the catalog
# as it stood before fix_signed_editions.py ran. Restored exactly rather than
# reconstructed from memory.
BASH_PRISTINE = {
    "_id": "catalog::bash-pop!-vinyl",
    "category": "",
    "exclusiveRetailer": "",
    "funkoNumber": "623",
    "handle": "bash-pop!-vinyl",
    "imageUrl": (
        "https://images.hobbydb.com/processed_uploads/catalog_item_photo/"
        "catalog_item_photo/image/848307/"
        "Bash_Vinyl_Art_Toys_7fdc4a96-d34f-4992-a19f-671c1bbca386.jpg"
    ),
    "isChase": False,
    "isExclusive": False,
    "isVaulted": False,
    "lastUpdated": "2026-06-29",
    "marketValueIsApproximate": False,
    "pricechartingUrl": "https://www.pricecharting.com/game/funko-pop-games/bash-623",
    "retailPrice": 0,
    "series": "",
    "seriesNumber": "",
    "source": "KENNY_CHAN",
    "title": "Bash Pop! Vinyl",
    "type": "catalog",
    "upc": "889698506939",
}

# Fields the PC stub contributes. Fill-only, except `title`/`series`, handled
# explicitly below.
STUB_FIELDS = [
    "category", "ebayEpid", "franchiseSuggestion", "pcSeries",
    "pricechartingId", "pricechartingUrl", "publisher", "releaseDate",
    "seriesNumber", "marketValueLoose", "marketValueComplete", "marketValueNew",
]


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
    if SHIRT_ID not in by_id:
        sys.exit("ERROR: %s not found -- has this script already run?" % SHIRT_ID)
    if STUB_ID not in by_id:
        sys.exit("ERROR: %s not found -- expected the PriceCharting Bash record" % STUB_ID)
    if BASH_ID in by_id:
        sys.exit("ERROR: %s already exists -- refusing to overwrite it" % BASH_ID)

    shirt = by_id[SHIRT_ID]
    stub = by_id[STUB_ID]

    # Confirm the shirt is the record S23 renamed, not something else.
    if "Toyzilla" not in str(shirt.get("title", "")):
        sys.exit("ERROR: %s title is %r -- expected the S23 'Toyzilla Signed Edition' "
                 "rename. Catalog is not in the state this script expects."
                 % (SHIRT_ID, shirt.get("title")))

    today = date.today().isoformat()
    log = ["fix_bash_misidentification.py -- %s" % today,
           "Input : %s (%d records)" % (IN_FILE, len(recs)), ""]

    # ---- 1. delete the shirt ------------------------------------------------
    log.append("=" * 74)
    log.append("DELETE  %s" % SHIRT_ID)
    log.append("  title was : %r" % shirt.get("title"))
    log.append("  reason    : NON-POP. hobbyDB 339696 files it under Shirts and")
    log.append("              Jackets. #623 and UPC 889698506939 were mis-stapled")
    log.append("              from the real Bash Pop. The S23 'Toyzilla Signed")
    log.append("              Edition' rename and MANUAL_VERIFIED stamp were wrong.")
    log.append("")

    # ---- 2. restore the real Pop --------------------------------------------
    bash = dict(BASH_PRISTINE)
    log.append("=" * 74)
    log.append("RESTORE %s (verbatim pre-delete state)" % BASH_ID)
    log.append("  reason  : real Pop, deleted by fix_signed_editions.py on the")
    log.append("            false premise that it duplicated a signed edition")
    log.append("  image   : recovered (HobbyDB 848307, Bash_Vinyl_Art_Toys)")

    # Title: drop the "Pop! Vinyl" suffix Kenny appends; PC's plain "Bash" is the
    # product name and matches the live page's H1 ("Bash #623 Funko POP Games").
    old_title = bash["title"]
    bash["title"] = stub.get("title") or "Bash"
    log.append("  TITLE   %r -> %r (Kenny suffix dropped; matches PC page)"
               % (old_title, bash["title"]))

    # ---- 3. merge the stub in -----------------------------------------------
    log.append("-" * 74)
    log.append("MERGE   %s -> %s" % (STUB_ID, BASH_ID))
    if str(stub.get("upc")) != str(bash.get("upc")) or \
       str(stub.get("funkoNumber")) != str(bash.get("funkoNumber")):
        sys.exit("ERROR: %s and the restored Bash disagree on UPC/number -- not a pair" % STUB_ID)

    # series: Kenny left it blank; the stub has the real line.
    if is_blank(bash.get("series")) and not is_blank(stub.get("series")):
        bash["series"] = stub["series"]
        log.append("  STUB    %-22s <- %r" % ("series", stub["series"]))

    for f in STUB_FIELDS:
        sv = stub.get(f)
        if is_blank(sv):
            continue
        if is_blank(bash.get(f)):
            bash[f] = sv
            shown = str(sv)
            if len(shown) > 44:
                shown = shown[:44] + "..."
            log.append("  STUB    %-22s <- %s" % (f, shown))

    bash["source"] = "MERGED"
    bash["lastUpdated"] = today
    log.append("  SOURCE  -> MERGED")
    log.append("  NOTE    pricing kept as-is ($11.00/$12.78/$12.78). Stale vs the")
    log.append("          live page ($7.99/$12.00/$14.29) but the SAME product and")
    log.append("          pcId, so it re-resolves on the next enrich. Not blanked:")
    log.append("          there is no conflict here, just an older scrape.")
    log.append("")

    # ---- rebuild ------------------------------------------------------------
    before = len(recs)
    drop = {SHIRT_ID, STUB_ID}
    out = [r for r in recs if r.get("_id") not in drop]
    out.append(bash)

    log.append("=" * 74)
    log.append("DELETE  %s (merged into %s)" % (STUB_ID, BASH_ID))
    log.append("  %d -> %d records" % (before, len(out)))
    log.append("")

    # ---- verification: compare VALUES, not presence -------------------------
    print("\nVerifying...")
    errors = []
    after = {r["_id"]: r for r in out if "_id" in r}

    if SHIRT_ID in after:
        errors.append("%s was not deleted" % SHIRT_ID)
    if STUB_ID in after:
        errors.append("%s was not deleted" % STUB_ID)

    b = after.get(BASH_ID)
    if b is None:
        errors.append("%s was not restored" % BASH_ID)
    else:
        if b.get("title") != "Bash":
            errors.append("bash title is %r, expected 'Bash'" % b.get("title"))
        if b.get("series") != "Pop! Games":
            errors.append("bash series is %r, expected 'Pop! Games' (live page)" % b.get("series"))
        if b.get("franchiseSuggestion") != "Fortnite":
            errors.append("bash franchise is %r, expected 'Fortnite'" % b.get("franchiseSuggestion"))
        if str(b.get("pricechartingId")) != "7516024":
            errors.append("bash pcId is %r, expected 7516024 (live page)" % b.get("pricechartingId"))
        if str(b.get("upc")) != "889698506939":
            errors.append("bash upc is %r" % b.get("upc"))
        if str(b.get("funkoNumber")) != "623":
            errors.append("bash number is %r" % b.get("funkoNumber"))
        if is_blank(b.get("imageUrl")):
            errors.append("bash has no image -- the restore lost it")
        if "848307" not in str(b.get("imageUrl")):
            errors.append("bash image is not the recovered HobbyDB 848307 photo")
        if is_blank(b.get("marketValueLoose")):
            errors.append("bash lost its pricing in the merge")

    # the genuinely-signed records must be untouched by this script
    for sid in ("catalog::kurogiri-toyzilla-signed-edition",
                "catalog::android-17-toyzilla-signed-edition"):
        r = after.get(sid)
        if r is None:
            errors.append("%s vanished -- it is genuinely signed and must remain" % sid)
        elif not is_blank(r.get("marketValueLoose")):
            errors.append("%s gained pricing -- must stay blank" % sid)

    expected = before - 2 + 1
    if len(out) != expected:
        errors.append("record count %d, expected %d" % (len(out), expected))

    ids = [r.get("_id") for r in out]
    if len(ids) != len(set(ids)):
        errors.append("duplicate _ids in output")

    if errors:
        print("\nFAILED -- nothing written:")
        for e in errors:
            print("  " + e)
        sys.exit(1)

    print("  OK: shirt deleted (non-Pop, mis-stapled identity)")
    print("  OK: catalog::bash-pop!-vinyl restored with its image")
    print("  OK: merged Pop! Games / Fortnite / pcId 7516024 / pricing")
    print("  OK: signed Kurogiri + Android 17 untouched, still unpriced")
    print("  OK: %d records out" % len(out))

    if os.path.exists(OUT_FILE):
        shutil.copy2(OUT_FILE, OUT_FILE + ".bak")
    with open(OUT_FILE, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)

    log.append("VERIFIED OK -- %d records written to %s" % (len(out), OUT_FILE))
    log.append("")
    log.append("REMINDER: remove 'catalog::summer-bbq-bash' from PC_SKIP_IDS in")
    log.append("enrich.js. The restored Bash is a normal Pop and should be priced.")
    with open(LOG_FILE, "w", encoding="utf-8") as fh:
        fh.write("\n".join(log) + "\n")

    print("\nWrote %s" % OUT_FILE)
    print("Wrote %s" % LOG_FILE)
    print("\nNext (PowerShell):")
    print("    Move-Item -Force %s %s" % (OUT_FILE, IN_FILE))
    print("\nAlso: drop 'catalog::summer-bbq-bash' from PC_SKIP_IDS in enrich.js.")


if __name__ == "__main__":
    main()
