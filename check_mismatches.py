r"""
check_mismatches.py — find records where enrich stamped the WRONG Pop's identity.

MIT License, Copyright (c) 2026 Chris Ahrendt

Read-only. Writes a report (and optionally a JSON list) — changes nothing.

WHY THIS EXISTS
The enrich run matched funko.com records against PriceCharting and copied the
matched Pop's identity onto them. When the match was wrong, the record keeps its
own (correct) title and image but carries a DIFFERENT Pop's funkoNumber,
pricechartingId, series and pricing. That is silent corruption: every field looks
populated, so a "is it filled in?" check passes.

Confirmed example: catalog::81681.html "Evil Queen (Snow White Stained Glass)"
was stamped with "Snow White & Evil Queen" #6 (a Pop! Minis 2-pack):
    pricechartingUrl = .../funko-pop-minis/snow-white-&-evil-queen-6
    funkoNumber      = 6          (real answer: 1609)
    series           = Animation & Cartoons   (real answer: Pop! Disney)

HOW IT DETECTS
pricechartingUrl embeds the matched Pop's slug and number, e.g.
    https://www.pricecharting.com/game/funko-pop-disney/evil-queen-1609

IMPORTANT: comparing that number against the record's funkoNumber does NOT work.
When enrich mis-matches, it overwrites the funkoNumber from the same wrong match,
so the two always agree — the corruption is self-consistent. (The Evil Queen
record read funkoNumber 6 AND url .../snow-white-&-evil-queen-6.)

The signal that does survive is the record's OWN title and image, which enrich
never overwrites. So we compare the title against the PC slug:

  A. NAME MISMATCH — the PC slug shares no meaningful word with the title.
     e.g. title "Bash" matched to .../cindy-lou-who-661 — clearly wrong.

  B. WEAK OVERLAP — slug and title share some words but the slug carries extra
     identifying words the title lacks (or vice versa), e.g.
     "Evil Queen (Snow White Stained Glass)" vs slug "snow-white-&-evil-queen".
     Both mention snow/white/evil/queen, so A won't fire — but the slug describes
     a 2-pack and the title a single Deluxe. These need eyes.

Neither check is proof. Variant naming legitimately diverges between funko.com and
PriceCharting. Treat the output as a worklist, not a verdict.

USAGE (Windows), from the folder holding the catalog:
    py check_mismatches.py
    py check_mismatches.py --base funkodex_base_catalog.json --out mismatches.json
    py check_mismatches.py --all          (check every record, not just funko.com)
"""

from __future__ import annotations
import argparse, json, os, re, sys

DEF_BASE = "funkodex_base_catalog.json"

STOP = {"the", "a", "an", "and", "of", "with", "in", "on", "pop", "funko",
        "vinyl", "figure", "exclusive", "deluxe", "special", "edition"}


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def words(s):
    return {w for w in re.split(r"[^a-z0-9]+", str(s or "").lower())
            if w and w not in STOP and len(w) > 2}


def pc_slug_and_num(url):
    """Pull the matched slug + trailing number out of a PriceCharting game url."""
    m = re.search(r"/game/[^/]+/([^/?#]+)", str(url or ""))
    if not m:
        return None, None
    slug = m.group(1)
    n = re.search(r"-(\d+)$", slug)
    num = n.group(1) if n else None
    name = re.sub(r"-\d+$", "", slug)
    return name, num


def is_funko_com(r):
    return str(r.get("handle") or "").endswith(".html") or str(r.get("_id") or "").endswith(".html")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEF_BASE)
    ap.add_argument("--out",  default="mismatches.json")
    ap.add_argument("--all",  action="store_true",
                    help="check every record, not just funko.com-sourced ones")
    args = ap.parse_args()

    if not os.path.exists(args.base):
        sys.exit(f"not found: {args.base}")

    base = load(args.base)
    pool = base if args.all else [r for r in base if is_funko_com(r)]

    print(f"loaded {len(base)} records; checking {len(pool)} "
          f"({'all' if args.all else 'funko.com-sourced'})")
    print()

    have_url = [r for r in pool if str(r.get("pricechartingUrl") or "").strip()]
    print(f"  with a pricechartingUrl (i.e. enrich matched them): {len(have_url)}")
    print()

    no_overlap, weak = [], []
    for r in have_url:
        slug, pcnum = pc_slug_and_num(r.get("pricechartingUrl"))
        if not slug:
            continue
        rec_num = str(r.get("funkoNumber") or "").strip()
        tw = words(r.get("title"))
        sw = words(slug.replace("-", " "))
        if not tw or not sw:
            continue

        shared = tw & sw
        if not shared:
            # A: nothing in common — almost certainly a wrong match
            no_overlap.append((r, slug, pcnum, rec_num, tw, sw))
        elif (sw - tw):
            # B: slug carries identifying words the title doesn't — the Evil Queen
            # shape (slug said "snow white & evil queen", title said "evil queen
            # (snow white stained glass)"; slug's extra words describe a 2-pack)
            weak.append((r, slug, pcnum, rec_num, sorted(sw - tw)))

    print("=" * 70)
    print(f"A. NO OVERLAP — PC slug shares NO word with the title : {len(no_overlap)}")
    print("=" * 70)
    print("   Strong signal. enrich matched this record to an unrelated Pop and")
    print("   stamped that Pop's number/pcId/series/pricing onto it.")
    print()
    for r, slug, pcnum, rec_num, tw, sw in no_overlap[:40]:
        print(f"   {str(r.get('_id'))[:36]:36} {str(r.get('title'))[:32]:32}")
        print(f"       matched -> {slug[:50]}   (record now says #{rec_num})")
    if len(no_overlap) > 40:
        print(f"   ... and {len(no_overlap)-40} more")

    print()
    print("=" * 70)
    print(f"B. PARTIAL — slug has identifying words the title lacks : {len(weak)}")
    print("=" * 70)
    print("   The Evil Queen shape. Many are benign (PC just names variants")
    print("   differently), so this needs eyes rather than bulk action.")
    print()
    for r, slug, pcnum, rec_num, extra in weak[:25]:
        print(f"   {str(r.get('_id'))[:36]:36} {str(r.get('title'))[:32]:32}")
        print(f"       matched -> {slug[:44]}  extra: {','.join(extra[:5])}")
    if len(weak) > 25:
        print(f"   ... and {len(weak)-25} more")

    out = {
        "no_overlap": [
            {"_id": r.get("_id"), "title": r.get("title"), "record_number": rn,
             "pc_slug": s, "pricechartingUrl": r.get("pricechartingUrl"),
             "pricechartingId": r.get("pricechartingId"), "series": r.get("series")}
            for r, s, pn, rn, tw, sw in no_overlap
        ],
        "partial": [
            {"_id": r.get("_id"), "title": r.get("title"), "record_number": rn,
             "pc_slug": s, "slug_extra_words": ex,
             "pricechartingUrl": r.get("pricechartingUrl")}
            for r, s, pn, rn, ex in weak
        ],
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)

    print()
    print(f"  wrote {args.out}")
    print()
    print("Read-only — nothing modified. Neither check is proof; use as a worklist.")


if __name__ == "__main__":
    main()
