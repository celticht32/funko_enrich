# TODO: Remote Catalog Auto-Update (FunkoDex)

Status: PROPOSED — not started. Build AFTER the manual phone import/relink is
validated end-to-end (the auto-updater reuses the streaming importer, so prove
that path manually first).

License: MIT © 2026 Chris Ahrendt

---

## Goal

Keep the APK small (ship only the Kenny Chan base catalog) and deliver the large
enriched catalog (~16–36 MB raw) to installs over the network, automatically, with
no app release required per catalog update. Reuse the streaming `CatalogImporter`
already built.

## Why not bundle the enriched file in assets

- Bundling a 16–36 MB JSON inflates the APK by that much.
- The bundled catalog goes stale the moment enrichment re-runs — every catalog
  refresh would require an app release.
- `CatalogPreloader` currently does `assets.open("funko_data.json").readText()`
  (whole file into memory). Bundling the enriched file there carries the same OOM
  risk that was just removed from `CatalogImporter` — and on FIRST LAUNCH, which is
  the worst place to crash.

## Architecture

Small bundled base for instant usability + background hydrate from a remote
manifest-pointed asset.

On first launch (and on every launch as a cheap version check):

1. Seed from the small bundled Kenny base (`assets/funko_data.json`) so the app is
   immediately usable, even offline. No blank-catalog first impression.
2. Fetch a tiny `catalog-manifest.json` from the remote host (a few hundred bytes).
3. Compare manifest `version` to the local `CATALOG_VER` marker
   (already exists in `CatalogPreloader`, currently `"1"`).
4. If newer: download the gzipped enriched catalog (named by the manifest) into
   PRIVATE app storage (`context.filesDir` / `cacheDir`) — NOT the Downloads dir.
5. Verify `sha256` against the manifest before importing. Reject on mismatch.
6. Stream the gzipped file through the existing `CatalogImporter`
   (`GZIPInputStream` -> `JsonReader` -> existing per-record path).
7. Update the local version marker. Subsequent launches see matching version and
   skip the download.

## Key design decisions (settled)

- DO NOT scan the Downloads directory for the auto path. Downloads is for the
  separate MANUAL import path only. Auto path downloads to private app storage —
  no storage permissions, no dependence on user file placement.
- Version check via a small manifest, not file-presence. Presence only handles
  first launch; the manifest makes it a real update mechanism.
- GZIP the catalog. JSON compresses ~5–10x: a ~30 MB file becomes ~3–5 MB to
  download/store. Slashes bandwidth (stays under host throttles), speeds first
  launch, trivial decompress. `GZIPInputStream` composes directly with the
  streaming importer's `JsonReader`. HIGHEST-LEVERAGE refinement.
- Host behind the manifest. The app downloads from whatever URL the manifest
  names, so the host can change without an app update.

## Host choice

- raw.githubusercontent.com works for personal / low install counts TODAY, but is
  NOT built for repeated file serving: GitHub throttles excessive bandwidth and
  may flag accounts; unauthenticated raw requests are rate-limited (2025+).
  GitHub hard file limit is 100 MB/file (enriched file is under that).
- PREFER GitHub Releases assets over raw repo blobs: meant for file distribution,
  better bandwidth tolerance, and keeps the big file OUT of git history (raw repo
  files bloat the repo; release assets don't). Fits existing Actions/Releases
  workflow.
- FUTURE / scale path: Cloudflare R2 (free tier, zero egress fees, fast global
  delivery) — community-recommended for exactly this. The manifest indirection
  makes this a config change, not an app change.

## Components to build

- `CatalogUpdateService` (new): manifest fetch, version compare, download with
  retry, sha256 verify, gzip-stream into `CatalogImporter`. Graceful no-network
  path (app opens on base catalog, retries enriched fetch later — never hard-fail
  on first launch because the host was unreachable).
- Splash / launch wiring to invoke the service in the background with progress UI
  (reuse import progress; add download progress).
- `catalog-manifest.json` (new remote file). Proposed schema (DESIGN + GET
  APPROVAL before coding — show rendered shape per BRD/spec preference):
    {
      "version":   "2026-06-28",      // compared to local CATALOG_VER marker
      "url":       "https://.../funko_data_enriched.json.gz",
      "sha256":    "<hex>",
      "records":   41536,
      "minAppVersion": "1.x"          // optional gate for schema-breaking changes
    }
- Build/release step: produce enriched JSON -> gzip -> compute sha256 -> attach as
  release asset -> update manifest. Candidate for a GitHub Action.

## Robustness checklist

- No-network on first launch: open on base catalog, retry later. Never hard-fail.
- Partial/corrupt download: sha256 verify before import; retry on failure.
- Metered connection: consider deferring large download to Wi-Fi or prompting.
- Bump `CATALOG_VER` semantics: local marker tracks the LOADED catalog version so
  re-import only happens on a real version change.

## Open questions

- Manifest schema final shape (needs approval before coding).
- Wi-Fi-only vs any-network download policy for the big file.
- Whether the bundled base stays Kenny-only or a trimmed enriched subset.
- Verify `CatalogPreloader`'s parse/map path accepts the enriched schema (extra
  fields) if the enriched file is ever used there too.

## Dependencies / sequencing

1. Finish enrichment (Pass 3 pricing + post-process -> final golden master).
2. Validate MANUAL phone import + relink end-to-end (proves streaming
   `CatalogImporter` and golden-source `CollectionRelinkService` on real data/device).
3. THEN build this auto-updater on top of the proven importer.

Building the auto-updater on unproven import code stacks two unknowns; validating
the manual path first de-risks the automatic path.
