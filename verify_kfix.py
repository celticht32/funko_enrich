r"""
verify_kfix.py — check fix_known_issues.py output before renaming.

MIT License, Copyright (c) 2026 Chris Ahrendt

Read-only. Confirms the five corrections landed, and specifically whether the
Evil Queen survivor carries the funkoNumber / PriceCharting id that the deleted
stub held. If those are blank, the stub's data was lost and the .kfix.json
should NOT be renamed over the original.

USAGE (Windows), from the folder holding the .kfix.json:
    py verify_kfix.py
    py verify_kfix.py --base funkodex_base_catalog.kfix.json ^
                      --backup C:\Downloads\funkodex_upc_verify\funkodex_backup.kfix.json
"""

from __future__ import annotations
import argparse, json, os

DEF_BASE   = "funkodex_base_catalog.kfix.json"
DEF_BACKUP = r"C:\Downloads\funkodex_upc_verify\funkodex_backup.kfix.json"

EQ   = "catalog::81681.html"
STUB = "catalog::pc-10118182"
CAST = "catalog::castiel-funko's"
TOAD = "catalog::mr.-toad-65th-anniversary"
BELLE_TARGET = "catalog::the-beast-and-belle"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base",   default=DEF_BASE)
    ap.add_argument("--backup", default=DEF_BACKUP)
    args = ap.parse_args()

    if not os.path.exists(args.base):
        raise SystemExit(f"not found: {args.base}")

    base = json.load(open(args.base, encoding="utf-8"))
    d = {r.get("_id"): r for r in base}

    print("=" * 58)
    print("BASE")
    print("=" * 58)
    print(f"  records: {len(base)}   (expect 20580)")
    print()

    eq = d.get(EQ)
    if eq is None:
        print(f"  !! {EQ} MISSING")
    else:
        print(f"  Evil Queen ({EQ}):")
        for k in ["title", "funkoNumber", "upc", "pricechartingId",
                  "pricechartingUrl", "series", "imageUrl", "marketValueLoose"]:
            v = eq.get(k)
            if k == "imageUrl" and v:
                v = "..." + str(v)[-40:]
            print(f"      {k:20} = {v!r}")
        print()
        num_ok = str(eq.get("funkoNumber") or "").strip() not in ("", "__unresolved__")
        pc_ok  = str(eq.get("pricechartingId") or "").strip() != ""
        upc_ok = str(eq.get("upc") or "").strip() == "889698816816"
        print(f"      funkoNumber present : {'YES' if num_ok else 'NO  <-- stub data lost'}")
        print(f"      pricechartingId     : {'YES' if pc_ok else 'NO  <-- stub data lost'}")
        print(f"      upc == 889698816816 : {'YES' if upc_ok else 'NO'}")

    print()
    print(f"  castiel re-added : {CAST in d}")
    print(f"  mrtoad added     : {TOAD in d}")
    print(f"  stub removed     : {STUB not in d}")

    # ── backup ──────────────────────────────────────────────────────────────
    if os.path.exists(args.backup):
        bk = json.load(open(args.backup, encoding="utf-8"))
        coll = [r for r in bk if r.get("type") == "funko"]
        base_ids = set(d)
        print()
        print("=" * 58)
        print("BACKUP — orphan check")
        print("=" * 58)
        orphans = []
        for r in coll:
            ref = r.get("catalogRef")
            if ref and ref not in base_ids:
                orphans.append((r.get("_id"), r.get("name"), ref))
        print(f"  collection items      : {len(coll)}")
        print(f"  orphaned catalogRefs  : {len(orphans)}")
        for rid, name, ref in orphans[:10]:
            print(f"      {rid}  {name!r} -> {ref}")
        if not orphans:
            print("      none — every owned item resolves to a catalog record")

        # spot-check the three we fixed
        print()
        for rid in ("funko::889698575836", "funko::889698502702", "funko::889698511728"):
            r = next((x for x in bk if x.get("_id") == rid), None)
            if r:
                ref = r.get("catalogRef")
                ok = ref in base_ids
                print(f"      {r.get('name'):24} -> {str(ref):42} {'OK' if ok else 'ORPHAN'}")
    else:
        print(f"\n  (backup not found at {args.backup} — skipped orphan check)")

    print()
    print("If everything above looks right, rename the .kfix.json files over the")
    print("originals. If Evil Queen shows 'stub data lost', do NOT rename — say so.")


if __name__ == "__main__":
    main()
