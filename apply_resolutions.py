#!/usr/bin/env python3
"""Apply mismatch resolutions to the enriched catalog.
DRY-RUN by default: prints every field change (old -> new) and writes nothing.
Pass --apply to write. Reads resolutions.json + the enriched catalog.
"""
import json, sys, argparse

BLANK_VALUE = ""  # DEC-025: blank means empty string, consistent with catalog shape

ap = argparse.ArgumentParser()
ap.add_argument("--catalog", default="new.json")
ap.add_argument("--resolutions", default="resolutions.json")
ap.add_argument("--out", default="funkodex_base_catalog.enriched.RESOLVED.json")
ap.add_argument("--apply", action="store_true", help="actually write (default is dry-run)")
args = ap.parse_args()

cat = json.load(open(args.catalog, encoding="utf-8"))
res = json.load(open(args.resolutions, encoding="utf-8"))
by = {r.get("_id"): r for r in cat}

missing, applied, changes = [], 0, []
for _id, spec in res.items():
    rec = by.get(_id)
    if rec is None:
        missing.append(_id)
        continue
    row = []
    # sets
    for k, v in spec.get("set", {}).items():
        old = rec.get(k, "<absent>")
        if old != v:
            row.append((k, old, v))
    # blanks
    for k in spec.get("blank", []):
        old = rec.get(k, "<absent>")
        if old not in ("", None, "<absent>"):
            row.append((k, old, "(blanked)"))
    if row:
        changes.append((_id, rec.get("title", "?"), spec.get("action", "?"), row))
    applied += 1

# report
print(f"resolutions: {len(res)} | matched in catalog: {applied} | missing: {len(missing)}")
if missing:
    print("  MISSING ids (not in catalog):")
    for m in missing: print("   ", m)
print()
for _id, title, action, row in changes:
    print(f"=== {_id}  [{action}]  {title[:44]}")
    for k, old, new in row:
        os = str(old); ns = str(new)
        if len(os) > 42: os = os[:42] + "..."
        print(f"    {k:24} {os!r:46} -> {ns!r}")
    print()

if not args.apply:
    print(f"DRY-RUN — nothing written. Re-run with --apply to write {args.out}")
    sys.exit(0)

# apply
for _id, spec in res.items():
    rec = by.get(_id)
    if rec is None: continue
    for k, v in spec.get("set", {}).items():
        rec[k] = v
    for k in spec.get("blank", []):
        if k in rec:
            rec[k] = BLANK_VALUE
json.dump(cat, open(args.out, "w", encoding="utf-8"), ensure_ascii=False)
print(f"WROTE {args.out} ({len(cat)} records, {applied} resolved)")
