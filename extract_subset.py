r"""
extract_subset.py — pull just the records under review out of the enriched base.

MIT License, Copyright (c) 2026 Chris Ahrendt

The enriched catalog is ~20 MB, too big to hand over directly. This extracts only
the records relevant to the open questions (Castiel, the Evil Queen pair, Belle,
Mr. Toad, and every FunkO's-titled record) into a small file that can be uploaded
for verification.

Read-only on the base. Writes subset.json.

USAGE (Windows), from the folder holding the enriched catalog:
    py extract_subset.py
    py extract_subset.py --base funkodex_base_catalog.json --out subset.json
"""

from __future__ import annotations
import argparse, json, os, re, sys

DEF_BASE = "funkodex_base_catalog.json"
DEF_OUT  = "subset.json"

# explicit ids we care about
IDS = {
    "catalog::81681.html",            # Evil Queen (Snow White Stained Glass) — funko.com
    "catalog::pc-10118182",           # Evil Queen #1609 — PriceCharting stub
    "catalog::the-beast-and-belle",   # Belle re-link target
    "catalog::castiel-funko's",       # wrongly-deleted real Pop
    "catalog::evil-queen-funko's",    # the cereal (correctly deleted)
}

# title patterns we care about
PATTERNS = re.compile(
    r"funko'?s\b|funkos\b|castiel|evil queen|stained glass|mr\.?\s*toad|belle",
    re.I,
)

# fields that bloat the output and aren't needed for these decisions
DROP = {"thumbnailBlob"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEF_BASE)
    ap.add_argument("--out",  default=DEF_OUT)
    args = ap.parse_args()

    if not os.path.exists(args.base):
        sys.exit(f"not found: {args.base}\n(run this from the folder with the enriched catalog)")

    base = json.load(open(args.base, encoding="utf-8"))
    print(f"loaded {len(base)} records from {args.base}")

    keep = []
    for r in base:
        rid = str(r.get("_id") or "")
        title = str(r.get("title") or "")
        if rid in IDS or PATTERNS.search(title):
            keep.append({k: v for k, v in r.items() if k not in DROP})

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(keep, f, indent=1, ensure_ascii=False)

    size = os.path.getsize(args.out)
    print(f"extracted {len(keep)} records -> {args.out}  ({size/1024:.0f} KB)")
    print()
    print("Matched ids present:")
    got = {str(r.get('_id')) for r in keep}
    for i in sorted(IDS):
        print(f"   {'yes' if i in got else 'NO '}  {i}")
    print()
    print(f"Upload {args.out} for verification.")


if __name__ == "__main__":
    main()
