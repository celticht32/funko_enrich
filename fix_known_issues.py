r"""
fix_known_issues.py — four targeted corrections found during review.

MIT License, Copyright (c) 2026 Chris Ahrendt

1. EVIL QUEEN (Stained Glass Deluxe)
   Two records describe the same Pop, each holding half the data:
     catalog::81681.html   "Evil Queen (Snow White Stained Glass)" — title + image
     catalog::pc-10118182  "Evil Queen" #1609 — funkoNumber + PriceCharting id
   Merge into 81681.html (better title, has image), fill number/pcId/pricing from
   the stub, remove the stub, and set the verified UPC 889698816816.

2. CASTIEL FunkO's
   Deleted by the non-Pop "FunkO's" title rule, but its HobbyDB image category is
   Vinyl_Art_Toys (a real figure) — unlike the true cereal records, which are
   Whatever_Else. Confirmed a real Funko by inspection. This script only reports
   it: removing it from nonpop_delete_ids.json is the actual fix (see --report).

3. BELLE (collection re-link)
   Owned item funko::889698575836 ("Belle" #1132) has catalogRef -> catalog::belle,
   which does not exist. Its UPC and number both match catalog::the-beast-and-belle
   ("The Beast and Belle" #1132). Re-point the catalogRef.

4. EVIL QUEEN (collection re-link)
   Owned item funko::889698502702 ("Evil Queen on Throne") has catalogRef ->
   catalog::evil-queen-funko's — the CEREAL, correctly deleted. The owner has the
   Pop, not the cereal; the scan hit the cereal's barcode. Re-point to the merged
   Evil Queen record (catalog::81681.html).

NOT fixed: Mr. Toad (funko::889698511728, #814) — no catalog record exists for it
anywhere in the base, so there is nothing to re-link to. Left as-is.

INPUT (defaults):
  funkodex_base_catalog.json     (the ENRICHED base — must contain 81681.html)
  funkodex_backup.json           (optional; collection re-links applied here)

OUTPUT:
  funkodex_base_catalog.kfix.json
  funkodex_backup.kfix.json      (if backup supplied)
  fix_known_issues_changelog.txt

Originals untouched.

USAGE (Windows):
    py fix_known_issues.py
    py fix_known_issues.py --base C:\path\funkodex_base_catalog.json ^
                           --backup C:\path\funkodex_backup.json
"""

from __future__ import annotations
import argparse, json, os, sys

DEF_BASE   = "funkodex_base_catalog.json"
DEF_BACKUP = "funkodex_backup.json"

EQ_SURVIVOR = "catalog::81681.html"        # funko.com: title + image
EQ_STUB     = "catalog::pc-10118182"       # PriceCharting: #1609 + pcId
EQ_UPC      = "889698816816"               # verified from retail listings

BELLE_ITEM  = "funko::889698575836"
BELLE_TARGET = "catalog::the-beast-and-belle"

EQ_ITEM     = "funko::889698502702"
CASTIEL_ID  = "catalog::castiel-funko's"

# Records to (re-)add, with their data verified:
#  - Castiel: recovered verbatim from a pre-deletion copy. A real Pop! Television
#    Supernatural #95 (Hot Topic, 2014) that enrich.js's FunkO's title rule wrongly
#    dropped. UPC intentionally blank — no barcode was ever resolved for it, and a
#    guessed UPC is worse than none.
#  - Mr. Toad (65th Anniversary): built from the owner's physical box — title,
#    funkoNumber 814 and UPC 889698511728 all read off the packaging; series and
#    franchise inherited from its sibling in the same Disneyland 65th Anniversary
#    attraction line. Market values / image left blank for enrich to fill.
#    Its _id matches the catalogRef the owned item already points at, so adding it
#    resolves that orphan with no re-link needed.
ADD_RECORDS = json.loads(r"""
{
    "castiel": {
        "_id": "catalog::castiel-funko's",
        "marketValueNew": "34.81",
        "marketValueLoose": "19.99",
        "funkoNumber": "95",
        "source": "",
        "type": "catalog",
        "title": "Castiel FunkO's",
        "isExclusive": true,
        "lastUpdated": "2026-06-29",
        "imageUrl": "https://images.hobbydb.com/processed_uploads/catalog_item_photo/catalog_item_photo/image/812835/Castiel_FunkO%2527s_Vinyl_Art_Toys_7f377533-d9bc-4d8c-b805-95c1a7b9c182.png",
        "pricechartingUrl": "",
        "releaseDate": "2014-01-01",
        "isChase": false,
        "upc": "",
        "handle": "castiel-funko's",
        "seriesNumber": "",
        "pricechartingId": "",
        "ebayEpid": "2133542086",
        "series": "Pop! Television",
        "publisher": "Funko",
        "pcSeries": "Supernatural",
        "category": "Pop! Television",
        "retailPrice": 0,
        "isVaulted": false,
        "exclusiveRetailer": "Hot Topic",
        "franchiseSuggestion": "Supernatural",
        "marketValueComplete": "29.97",
        "marketValueIsApproximate": false,
        "upcRecoveryStatus": "no_barcode_found",
        "upcRecoveryDate": "2026-07-08"
    },
    "mrtoad": {
        "_id": "catalog::mr.-toad-65th-anniversary",
        "type": "catalog",
        "handle": "mr.-toad-65th-anniversary",
        "title": "Mr. Toad (65th Anniversary)",
        "funkoNumber": "814",
        "upc": "889698511728",
        "series": "Pop! Disney",
        "category": "Pop! Disney",
        "pcSeries": "Disneyland: 65th Anniversary",
        "franchiseSuggestion": "Disneyland: 65th Anniversary",
        "publisher": "Funko",
        "releaseDate": "2020-01-01",
        "isExclusive": false,
        "isChase": false,
        "isVaulted": false,
        "retailPrice": 0,
        "imageUrl": "",
        "source": "MANUAL_VERIFIED",
        "lastUpdated": "2026-07-15"
    }
}
""")

# Identity fields where the STUB is authoritative and overwrites whatever the
# enrich run put there. enrich mis-matched 81681.html to "Snow White & Evil Queen"
# #6 (a Pop! Minis 2-pack) and wrote that Pop's number/pcId/url/series AND its
# pricing onto it; the stub pc-10118182 carries the correct identity and the real
# #1609 pricing (16.31/23.00/27.19 vs the mis-matched 10.00).
AUTHORITATIVE = ["funkoNumber", "seriesNumber", "pricechartingId", "pricechartingUrl",
                 "series", "pcSeries", "category", "franchiseSuggestion",
                 "marketValueLoose", "marketValueComplete", "marketValueNew",
                 "marketValueIsApproximate"]

# fields the survivor should inherit from the stub ONLY when it lacks them
INHERIT = ["ebayEpid", "releaseDate", "publisher"]


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def dump(o, p):
    with open(p, "w", encoding="utf-8") as f:
        json.dump(o, f, indent=2, ensure_ascii=False)


def blank(v):
    return not v or str(v).strip() in ("", "__unresolved__", "None")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base",   default=DEF_BASE)
    ap.add_argument("--backup", default=DEF_BACKUP)
    args = ap.parse_args()

    if not os.path.exists(args.base):
        sys.exit(f"not found: {args.base}")

    log = []
    print("fix_known_issues")

    # ── 1 + 2: base changes ─────────────────────────────────────────────────
    base = load(args.base)
    byid = {r.get("_id"): r for r in base}

    surv = byid.get(EQ_SURVIVOR)
    stub = byid.get(EQ_STUB)

    if surv is None:
        print(f"  !! {EQ_SURVIVOR} not found — is this the ENRICHED base?")
        print(f"     (the funko.com records only exist after an enrich run)")
    else:
        if stub is not None:
            # The enrich run mis-matched 81681.html to a DIFFERENT Pop ("Snow White
            # & Evil Queen" #6, a Pop! Minis 2-pack) and stamped that identity onto
            # it. So these fields are not merely blank — they are WRONG, and a
            # fill-if-blank merge would silently keep the bad values. The stub
            # (pc-10118182) holds the correct identity for this figure (#1609,
            # pcId 10118182, Pop! Disney), so for identity fields the stub WINS.
            overwritten, filled = [], []
            for f in AUTHORITATIVE:      # stub is authoritative — overwrite
                if not blank(stub.get(f)):
                    if not blank(surv.get(f)) and surv.get(f) != stub.get(f):
                        overwritten.append(f"{f}: {surv.get(f)!r} -> {stub.get(f)!r}")
                    surv[f] = stub[f]
            for f in INHERIT:            # only fill if the survivor lacks it
                if blank(surv.get(f)) and not blank(stub.get(f)):
                    surv[f] = stub[f]
                    filled.append(f)
            log.append(f"EVIL QUEEN merge: {EQ_STUB} -> {EQ_SURVIVOR}")
            for o in overwritten:
                log.append(f"  overwrote bad enrich value {o}")
            print(f"  [1] Evil Queen: merged {EQ_STUB} into {EQ_SURVIVOR}")
            if overwritten:
                print(f"      corrected mis-matched fields:")
                for o in overwritten:
                    print(f"        {o}")
            if filled:
                print(f"      filled blanks from stub: {filled}")
        else:
            print(f"  [1] Evil Queen: stub {EQ_STUB} not present (already merged?)")
        if blank(surv.get("upc")):
            surv["upc"] = EQ_UPC
            log.append(f"EVIL QUEEN upc set to {EQ_UPC} on {EQ_SURVIVOR}")
            print(f"      set upc = {EQ_UPC}")
        else:
            print(f"      upc already set ({surv.get('upc')}) — left alone")

    before = len(base)
    base = [r for r in base if r.get("_id") != EQ_STUB]
    if len(base) != before:
        print(f"      removed stub {EQ_STUB}")

    # ── 2: re-add records that should exist ─────────────────────────────────
    present = {r.get("_id") for r in base}
    for key, rec in ADD_RECORDS.items():
        rid = rec["_id"]
        if rid in present:
            print(f"  [{key}] already present ({rid}) — nothing to do")
            continue
        base.append(dict(rec))
        present.add(rid)
        log.append(f"ADDED {rid}: {rec.get('title')!r} #{rec.get('funkoNumber')} "
                   f"upc={rec.get('upc')!r}")
        print(f"  [{key}] added {rid}")
        print(f"      {rec.get('title')!r}  #{rec.get('funkoNumber')}  upc={rec.get('upc') or '(blank)'}")

    dump(base, args.base.replace(".json", ".kfix.json"))

    # ── 3 + 4: backup collection re-links ───────────────────────────────────
    if os.path.exists(args.backup):
        bk = load(args.backup)
        bkid = {r.get("_id"): r for r in bk}
        base_ids = {r.get("_id") for r in base}

        for item_id, target, label in (
            (BELLE_ITEM, BELLE_TARGET, "BELLE"),
            (EQ_ITEM, EQ_SURVIVOR, "EVIL QUEEN"),
        ):
            r = bkid.get(item_id)
            if r is None:
                print(f"  [{label}] owned item {item_id} not in backup — skipped")
                continue
            old = r.get("catalogRef")
            if target not in base_ids:
                print(f"  [{label}] target {target} not in base — NOT re-linked (unsafe)")
                log.append(f"{label}: target {target} missing; left catalogRef={old!r}")
                continue
            r["catalogRef"] = target
            log.append(f"{label} re-link: {item_id} catalogRef {old!r} -> {target!r}")
            print(f"  [{label}] re-linked {item_id}: {old} -> {target}")

        dump(bk, args.backup.replace(".json", ".kfix.json"))
        print(f"\n  backup written: {args.backup.replace('.json', '.kfix.json')}")

    print(f"  base written  : {args.base.replace('.json', '.kfix.json')}")

    clog = os.path.join(os.path.dirname(args.base) or ".", "fix_known_issues_changelog.txt")
    with open(clog, "w", encoding="utf-8") as f:
        f.write("\n".join(log) + "\n")
    print(f"  changelog     : {clog}")
    print("\nOriginals untouched. Verify, then rename the .kfix.json files over them.")


if __name__ == "__main__":
    main()
