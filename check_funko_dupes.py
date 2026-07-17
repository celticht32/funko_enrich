r"""
check_funko_dupes.py — how many new funko.com records duplicate existing records?

MIT License, Copyright (c) 2026 Chris Ahrendt

Read-only. Writes nothing.

The enrich run added ~1,399 records scraped from funko.com. Those carry a proper
title and image but NO upc and often no funkoNumber. Existing records sourced
from the PriceCharting crawl (catalog::pc-#####) carry a funkoNumber + pricing
but often a bare title and no image.

When both describe the SAME figure (e.g. "Evil Queen" #1609 from PC and
"Evil Queen (Snow White Stained Glass)" from funko.com), they're duplicates that
each hold half the data — but exact-title matching can't see it.

This reports how widespread that is, using progressively looser signals, so you
can decide whether a fuzzy-merge pass is worth building.

USAGE (Windows), from the folder holding the enriched catalog:
    py check_funko_dupes.py
    py check_funko_dupes.py --base funkodex_base_catalog.json
"""

from __future__ import annotations
import argparse, json, os, re, sys
from collections import defaultdict

DEF_BASE = "funkodex_base_catalog.json"


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def norm(t):
    """Normalize a title: drop bracketed/parenthetical qualifiers, punctuation, case."""
    t = str(t or "").lower()
    t = re.sub(r"[\[\(].*?[\]\)]", " ", t)      # drop (Snow White Stained Glass)
    t = re.sub(r"#\d+", " ", t)
    t = re.sub(r"[^a-z0-9 ]", " ", t)
    return " ".join(t.split())


def is_funko_com(r):
    h = str(r.get("handle") or "")
    return h.endswith(".html") or str(r.get("_id") or "").endswith(".html")


def is_pc_stub(r):
    return str(r.get("_id") or "").startswith("catalog::pc-")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEF_BASE)
    args = ap.parse_args()
    if not os.path.exists(args.base):
        sys.exit(f"not found: {args.base}")

    base = load(args.base)
    fc = [r for r in base if is_funko_com(r)]
    pc = [r for r in base if is_pc_stub(r)]
    other = [r for r in base if not is_funko_com(r) and not is_pc_stub(r)]

    print("=" * 62)
    print("RECORD SOURCES")
    print("=" * 62)
    print(f"  total records          : {len(base)}")
    print(f"  funko.com (*.html)     : {len(fc)}")
    print(f"  PriceCharting (pc-#)   : {len(pc)}")
    print(f"  name-slug / other      : {len(other)}")

    # how complete is each source?
    def stat(rs, label):
        n = len(rs) or 1
        upc = sum(1 for r in rs if str(r.get("upc") or "").strip())
        num = sum(1 for r in rs if str(r.get("funkoNumber") or "").strip() not in ("", "__unresolved__"))
        img = sum(1 for r in rs if str(r.get("imageUrl") or "").strip())
        print(f"  {label:22} upc {upc*100//n:3}% | number {num*100//n:3}% | image {img*100//n:3}%")

    print()
    print("=" * 62)
    print("FIELD COVERAGE BY SOURCE  (why they complement each other)")
    print("=" * 62)
    stat(fc, "funko.com")
    stat(pc, "PriceCharting")
    stat(other, "name-slug/other")

    # Signal 1: normalized-title collision between a funko.com record and any other
    by_norm = defaultdict(list)
    for r in base:
        nt = norm(r.get("title"))
        if nt:
            by_norm[nt].append(r)

    fc_dupe_groups = []
    for nt, rs in by_norm.items():
        if len(rs) < 2:
            continue
        has_fc = any(is_funko_com(r) for r in rs)
        has_other = any(not is_funko_com(r) for r in rs)
        if has_fc and has_other:
            fc_dupe_groups.append((nt, rs))

    print()
    print("=" * 62)
    print("OVERLAP: funko.com record shares a NORMALIZED title with another record")
    print("=" * 62)
    print(f"  groups: {len(fc_dupe_groups)}")
    print(f"  funko.com records involved: "
          f"{sum(1 for _, rs in fc_dupe_groups for r in rs if is_funko_com(r))}")
    print()
    print("  (normalized = parentheticals dropped, so 'Evil Queen (Snow White")
    print("   Stained Glass)' normalizes to 'evil queen' and collides with the")
    print("   PriceCharting 'Evil Queen' #1609.)")
    print()
    print("  --- first 25 groups ---")
    for nt, rs in fc_dupe_groups[:25]:
        print(f"  {nt!r}")
        for r in rs:
            src = "funko.com" if is_funko_com(r) else ("pc-stub" if is_pc_stub(r) else "slug")
            print(f"      [{src:9}] {str(r.get('_id'))[:44]:44} {str(r.get('title'))[:38]:38} "
                  f"#{str(r.get('funkoNumber') or '')[:6]:6} upc={str(r.get('upc') or '')[:13]}")

    # Signal 2: how many of those groups would a merge actually IMPROVE?
    improvable = 0
    for nt, rs in fc_dupe_groups:
        fcs = [r for r in rs if is_funko_com(r)]
        oth = [r for r in rs if not is_funko_com(r)]
        # improvable if one side has image and the other has number/upc/pcid
        fc_img = any(str(r.get("imageUrl") or "").strip() for r in fcs)
        oth_id = any(str(r.get("funkoNumber") or "").strip() not in ("", "__unresolved__")
                     or str(r.get("pricechartingId") or "").strip() for r in oth)
        if fc_img and oth_id:
            improvable += 1

    print()
    print("=" * 62)
    print("VERDICT")
    print("=" * 62)
    print(f"  groups where a merge would ADD data to both sides: {improvable}")
    print()
    print("  NOTE: a normalized-title collision is NOT proof of duplication —")
    print("  'Evil Queen' matches the Stained Glass Deluxe, the Diamond Collection,")
    print("  and any other Evil Queen variant. Treat this as an UPPER BOUND on how")
    print("  many real dupes exist; each one still needs a number/UPC check or eyes.")
    print()
    print("Read-only — nothing was modified.")


if __name__ == "__main__":
    main()
