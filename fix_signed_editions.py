#!/usr/bin/env python3
"""
fix_signed_editions.py  --  Session 23

Repairs the three Toyzilla / Chuck Huber signed-edition catalog records, which
S22's handoff mis-filed as "image-blanked, awaiting one enrich run".

WHY THIS SCRIPT EXISTS (read before changing it)
------------------------------------------------
The handoff said Bash #623, Kurogiri #789 and Android 17 #529 were three records
whose images an earlier re-resolve pass had blanked, and that one enrich run
would repopulate them. That is wrong on both counts:

  1. enrich.js NEVER refetches images (S22 data-safety rule). The enrich run
     would have reported success and left all three blank forever.
  2. They are not damaged base records at all. They are REAL, distinct products:
     certified Pops signed by voice actor Chuck Huber, sold by Toyzilla. Each one
     has a fully-populated "twin" in the catalog -- the unsigned base figure --
     which is where the image actually lives.

A signed Pop is the base figure in its original box: Toyzilla adds a signature
and a COA, not a new barcode. So sharing the base figure's UPC is CORRECT, not a
mis-staple (cf. the S22 tiered UPC rule that spared ~258 legitimate shared UPCs).
Do not let a future UPC pass blank these.

WHAT IT DOES
------------
  1. Harvests ONLY identity-neutral fields from each base twin (see HARVEST_FIELDS).
  2. Renames titles to carry the variant, e.g. "Kurogiri (Toyzilla Signed Edition)".
  3. Blanks inherited BASE-FIGURE valuation fields (see BLANK_FIELDS).
  4. Deletes catalog::bash-pop!-vinyl, a true Kenny duplicate of the signed Bash.
  5. Marks the three records source=MANUAL_VERIFIED (identity confirmed by Chris
     against Toyzilla listings, not inferred by a matcher).

THE HARVEST IS FIELD-CLASSED, NOT GAP-DRIVEN -- THIS IS THE WHOLE POINT
-----------------------------------------------------------------------
"Fill anything that's blank from the twin" is the obvious implementation and it
is WRONG. Android 17's base twin carries marketValueLoose 6.33 / Complete 9.00 /
New 10.55 and pcId 7468564. Those fields are blank on the signed record, so a
gap-driven fill would helpfully stamp $6.33 onto a piece that sells for $70-100.
That is DEC-025's exact failure mode: populated, plausible, silently wrong, and
it passes every "is the field filled in?" check.

So fields are split by whether they describe THE FIGURE (safe -- a signed
Kurogiri is still My Hero Academia, still looks like Kurogiri) or THE PRODUCT'S
IDENTITY AND WORTH (never -- a signed LE is not the base figure's market).

pricechartingUrl/pricechartingId are on the NEVER side: they point at the base
figure's PriceCharting page, which is a $4.99 valuation for a different product.

CONSEQUENCE, STATED PLAINLY: after this runs, the three records have NO pricing,
and enrich is skip-listed against them (enrich_skiplist patch), so nothing will
re-resolve it. They stay blank until a real signed-market value is sourced from a
listing or packaging. That is intended. Blank beats wrong (DEC-025).

WHY THE TITLE RENAME IS COSMETIC (verified, do not rely on it)
--------------------------------------------------------------
It is tempting to think renaming to "Kurogiri (Toyzilla Signed Edition)" protects
the record from enrich. IT DOES NOT. enrich's coreNameTokens() strips
parentheticals (enrich.js ~line 850), so the title tokenises to exactly
["kurogiri"] -- identical to the bare title -- and coreNameCovered() still
returns True against the base row "kurogiri". Verified in S23.

The rename is for HUMANS reading the catalog. The ONLY thing preventing enrich
from re-stamping base identity onto these records is the skip-list. Do not remove
it on the grounds that "the title says signed".

USAGE (Windows / PowerShell)
----------------------------
    cd C:\\Downloads\\Development\\funko_enrich
    python fix_signed_editions.py

Reads  : funkodex_base_catalog.json          (live original, unmodified)
Writes : funkodex_base_catalog.json.signed   (new file)
Report : fix_signed_editions_changelog.txt

Per the S22 chaining rule, scripts read the LIVE original and write a new file.
Rename the output over the original BEFORE running the next script, or the next
one reads the same unmodified input and nothing chains:

    move /Y funkodex_base_catalog.json.signed funkodex_base_catalog.json

Nothing is written if any verification fails.
"""

import json
import os
import shutil
import sys
from datetime import date

IN_FILE = "funkodex_base_catalog.json"
OUT_FILE = "funkodex_base_catalog.json.signed"
LOG_FILE = "fix_signed_editions_changelog.txt"

# (signed_record_id, base_twin_id, new_title)
PAIRS = [
    ("catalog::summer-bbq-bash",
     "catalog::bash-pop!-vinyl",
     "Bash (Toyzilla Signed Edition)"),
    ("catalog::kurogiri-toyzilla-signed-edition",
     "catalog::kurogiri",
     "Kurogiri (Toyzilla Signed Edition)"),
    ("catalog::android-17-toyzilla-signed-edition",
     "catalog::android-17",
     "Android 17 (Toyzilla Signed Edition)"),
]

# Kenny duplicate of the signed Bash. Its ONLY unique asset is the image, which
# is harvested above before this delete. Deleting it before harvesting would lose
# the picture permanently -- enrich never refetches images.
DELETE_IDS = ["catalog::bash-pop!-vinyl"]

# Safe: describes the FIGURE, true of signed and unsigned alike.
HARVEST_FIELDS = ["imageUrl", "franchiseSuggestion", "pcSeries", "publisher", "series"]

# Never harvest, and blank if already inherited: describes the BASE PRODUCT's
# identity and market value. A signed LE is a different product with a different
# price. See DEC-025.
BLANK_FIELDS = [
    "marketValueLoose",
    "marketValueComplete",
    "marketValueNew",
    "pricechartingId",
    "pricechartingUrl",
    "ebayEpid",
]

# Deliberately NOT touched: retailPrice (0) and marketValueIsApproximate (False)
# are schema defaults present catalog-wide, not inherited base values.
# build_catalog_asset.py validates that booleans are real booleans -- nulling
# marketValueIsApproximate would risk failing that check for no benefit.


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

    # ---- pre-flight: every id must exist before anything is changed ----------
    missing = []
    for signed_id, base_id, _ in PAIRS:
        if signed_id not in by_id:
            missing.append(signed_id)
        if base_id not in by_id:
            missing.append(base_id)
    for d in DELETE_IDS:
        if d not in by_id:
            missing.append(d)
    if missing:
        sys.exit("ERROR: expected records not found:\n  " + "\n  ".join(missing))

    log = []
    log.append("fix_signed_editions.py -- %s" % date.today().isoformat())
    log.append("Input : %s (%d records)" % (IN_FILE, len(recs)))
    log.append("")

    today = date.today().isoformat()

    # ---- 1..3: harvest, rename, blank ---------------------------------------
    for signed_id, base_id, new_title in PAIRS:
        signed = by_id[signed_id]
        base = by_id[base_id]

        log.append("=" * 72)
        log.append("SIGNED  %s" % signed_id)
        log.append("BASE    %s" % base_id)
        log.append("-" * 72)

        old_title = signed.get("title")
        signed["title"] = new_title
        log.append("  TITLE   %r -> %r" % (old_title, new_title))
        log.append("          (cosmetic only -- coreNameTokens strips parentheticals;")
        log.append("           the skip-list is what actually protects this record)")

        for f in HARVEST_FIELDS:
            if is_blank(signed.get(f)) and not is_blank(base.get(f)):
                val = base[f]
                signed[f] = val
                shown = str(val)
                if len(shown) > 58:
                    shown = shown[:58] + "..."
                log.append("  HARVEST %-20s <- %s" % (f, shown))

        for f in BLANK_FIELDS:
            if not is_blank(signed.get(f)):
                log.append("  BLANK   %-20s was %r (base-figure value)" % (f, signed[f]))
                signed[f] = ""

        signed["source"] = "MANUAL_VERIFIED"
        signed["lastUpdated"] = today
        log.append("  SOURCE  -> MANUAL_VERIFIED")
        log.append("")

    # ---- 4: delete the Kenny duplicate (AFTER its image was harvested) -------
    before = len(recs)
    recs = [r for r in recs if r.get("_id") not in DELETE_IDS]
    log.append("=" * 72)
    for d in DELETE_IDS:
        log.append("DELETE  %s (Kenny duplicate; image harvested above first)" % d)
    log.append("        %d -> %d records" % (before, len(recs)))
    log.append("")

    # ---- verification: compare VALUES, not presence (DEC-025) ---------------
    # A "field is populated" check is exactly what let the Evil Queen record
    # report funkoNumber present: YES while holding a different Pop's number.
    print("\nVerifying...")
    errors = []
    by_id_after = {r["_id"]: r for r in recs if "_id" in r}

    for signed_id, base_id, new_title in PAIRS:
        s = by_id_after.get(signed_id)
        if s is None:
            errors.append("%s vanished from output" % signed_id)
            continue
        if s.get("title") != new_title:
            errors.append("%s title is %r, expected %r" % (signed_id, s.get("title"), new_title))
        if is_blank(s.get("imageUrl")):
            errors.append("%s still has no imageUrl (harvest failed)" % signed_id)
        if s.get("source") != "MANUAL_VERIFIED":
            errors.append("%s source is %r" % (signed_id, s.get("source")))
        for f in BLANK_FIELDS:
            if not is_blank(s.get(f)):
                errors.append("%s.%s = %r -- should be blank" % (signed_id, f, s.get(f)))
        # the image must be the twin's actual URL, not merely "something"
        base = by_id.get(base_id)
        if base and not is_blank(base.get("imageUrl")):
            if s.get("imageUrl") != base.get("imageUrl"):
                errors.append("%s.imageUrl does not match its twin's value" % signed_id)

    for d in DELETE_IDS:
        if d in by_id_after:
            errors.append("%s was not deleted" % d)

    if len(recs) != before - len(DELETE_IDS):
        errors.append("record count %d, expected %d" % (len(recs), before - len(DELETE_IDS)))

    if errors:
        print("\nFAILED -- nothing written:")
        for e in errors:
            print("  " + e)
        sys.exit(1)

    print("  OK: 3 records renamed, images harvested, base pricing blanked")
    print("  OK: 1 Kenny duplicate deleted")
    print("  OK: %d records out" % len(recs))

    # ---- write --------------------------------------------------------------
    if os.path.exists(OUT_FILE):
        shutil.copy2(OUT_FILE, OUT_FILE + ".bak")
    with open(OUT_FILE, "w", encoding="utf-8") as fh:
        json.dump(recs, fh, ensure_ascii=False, indent=2)

    log.append("VERIFIED OK -- %d records written to %s" % (len(recs), OUT_FILE))
    with open(LOG_FILE, "w", encoding="utf-8") as fh:
        fh.write("\n".join(log) + "\n")

    print("\nWrote %s" % OUT_FILE)
    print("Wrote %s" % LOG_FILE)
    print("\nNext, to chain into the following script:")
    print("    move /Y %s %s" % (OUT_FILE, IN_FILE))


if __name__ == "__main__":
    main()
