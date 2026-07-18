r"""
build_catalog_asset.py — package the enriched catalog for the FunkoDex app.

MIT License, Copyright (c) 2026 Chris Ahrendt

Takes the enriched base catalog and produces the gzipped asset the app's
CatalogPreloader streams out of assets/, validating it against exactly what the
Kotlin BaseRecord expects BEFORE writing — a bad asset fails silently at app
startup (records get skipped, no crash), so it's worth checking here.

Checks performed:
  - every record has a usable document id (_id or handle)
  - every record has a non-blank title  (records without one are SKIPPED by the
    loader, so a high count here means data loss)
  - no collection records (type="funko") leaked into the catalog
  - booleans are real booleans, not the strings "True"/"False"
  - funkoNumber sentinels are reported (the loader drops them)
  - reports gzip size

USAGE (Windows), from the folder holding the enriched catalog:
    py build_catalog_asset.py
    py build_catalog_asset.py --check-only
    py build_catalog_asset.py --base funkodex_base_catalog.json ^
                              --out  funkodex_base_catalog.json.gz_
"""

from __future__ import annotations
import argparse, gzip, json, os, sys
from collections import Counter

DEF_BASE = "funkodex_base_catalog.json"
# NOTE THE TRAILING UNDERSCORE — deliberate and load-bearing.
# The file IS ordinary gzip; only the extension is odd. AGP's asset merger
# DECOMPRESSES any `.gz` under app/src/main/assets and STRIPS the extension
# during mergeXxxAssets (before AAPT2, and `gradlew clean` does not stop it).
# Shipping this as `.gz` put an 18.1 MB decompressed .json in the APK instead of
# the 2.0 MB gzip, so CatalogPreloader's assets.open("...json.gz") threw
# FileNotFoundException and THE CATALOG NEVER LOADED ON ANY DEVICE — silently,
# because name search falls back to the network when the local query is empty.
# Must match CatalogPreloader.ASSET_NAME and the gradle `noCompress += "gz_"`.
DEF_OUT  = "funkodex_base_catalog.json.gz_"

UNRESOLVED = "__unresolved__"

# Fields the Kotlin BaseRecord declares. Anything else in the JSON is ignored by
# Gson (harmless), but a field the app NEEDS being absent is worth knowing about.
BOOL_FIELDS = ["isExclusive", "isChase", "isVaulted", "marketValueIsApproximate"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEF_BASE)
    ap.add_argument("--out",  default=DEF_OUT)
    ap.add_argument("--check-only", action="store_true",
                    help="validate but don't write the .gz_ asset")
    args = ap.parse_args()

    if not os.path.exists(args.base):
        sys.exit(f"not found: {args.base}")

    print(f"loading {args.base} …")
    base = json.load(open(args.base, encoding="utf-8"))
    print(f"  records: {len(base)}")
    print()

    problems = 0

    # ── 1. collection records must not be here ──────────────────────────────
    types = Counter(r.get("type") for r in base)
    print("RECORD TYPES")
    for t, n in types.most_common():
        print(f"  {str(t):12} {n}")
    owned = types.get("funko", 0)
    if owned:
        print(f"  !! {owned} collection records (type=funko) in the catalog — "
              f"these must NOT ship")
        problems += 1
    else:
        print("  OK — no collection records present")

    # ── 2. document ids ─────────────────────────────────────────────────────
    no_id = [r for r in base if not (str(r.get("_id") or "").strip()
                                     or str(r.get("handle") or "").strip())]
    print()
    print("DOCUMENT IDS")
    print(f"  records with no _id and no handle : {len(no_id)}   "
          f"({'OK' if not no_id else 'these are SKIPPED by the loader'})")
    if no_id:
        problems += 1

    # ── 3. titles (the loader drops title-less records) ─────────────────────
    no_title = [r for r in base if not str(r.get("title") or "").strip()]
    print()
    print("TITLES")
    print(f"  records with no title : {len(no_title)}   "
          f"({'OK' if not no_title else 'these are SKIPPED by the loader'})")
    for r in no_title[:5]:
        print(f"      {r.get('_id')}")
    if no_title:
        problems += 1

    # ── 4. boolean types ────────────────────────────────────────────────────
    print()
    print("BOOLEAN FIELDS  (Kotlin reads these as Boolean; a string silently"
          " becomes false)")
    for f in BOOL_FIELDS:
        kinds = Counter(type(r[f]).__name__ for r in base if f in r)
        bad = sum(n for k, n in kinds.items() if k != "bool")
        status = "OK" if bad == 0 else f"!! {bad} non-boolean"
        print(f"  {f:26} {dict(kinds)}  {status}")
        if bad:
            problems += 1

    # ── 5. sentinels ────────────────────────────────────────────────────────
    unresolved = sum(1 for r in base
                     if str(r.get("funkoNumber") or "") == UNRESOLVED)
    print()
    print("SENTINELS")
    print(f"  funkoNumber == {UNRESOLVED!r} : {unresolved}   "
          f"(loader omits the field for these — fine)")

    # ── 6. series shape ─────────────────────────────────────────────────────
    series_kinds = Counter(type(r.get("series")).__name__ for r in base if "series" in r)
    print()
    print("SERIES SHAPE")
    print(f"  {dict(series_kinds)}")
    if series_kinds.get("list"):
        print("  !! some records still carry a series LIST — the app expects a")
        print("     string (base-catalog shape). Run toBaseCatalogShape first.")
        problems += 1
    else:
        print("  OK — string series (base-catalog shape)")

    # ── verdict ─────────────────────────────────────────────────────────────
    print()
    print("=" * 62)
    if problems:
        print(f"  {problems} problem(s) found — see above.")
        if not args.check_only:
            print("  NOT writing the asset. Fix these, or re-run with --check-only")
            print("  to inspect without writing.")
            sys.exit(1)
    else:
        print("  All checks passed.")

    if args.check_only:
        print("\n--check-only — nothing written.")
        return

    raw = json.dumps(base, ensure_ascii=False).encode("utf-8")
    gz = gzip.compress(raw, compresslevel=9)
    with open(args.out, "wb") as f:
        f.write(gz)

    print()
    print(f"  uncompressed : {len(raw)/1e6:.1f} MB")
    print(f"  gzipped      : {len(gz)/1e6:.1f} MB  ({len(gz)*100//len(raw)}%)")
    print(f"  written      : {args.out}")
    print()
    print("Next:")
    print(f"  1. copy {args.out} to  app\\src\\main\\assets\\")
    print( "     and DELETE any older funkodex_base_catalog.json.gz sitting there.")
    print( "     An asset named .gz is DECOMPRESSED and RENAMED by AGP's merger")
    print( "     (before AAPT2; gradlew clean does not stop it) — that is why this")
    print( "     file ends in .gz_ and gradle sets noCompress += \"gz_\".")
    print( "  2. bump CatalogPreloader.CATALOG_VER — installs keep their loaded")
    print( "     copy until the version string changes.")
    print( "  3. VERIFY the APK really contains it before shipping:")
    print( "       [IO.Compression.ZipFile]::OpenRead(\"app-debug.apk\").Entries |")
    print( "         Where-Object { $_.FullName -like \"assets/funkodex*\" }")
    print(f"     Want {args.out} at ~{len(gz)/1e6:.1f} MB. A plain .json at ~18 MB")
    print( "     means AGP ate it and the catalog will NOT load.")
    print( "  4. Fresh-install and confirm logcat: \"Catalog loaded: <n> items\".")
    print( "     A restore BYPASSES the preloader (the backup carries its own")
    print( "     catalog). An AssetMissing warning = silent failure: name search")
    print( "     falls back to the network, so the app still looks fine.")


if __name__ == "__main__":
    main()
