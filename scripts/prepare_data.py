#!/usr/bin/env python3
"""
prepare_data.py — Populate extension/data/ from the SpecRecon inventory.

Usage
─────
  python3 scripts/prepare_data.py [--zip PATH] [--out DIR] [--size-limit KB]
  python3 scripts/prepare_data.py --source-dir inventory/ [--out DIR] [--size-limit KB]

Options
  --zip PATH            Path to the sharded inventory zip
                        (default: auto-detected from inventory/)
  --source-dir DIR      Path to the export output directory containing shards/
                        (alternative to --zip — reads .min.json files directly)
  --out DIR             Output directory for extension data
                        (default: extension/data/)
  --size-limit KB       Only bundle shards up to this size in KB
                        (default: no limit — all shards are included)
  --pack-id ID          Unique identifier for this API pack
                        (default: azure-rest-api-specs)
  --pack-name NAME      Human-readable display name for the pack
                        (default: Azure REST API Specs)
  --platform PLATFORM   Platform identifier (e.g. azure, aws, gcp)
                        (default: azure)
  --pack-description D  Short description of this pack's contents
  --merge               Merge this pack into an existing manifest instead of
                        replacing it (preserves other packs in a v2.0.0 manifest)

Pack concept
─────────────
A "pack" is a named set of shards that describes one platform's API surface
(e.g. Azure REST API Specs, AWS API, Google Cloud API).  The manifest (v2.0.0)
groups shards by pack, letting the extension load and enable packs independently.

Shards for the built-in Azure pack are stored in the flat shards/ directory for
backward compatibility.  Shards for any other pack are stored in a subdirectory
named after their pack-id: shards/<pack-id>/.

This script is intended to be run from the repository root.
It does NOT modify any existing SpecRecon export code.
"""

import argparse
import glob
import json
import os
import shutil
import sys
import zipfile
from typing import List, Optional, Tuple

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(REPO_ROOT, "extension", "data")

# The built-in Azure pack uses the flat shards/ directory for backward
# compatibility.  All other packs use a shards/<pack-id>/ subdirectory.
DEFAULT_PACK_ID          = "azure-rest-api-specs"
DEFAULT_PACK_NAME        = "Azure REST API Specs"
DEFAULT_PACK_PLATFORM    = "azure"
DEFAULT_PACK_DESCRIPTION = (
    "Azure Resource Manager API specifications sourced from "
    "Azure/azure-rest-api-specs via UndREST-SpecQL."
)


def _pack_shards_subdir(pack_id: str) -> str:
    """
    Return the subdirectory name under out_dir/shards/ for the given pack.

    The built-in Azure pack uses no subdirectory (flat structure, backward
    compatible with v1.0.0 manifests).  All other packs use a subdirectory
    named after their pack_id, e.g. shards/aws-rest-api-specs/.
    """
    if pack_id == DEFAULT_PACK_ID:
        return ""
    return pack_id


def find_sharded_zip(inventory_dir: str) -> str:
    """Auto-detect the most recent sharded zip in inventory/."""
    pattern = os.path.join(inventory_dir, "api-index-sharded-*.zip")
    candidates = sorted(glob.glob(pattern), reverse=True)
    if not candidates:
        raise FileNotFoundError(
            "No api-index-sharded-*.zip found in " + inventory_dir
            + ". Run scripts/export/export_api_inventory.py --sharded first."
        )
    return candidates[0]


def extract_shards(zip_path: str, out_dir: str, size_limit: Optional[int],
                   pack_id: str = DEFAULT_PACK_ID) -> Tuple[List, List]:
    """
    Extract .min.json shards from the zip into out_dir/shards/ (or a pack
    subdirectory for non-default packs).

    Returns (bundled, skipped) — lists of dicts describing each shard.
    The ``filename`` field in each bundled entry is the path relative to
    out_dir/shards/ so that the extension loader can construct the full URL as
    ``data/shards/<filename>``.
    """
    subdir = _pack_shards_subdir(pack_id)
    shards_dir = os.path.join(out_dir, "shards", subdir) if subdir else os.path.join(out_dir, "shards")
    os.makedirs(shards_dir, exist_ok=True)

    bundled = []
    skipped = []

    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            name = info.filename
            if not (name.startswith("shards/") and name.endswith(".min.json")):
                continue

            basename = os.path.basename(name)
            # filename is relative to out_dir/shards/ so the loader can use
            # "data/shards/" + filename to construct the resource URL.
            manifest_filename = os.path.join(subdir, basename) if subdir else basename

            if size_limit is not None and info.file_size > size_limit:
                skipped.append({"filename": manifest_filename, "size_bytes": info.file_size})
                continue

            # Read + parse
            raw = zf.read(name)
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError as exc:
                print(f"  ⚠️  Skipping {basename}: JSON parse error: {exc}", file=sys.stderr)
                skipped.append({"filename": manifest_filename, "size_bytes": info.file_size, "error": str(exc)})
                continue

            provider_ns = parsed.get("provider_namespace", "")
            hosts = list(parsed.get("hosts", {}).keys())
            route_count = sum(
                len(h.get("routes", {})) for h in parsed.get("hosts", {}).values()
            )

            out_path = os.path.join(shards_dir, basename)
            with open(out_path, "wb") as fout:
                fout.write(raw)

            bundled.append(
                {
                    "filename": manifest_filename,
                    "provider_namespace": provider_ns,
                    "hosts": hosts,
                    "route_count": route_count,
                    "size_bytes": info.file_size,
                }
            )

    return bundled, skipped


def copy_shards_from_dir(source_dir: str, out_dir: str, size_limit: Optional[int],
                         pack_id: str = DEFAULT_PACK_ID) -> Tuple[List, List]:
    """
    Copy .min.json shards from source_dir/shards/ into out_dir/shards/ (or a
    pack subdirectory for non-default packs).

    This is an alternative to extract_shards() for use in CI where the export
    output is already on disk (no zip intermediary needed).

    The ``filename`` field in each bundled entry is the path relative to
    out_dir/shards/ so that the extension loader can construct the full URL as
    ``data/shards/<filename>``.

    Returns (bundled, skipped) — lists of dicts describing each shard.
    """
    src_shards_dir = os.path.join(source_dir, "shards")
    if not os.path.isdir(src_shards_dir):
        raise FileNotFoundError(
            f"No shards/ directory found in {source_dir}. "
            "Run scripts/export/export_api_inventory.py --sharded first."
        )

    subdir = _pack_shards_subdir(pack_id)
    dst_shards_dir = os.path.join(out_dir, "shards", subdir) if subdir else os.path.join(out_dir, "shards")
    os.makedirs(dst_shards_dir, exist_ok=True)

    bundled = []
    skipped = []

    for filename in sorted(os.listdir(src_shards_dir)):
        if not filename.endswith(".min.json"):
            continue

        src_path = os.path.join(src_shards_dir, filename)
        file_size = os.path.getsize(src_path)

        # filename relative to out_dir/shards/ for loader URL construction
        manifest_filename = os.path.join(subdir, filename) if subdir else filename

        if size_limit is not None and file_size > size_limit:
            skipped.append({"filename": manifest_filename, "size_bytes": file_size})
            continue

        # Read + parse to extract metadata
        with open(src_path, "rb") as f:
            raw = f.read()

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            print(f"  ⚠️  Skipping {filename}: JSON parse error: {exc}", file=sys.stderr)
            skipped.append({"filename": manifest_filename, "size_bytes": file_size, "error": str(exc)})
            continue

        provider_ns = parsed.get("provider_namespace", "")
        hosts = list(parsed.get("hosts", {}).keys())
        route_count = sum(
            len(h.get("routes", {})) for h in parsed.get("hosts", {}).values()
        )

        dst_path = os.path.join(dst_shards_dir, filename)
        shutil.copy2(src_path, dst_path)

        bundled.append(
            {
                "filename": manifest_filename,
                "provider_namespace": provider_ns,
                "hosts": hosts,
                "route_count": route_count,
                "size_bytes": file_size,
            }
        )

    return bundled, skipped


def _read_source_meta(out_dir: str, bundled: list, pack_id: str) -> dict:
    """Try to read SpecRecon metadata from the first bundled shard."""
    if not bundled:
        return {}
    subdir = _pack_shards_subdir(pack_id)
    first_filename = bundled[0]["filename"]
    # filename is relative to out_dir/shards/, strip pack subdir if present
    basename = os.path.basename(first_filename)
    shard_path = (
        os.path.join(out_dir, "shards", subdir, basename)
        if subdir
        else os.path.join(out_dir, "shards", basename)
    )
    try:
        with open(shard_path) as f:
            sample = json.load(f)
        return sample.get("metadata", {})
    except Exception:
        return {}


def write_manifest(
    out_dir: str,
    bundled: list,
    skipped: list,
    source_label: str,
    pack_id: str = DEFAULT_PACK_ID,
    pack_name: str = DEFAULT_PACK_NAME,
    platform: str = DEFAULT_PACK_PLATFORM,
    pack_description: str = DEFAULT_PACK_DESCRIPTION,
    merge: bool = False,
) -> None:
    """Write (or merge into) data/manifest.json using the v2.0.0 pack format.

    In ``merge`` mode, an existing v2.0.0 manifest is read and the specified
    pack is added or replaced while all other packs are preserved.  If no
    manifest exists yet, or the existing one is an older schema, a fresh
    manifest is written.

    Schema v2.0.0 groups shards by pack so multiple API source packs can
    coexist in one extension.  Each pack entry carries its own metadata and
    shard list, enabling the extension to load packs independently.
    """
    source_meta = _read_source_meta(out_dir, bundled, pack_id)

    new_pack = {
        "pack_id":              pack_id,
        "display_name":         pack_name,
        "platform":             platform,
        "description":          pack_description,
        "source_label":         source_label,
        "source_metadata": {
            "generated_at":     source_meta.get("generated_at", ""),
            "source_repo":      source_meta.get("source_repo", ""),
            "source_branch":    source_meta.get("source_branch", ""),
            "source_commit":    source_meta.get("source_commit", ""),
            "tool_name":        source_meta.get("tool_name", ""),
            "schema_version":   source_meta.get("schema_version", ""),
        },
        "total_bundled_shards": len(bundled),
        "total_skipped_shards": len(skipped),
        "note_skipped":         "Shards that could not be parsed were omitted.",
        "shards":               sorted(bundled, key=lambda s: s["provider_namespace"].lower()),
        "skipped_shards":       sorted(s["filename"] for s in skipped),
    }

    # Attempt to preserve other packs from an existing v2.0.0 manifest.
    existing_packs: list = []
    if merge:
        manifest_path = os.path.join(out_dir, "manifest.json")
        if os.path.isfile(manifest_path):
            try:
                with open(manifest_path) as f:
                    existing = json.load(f)
                if existing.get("schema_version") == "2.0.0":
                    existing_packs = [
                        p for p in existing.get("packs", [])
                        if p.get("pack_id") != pack_id
                    ]
            except Exception as exc:
                print(f"  ⚠️  Could not read existing manifest for merge: {exc}", file=sys.stderr)

    packs = existing_packs + [new_pack]

    manifest = {
        "schema_version": "2.0.0",
        "description":    "APISpy bundled pack manifest",
        "packs":          packs,
    }

    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"  📄 Manifest written: {manifest_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--size-limit", metavar="KB", type=int, default=None,
                        help="Only bundle shards up to this size in KB (default: no limit)")
    parser.add_argument("--zip", metavar="PATH", help="Path to sharded inventory zip")
    parser.add_argument("--source-dir", metavar="DIR",
                        help="Path to export output directory containing shards/ "
                             "(alternative to --zip — reads .min.json files directly)")
    parser.add_argument("--out", metavar="DIR", default=DEFAULT_OUT, help="Output data directory")

    # Pack metadata arguments
    parser.add_argument("--pack-id", metavar="ID", default=DEFAULT_PACK_ID,
                        help=f"Unique identifier for this API pack (default: {DEFAULT_PACK_ID})")
    parser.add_argument("--pack-name", metavar="NAME", default=DEFAULT_PACK_NAME,
                        help=f"Human-readable name for this pack (default: {DEFAULT_PACK_NAME!r})")
    parser.add_argument("--platform", metavar="PLATFORM", default=DEFAULT_PACK_PLATFORM,
                        help=f"Platform identifier, e.g. azure, aws, gcp (default: {DEFAULT_PACK_PLATFORM})")
    parser.add_argument("--pack-description", metavar="DESC", default=DEFAULT_PACK_DESCRIPTION,
                        help="Short description of this pack's contents")
    parser.add_argument("--merge", action="store_true",
                        help="Merge this pack into an existing manifest rather than replacing it")

    args = parser.parse_args()

    if args.source_dir and args.zip:
        parser.error("--source-dir and --zip are mutually exclusive")

    size_limit = args.size_limit * 1024 if args.size_limit else None

    print(f"Pack ID:     {args.pack_id}")
    print(f"Pack name:   {args.pack_name}")
    print(f"Platform:    {args.platform}")
    if args.merge:
        print("Mode:        merge (preserving other packs in existing manifest)")

    if args.source_dir:
        # Direct directory mode — used in CI where export output is on disk
        source_dir = args.source_dir
        print(f"Source dir:  {source_dir}")
        print(f"Output dir:  {args.out}")
        if size_limit:
            print(f"Size limit:  {args.size_limit} KB per shard")
        else:
            print("Size limit:  none (all shards included)")

        bundled, skipped = copy_shards_from_dir(source_dir, args.out, size_limit, args.pack_id)
        source_label = os.path.basename(os.path.abspath(source_dir))
    else:
        # Zip mode — original behaviour
        inventory_dir = os.path.join(REPO_ROOT, "inventory")
        zip_path = args.zip or find_sharded_zip(inventory_dir)
        print(f"Source zip:  {zip_path}")
        print(f"Output dir:  {args.out}")
        if size_limit:
            print(f"Size limit:  {args.size_limit} KB per shard")
        else:
            print("Size limit:  none (all shards included)")

        bundled, skipped = extract_shards(zip_path, args.out, size_limit, args.pack_id)
        source_label = os.path.basename(zip_path)

    print(f"\n  ✅ Bundled {len(bundled)} shards")
    if skipped:
        print(f"  ⏭️  Skipped {len(skipped)} shards (too large or errored)")

    write_manifest(
        out_dir=args.out,
        bundled=bundled,
        skipped=skipped,
        source_label=source_label,
        pack_id=args.pack_id,
        pack_name=args.pack_name,
        platform=args.platform,
        pack_description=args.pack_description,
        merge=args.merge,
    )
    print("\nDone.")


if __name__ == "__main__":
    main()

