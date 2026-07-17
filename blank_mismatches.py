#!/usr/bin/env python3
r"""
blank_mismatches.py — remove wrongly-stamped PriceCharting identity data.

MIT License, Copyright (c) 2026 Chris Ahrendt

WHY
The enrich run matched new funko.com records against PriceCharting and copied the
matched Pop's identity onto them. Where the match was wrong, the record kept its
own correct title/image but gained a DIFFERENT Pop's funkoNumber, pricechartingId,
series and pricing. Nothing looks empty, so the corruption is silent.

Confirmed example (already fixed separately): "Evil Queen (Snow White Stained
Glass)" was stamped with "Snow White & Evil Queen" #6, a Pop! Minis 2-pack.

WHAT THIS DOES
For the records listed below — identified by comparing each record's title against
the slug in its pricechartingUrl — it BLANKS the wrongly-inherited identity fields
and leaves everything funko.com supplied (title, image, handle) untouched. A later
enrich run can then re-resolve them from scratch.

Blanking rather than correcting is deliberate: fixing them would mean sourcing 22
real funkoNumbers/pcIds by hand, and a wrong correction is worse than an empty
field. A blank re-resolves cleanly; a wrong value corrupts silently.

SAFETY
Each record is only blanked if it STILL carries the exact wrong slug named in the
plan. If a record has changed since the plan was made, it is skipped and reported,
never blanked on assumption.

NOT INCLUDED (tripped the detector but are almost certainly correct matches —
just different naming conventions): Kylian Mbappé (accent), De'Aaron Fox
(apostrophe), Erza -> erza-scarlet, Plo Koon -> plo-koon-glow-in-the-dark,
Chopper -> tony-tony-chopper-flocked, Alligator -> alligator-loki,
Rebecca -> rebecca-cunningham, Peni Parker (url encoding), H.E.R.B.I.E. -> herbie.

INPUT (default):
  funkodex_base_catalog.json

OUTPUT:
  funkodex_base_catalog.blank.json
  blank_mismatches_changelog.txt

Originals untouched.

USAGE (Windows):
    py blank_mismatches.py
    py blank_mismatches.py --dry-run          (report only, write nothing)
    py blank_mismatches.py --base C:\path\funkodex_base_catalog.json
"""

from __future__ import annotations
import argparse, json, os, sys

DEF_BASE = "funkodex_base_catalog.json"

# Identity fields the bad match wrote. Blanked so enrich can re-resolve them.
# title / imageUrl / handle are NOT here — those came from funko.com and are right.
BLANK_FIELDS = [
    "funkoNumber", "seriesNumber", "pricechartingId", "pricechartingUrl",
    "series", "pcSeries", "category", "franchiseSuggestion",
    "marketValueLoose", "marketValueComplete", "marketValueNew",
    "marketValueIsApproximate", "ebayEpid",
]

PLAN = json.loads(r"""
[
    {
        "_id": "catalog::90849.html",
        "title": "Venom (Marvel Rivals)",
        "wrong_slug": "venomized-doctor-doom",
        "reason": "different figure (Doctor Doom, not Venom)"
    },
    {
        "_id": "catalog::94351.html",
        "title": "Will (Tales from '85)",
        "wrong_slug": "chilly-willy-frozen",
        "reason": "different franchise entirely (Woody Woodpecker)"
    },
    {
        "_id": "catalog::80039.html",
        "title": "Harry (Beanie on Fire)",
        "wrong_slug": "hermione-granger",
        "reason": "different character"
    },
    {
        "_id": "catalog::86512.html",
        "title": "Ram",
        "wrong_slug": "bram-stoker",
        "reason": "substring collision: 'ram' inside 'bram'"
    },
    {
        "_id": "catalog::93001.html",
        "title": "Poe",
        "wrong_slug": "poet-anderson",
        "reason": "substring collision: 'poe' inside 'poet'"
    },
    {
        "_id": "catalog::83964.html",
        "title": "Spider-Man (No Way Home Suit)",
        "wrong_slug": "spider-man-homemade-suit",
        "reason": "different suit variant"
    },
    {
        "_id": "catalog::83965.html",
        "title": "Hulk (Brand New Day)",
        "wrong_slug": "hulk-holiday",
        "reason": "different figure (Holiday Hulk)"
    },
    {
        "_id": "catalog::94347.html",
        "title": "Mike (Tales from '85)",
        "wrong_slug": "freddy-funko-as-mike-se",
        "reason": "different product (Freddy Funko AS Mike)"
    },
    {
        "_id": "catalog::94346.html",
        "title": "Eleven (Tales from '85)",
        "wrong_slug": "byers-house-eleven",
        "reason": "different release"
    },
    {
        "_id": "catalog::90357.html",
        "title": "Maul",
        "wrong_slug": "darth-maul-on-bloodfin-speeder",
        "reason": "different figure (rider version)"
    },
    {
        "_id": "catalog::90303.html",
        "title": "The Joker (Batman Ninja)",
        "wrong_slug": "batman-vs-the-joker-batman-1989",
        "reason": "different product (1989 2-pack)"
    },
    {
        "_id": "catalog::95803.html",
        "title": "Baby (Soda Pop)",
        "wrong_slug": "robin-with-baby",
        "reason": "different figure (Robin)"
    },
    {
        "_id": "catalog::88407.html",
        "title": "King Ghidorah",
        "wrong_slug": "mecha-king-ghidorah",
        "reason": "different variant (Mecha)"
    },
    {
        "_id": "catalog::88980.html",
        "title": "Miles Morales (Vibranium Suit)",
        "wrong_slug": "miles-morales-programmable-matter-suit",
        "reason": "different suit variant"
    },
    {
        "_id": "catalog::86369.html",
        "title": "Batman (DC New Classics)",
        "wrong_slug": "batman-sdcc",
        "reason": "different exclusive"
    },
    {
        "_id": "catalog::86371.html",
        "title": "Wonder Woman (DC New Classics)",
        "wrong_slug": "wonder-woman-dc-super-heroes",
        "reason": "different release"
    },
    {
        "_id": "catalog::92046.html",
        "title": "The Creature",
        "wrong_slug": "creature-from-the-black-lagoon",
        "reason": "possibly right, but slug is a different listing"
    },
    {
        "_id": "catalog::86268.html",
        "title": "Pumpkinhead",
        "wrong_slug": "neighbor-pumpkinhead",
        "reason": "different figure (The Neighbor)"
    },
    {
        "_id": "catalog::90443.html",
        "title": "The Mandalorian with Grogu (On Bantha)",
        "wrong_slug": "the-mandalorian-on-speeder-with-grogu",
        "reason": "different vehicle (speeder vs bantha)"
    },
    {
        "_id": "catalog::90646.html",
        "title": "Nico Robin (Hana Hana no Mi)",
        "wrong_slug": "nico-robin-with-mini-merry-ii",
        "reason": "different variant"
    },
    {
        "_id": "catalog::91682.html",
        "title": "Vegito (Powering Up)",
        "wrong_slug": "super-saiyan-vegito",
        "reason": "different variant"
    },
    {
        "_id": "catalog::90767.html",
        "title": "Woody (Toy Story 5)",
        "wrong_slug": "sheriff-woody",
        "reason": "different release (Toy Story 5 vs classic)"
    }
]
""")


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def dump(o, p):
    with open(p, "w", encoding="utf-8") as f:
        json.dump(o, f, indent=2, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEF_BASE)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.base):
        sys.exit(f"not found: {args.base}")

    base = load(args.base)
    byid = {r.get("_id"): r for r in base}
    log, blanked, skipped = [], 0, []

    print("blank_mismatches" + ("  (DRY RUN — nothing will be written)" if args.dry_run else ""))
    print("=" * 72)

    for entry in PLAN:
        rid = entry["_id"]
        r = byid.get(rid)
        if r is None:
            skipped.append((rid, entry["title"], "not in base"))
            continue

        # safety: only blank if the record still carries the wrong slug
        url = str(r.get("pricechartingUrl") or "")
        if entry["wrong_slug"] not in url:
            skipped.append((rid, entry["title"],
                            f"slug changed (url now {url[:50] or 'empty'})"))
            continue

        cleared = []
        for f in BLANK_FIELDS:
            v = r.get(f)
            if v not in (None, "", [], {}):
                cleared.append(f"{f}={v!r}")
                r[f] = ""
        blanked += 1
        print(f"  {entry['title'][:42]:42}")
        print(f"      was matched to : {entry['wrong_slug'][:52]}")
        print(f"      reason         : {entry['reason']}")
        print(f"      cleared        : {len(cleared)} fields")
        log.append(f"{rid}  {entry['title']!r}")
        log.append(f"    wrong match : {entry['wrong_slug']}  ({entry['reason']})")
        for c in cleared:
            log.append(f"    cleared {c}")

    print()
    print("=" * 72)
    print(f"  blanked : {blanked}")
    print(f"  skipped : {len(skipped)}")
    for rid, title, why in skipped:
        print(f"      {title[:36]:36} — {why}")

    if args.dry_run:
        print("\nDRY RUN — no file written.")
        return

    out = args.base.replace(".json", ".blank.json")
    dump(base, out)
    clog = os.path.join(os.path.dirname(args.base) or ".", "blank_mismatches_changelog.txt")
    with open(clog, "w", encoding="utf-8") as f:
        f.write("\n".join(log) + "\n")

    print(f"\n  written   : {out}")
    print(f"  changelog : {clog}")
    print("\nOriginal untouched. Title/image/handle preserved on every record —")
    print("only the wrongly-inherited PriceCharting identity was cleared.")
    print("Re-run enrich later to re-resolve these from their own titles.")


if __name__ == "__main__":
    main()
