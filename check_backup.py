r"""
check_backup.py — inspect backup vs base before merging.

MIT License, Copyright (c) 2026 Chris Ahrendt

Read-only. Writes nothing. Reports how the backup and the enriched base have
diverged, and — most importantly — whether any owned collection record points at
a catalog record that no longer exists.

Run this BEFORE merging the enriched base into the backup.

USAGE (Windows):
    py check_backup.py
    py check_backup.py --base C:\Downloads\funkodex_base_catalog.json ^
                       --backup C:\Downloads\funkodex_backup.json
"""

from __future__ import annotations
import argparse, json, os, sys
from collections import Counter

DEF_BASE   = r"funkodex_base_catalog.json"
DEF_BACKUP = r"funkodex_backup.json"


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base",   default=DEF_BASE)
    ap.add_argument("--backup", default=DEF_BACKUP)
    args = ap.parse_args()

    for p in (args.base, args.backup):
        if not os.path.exists(p):
            sys.exit(f"not found: {p}  (run this from the folder holding both files)")

    base = load(args.base)
    bk = load(args.backup)

    base_ids = {r.get("_id") for r in base}
    cat = [r for r in bk if r.get("type") == "catalog"]
    coll = [r for r in bk if r.get("type") == "funko"]
    other = [r for r in bk if r.get("type") not in ("catalog", "funko")]

    print("=" * 60)
    print("RECORD COUNTS")
    print("=" * 60)
    print(f"  enriched base            : {len(base)}")
    print(f"  backup catalog records   : {len(cat)}")
    print(f"  backup collection (owned): {len(coll)}")
    if other:
        print(f"  backup other types       : {len(other)} -> {dict(Counter(r.get('type') for r in other))}")

    print()
    print("=" * 60)
    print("DIVERGENCE (base vs backup catalog)")
    print("=" * 60)
    cat_ids = {r.get("_id") for r in cat}
    only_base = base_ids - cat_ids
    only_bk = cat_ids - base_ids
    print(f"  in base but NOT in backup catalog : {len(only_base)}  (new/enriched records)")
    print(f"  in backup catalog but NOT in base : {len(only_bk)}  (removed by cleanup/enrich)")

    print()
    print("=" * 60)
    print("COLLECTION LINKAGE  (the important part)")
    print("=" * 60)
    if not coll:
        print("  no collection records found.")
        return

    sample = coll[0]
    print(f"  collection record fields: {list(sample.keys())}")
    print()

    # Find which field (if any) links a collection item to a catalog record.
    link_fields = [f for f in ("catalogId", "catalog_id", "catalogRef", "baseId", "handle", "_id")
                   if f in sample]
    print(f"  candidate link fields present: {link_fields}")

    # Check each candidate: do its values resolve to base _ids?
    for f in link_fields:
        vals = [str(r.get(f) or "") for r in coll if r.get(f)]
        if not vals:
            continue
        hits = sum(1 for v in vals if v in base_ids)
        # also try catalog:: prefixed form
        hits_pref = sum(1 for v in vals if f"catalog::{v}" in base_ids)
        print(f"    {f}: {len(vals)} values | direct match in base: {hits} | 'catalog::'+value match: {hits_pref}")

    # UPC-based linkage is common too
    base_upcs = {str(r.get("upc") or "").strip() for r in base if str(r.get("upc") or "").strip()}
    coll_upcs = [str(r.get("upc") or "").strip() for r in coll if str(r.get("upc") or "").strip()]
    if coll_upcs:
        matched = sum(1 for u in coll_upcs if u in base_upcs)
        print(f"    upc: {len(coll_upcs)} collection items have a UPC | {matched} match a base UPC")

    print()
    print("=" * 60)
    print("ORPHAN CHECK")
    print("=" * 60)
    # An owned item is 'orphaned' if its _id looks like a catalog ref that's gone
    orphans = []
    for r in coll:
        rid = str(r.get("_id") or "")
        # collection ids are usually funko::<something>; check any explicit catalog link
        for f in ("catalogId", "catalog_id", "catalogRef", "baseId"):
            v = r.get(f)
            if v and str(v) not in base_ids and f"catalog::{v}" not in base_ids:
                orphans.append((rid, f, v))
                break
    if orphans:
        print(f"  !! {len(orphans)} owned items reference a MISSING catalog record:")
        for rid, f, v in orphans[:15]:
            print(f"     {rid}  ({f} -> {v})")
        if len(orphans) > 15:
            print(f"     ... and {len(orphans)-15} more")
    else:
        print("  No owned item references a missing catalog record via an explicit link field.")
        print("  (If the app matches by UPC/title instead, see the upc line above.)")

    print()
    print("Read-only — nothing was modified.")


if __name__ == "__main__":
    main()
