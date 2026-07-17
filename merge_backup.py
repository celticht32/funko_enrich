r"""
merge_backup.py — sync the backup's catalog section to the enriched base.

MIT License, Copyright (c) 2026 Chris Ahrendt

WHAT IT DOES
The backup holds several record types:

    catalog     — the Pop catalog (stale; the enrich run never touched it)
    funko       — YOUR OWNED ITEMS (pricePaid, condition, photos, catalogRef)
    system / cat_pref / price / contrib / group_pref — app state

Only the `catalog` records are replaced, wholesale, with the enriched base. Every
other record type is carried across byte-for-byte. Your collection is never
rewritten by this script.

THE RISK, AND THE GATE
Owned items point at catalog records via `catalogRef`. The enriched base has had
records removed (non-Pops), merged (duplicates) and re-keyed, so an owned item
could end up pointing at a record that no longer exists — an orphan.

This script therefore checks EVERY owned item against the incoming catalog BEFORE
writing anything. If swapping the catalog would orphan an item that is currently
fine, it reports and (unless --force) refuses to write. Losing the link between
you and something you own is the one outcome worth blocking on.

Pre-existing orphans (broken before this merge) are reported but don't block —
the merge didn't cause them and fixing them is a separate job.

USAGE (Windows):
    py merge_backup.py --dry-run
    py merge_backup.py
    py merge_backup.py --base   C:\Downloads\development\funko_enrich\funkodex_base_catalog.json ^
                       --backup C:\Downloads\funkodex_upc_verify\funkodex_backup.json

OUTPUT:
    <backup>.merged.json      (original untouched)
    merge_backup_changelog.txt
"""

from __future__ import annotations
import argparse, json, os, sys
from collections import Counter

DEF_BASE   = r"C:\Downloads\development\funko_enrich\funkodex_base_catalog.json"
DEF_BACKUP = r"C:\Downloads\funkodex_upc_verify\funkodex_backup.json"


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def dump(o, p):
    with open(p, "w", encoding="utf-8") as f:
        json.dump(o, f, indent=2, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base",   default=DEF_BASE)
    ap.add_argument("--backup", default=DEF_BACKUP)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true",
                    help="write even if the merge would create new orphans")
    args = ap.parse_args()

    for p in (args.base, args.backup):
        if not os.path.exists(p):
            sys.exit(f"not found: {p}")

    base = load(args.base)
    bk = load(args.backup)

    old_cat = [r for r in bk if r.get("type") == "catalog"]
    keep = [r for r in bk if r.get("type") != "catalog"]      # everything we preserve
    coll = [r for r in keep if r.get("type") == "funko"]

    print("merge_backup" + ("  (DRY RUN)" if args.dry_run else ""))
    print("=" * 66)
    print("BEFORE")
    print(f"  backup total        : {len(bk)}")
    print(f"    catalog (replaced): {len(old_cat)}")
    print(f"    preserved         : {len(keep)}  -> {dict(Counter(r.get('type') for r in keep))}")
    print(f"  enriched base       : {len(base)}")

    old_ids = {r.get("_id") for r in old_cat}
    new_ids = {r.get("_id") for r in base}

    print()
    print("CATALOG DELTA")
    print(f"  added by merge   : {len(new_ids - old_ids)}")
    print(f"  removed by merge : {len(old_ids - new_ids)}")

    # ── orphan gate ─────────────────────────────────────────────────────────
    was_orphan, will_orphan = [], []
    for r in coll:
        ref = r.get("catalogRef")
        if not ref:
            continue
        if ref not in old_ids:
            was_orphan.append(r)          # already broken before this merge
        elif ref not in new_ids:
            will_orphan.append(r)         # THIS MERGE would break it

    print()
    print("ORPHAN CHECK")
    print(f"  owned items with a catalogRef : {sum(1 for r in coll if r.get('catalogRef'))}")
    print(f"  already orphaned (pre-existing): {len(was_orphan)}")
    for r in was_orphan[:8]:
        print(f"      {str(r.get('name'))[:30]:30} -> {r.get('catalogRef')}")
    print(f"  NEWLY orphaned by this merge   : {len(will_orphan)}")
    for r in will_orphan[:20]:
        print(f"      {str(r.get('name'))[:30]:30} -> {r.get('catalogRef')}")

    if will_orphan and not args.force:
        print()
        print("=" * 66)
        print("  REFUSING TO WRITE — this merge would orphan owned items.")
        print("  Those catalogRefs point at records the enriched base no longer has.")
        print("  Fix the links (or confirm the records really are gone) first.")
        print("  Re-run with --force to write anyway.")
        sys.exit(1)

    merged = list(base) + keep

    print()
    print("AFTER")
    print(f"  merged total : {len(merged)}")
    print(f"    catalog    : {len(base)}")
    print(f"    collection : {len(coll)}  (untouched)")
    print(f"    other      : {len(keep) - len(coll)}  (untouched)")

    if args.dry_run:
        print("\nDRY RUN — nothing written.")
        return

    out = args.backup.replace(".json", ".merged.json")
    dump(merged, out)

    log = [
        f"catalog replaced: {len(old_cat)} -> {len(base)}",
        f"added: {len(new_ids - old_ids)}   removed: {len(old_ids - new_ids)}",
        f"collection preserved: {len(coll)}",
        f"other preserved: {len(keep) - len(coll)}",
        f"pre-existing orphans: {len(was_orphan)}",
        f"new orphans: {len(will_orphan)}",
    ]
    clog = os.path.join(os.path.dirname(args.backup) or ".", "merge_backup_changelog.txt")
    with open(clog, "w", encoding="utf-8") as f:
        f.write("\n".join(log) + "\n")

    print(f"\n  written   : {out}")
    print(f"  changelog : {clog}")
    print("\nOriginal untouched. Verify, then rename over it.")


if __name__ == "__main__":
    main()
