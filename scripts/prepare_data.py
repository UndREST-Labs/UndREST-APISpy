#!/usr/bin/env python3
"""
prepare_data.py — Populate extension/data/ from the SpecRecon inventory.

Usage
─────
  python3 apispy/scripts/prepare_data.py [--zip PATH] [--out DIR] [--size-limit KB]
  python3 apispy/scripts/prepare_data.py --source-dir inventory/ [--out DIR] [--size-limit KB]

Options
  --zip PATH        Path to the sharded inventory zip
                    (default: auto-detected from inventory/)
  --source-dir DIR  Path to the export output directory containing shards/
                    (alternative to --zip — reads .min.json files directly)
  --out DIR         Output directory for data/shards/
                    (default: extension/data/)
  --size-limit KB   Only bundle shards up to this size in KB
                    (default: no limit — all shards are included)

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

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_OUT = os.path.join(REPO_ROOT, "apispy", "extension", "data")


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


def extract_shards(zip_path: str, out_dir: str, size_limit: Optional[int]) -> Tuple[List, List]:
    """
    Extract .min.json shards from the zip into out_dir/shards/.

    Returns (bundled, skipped) — lists of dicts describing each shard.
    """
    shards_dir = os.path.join(out_dir, "shards")
    os.makedirs(shards_dir, exist_ok=True)

    bundled = []
    skipped = []

    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            name = info.filename
            if not (name.startswith("shards/") and name.endswith(".min.json")):
                continue

            basename = os.path.basename(name)

            if size_limit is not None and info.file_size > size_limit:
                skipped.append({"filename": basename, "size_bytes": info.file_size})
                continue

            # Read + parse
            raw = zf.read(name)
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError as exc:
                print(f"  ⚠️  Skipping {basename}: JSON parse error: {exc}", file=sys.stderr)
                skipped.append({"filename": basename, "size_bytes": info.file_size, "error": str(exc)})
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
                    "filename": basename,
                    "provider_namespace": provider_ns,
                    "hosts": hosts,
                    "route_count": route_count,
                    "size_bytes": info.file_size,
                }
            )

    return bundled, skipped


def copy_shards_from_dir(source_dir: str, out_dir: str, size_limit: Optional[int]) -> Tuple[List, List]:
    """
    Copy .min.json shards from source_dir/shards/ into out_dir/shards/.

    This is an alternative to extract_shards() for use in CI where the export
    output is already on disk (no zip intermediary needed).

    Returns (bundled, skipped) — lists of dicts describing each shard.
    """
    src_shards_dir = os.path.join(source_dir, "shards")
    if not os.path.isdir(src_shards_dir):
        raise FileNotFoundError(
            f"No shards/ directory found in {source_dir}. "
            "Run scripts/export/export_api_inventory.py --sharded first."
        )

    dst_shards_dir = os.path.join(out_dir, "shards")
    os.makedirs(dst_shards_dir, exist_ok=True)

    bundled = []
    skipped = []

    for filename in sorted(os.listdir(src_shards_dir)):
        if not filename.endswith(".min.json"):
            continue

        src_path = os.path.join(src_shards_dir, filename)
        file_size = os.path.getsize(src_path)

        if size_limit is not None and file_size > size_limit:
            skipped.append({"filename": filename, "size_bytes": file_size})
            continue

        # Read + parse to extract metadata
        with open(src_path, "rb") as f:
            raw = f.read()

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            print(f"  ⚠️  Skipping {filename}: JSON parse error: {exc}", file=sys.stderr)
            skipped.append({"filename": filename, "size_bytes": file_size, "error": str(exc)})
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
                "filename": filename,
                "provider_namespace": provider_ns,
                "hosts": hosts,
                "route_count": route_count,
                "size_bytes": file_size,
            }
        )

    return bundled, skipped


def write_manifest(out_dir: str, bundled: list, skipped: list, source_label: str) -> None:
    """Write data/manifest.json describing all bundled shards.

    ``source_label`` is a human-readable identifier for the source — either the
    zip filename or the source directory path.
    """
    # Try to read source metadata from any bundled shard
    source_meta: dict = {}
    if bundled:
        sample_path = os.path.join(out_dir, "shards", bundled[0]["filename"])
        try:
            with open(sample_path) as f:
                sample = json.load(f)
            source_meta = sample.get("metadata", {})
        except Exception:
            pass

    manifest = {
        "schema_version": "1.0.0",
        "description": "APISpy bundled shard manifest — generated from SpecRecon export",
        "source_zip": source_label,
        "source_metadata": {
            "generated_at":    source_meta.get("generated_at", ""),
            "source_repo":     source_meta.get("source_repo", ""),
            "source_branch":   source_meta.get("source_branch", ""),
            "source_commit":   source_meta.get("source_commit", ""),
            "tool_name":       source_meta.get("tool_name", ""),
            "schema_version":  source_meta.get("schema_version", ""),
        },
        "total_bundled_shards": len(bundled),
        "total_skipped_shards": len(skipped),
        "note_skipped": (
            "Shards that could not be parsed were omitted."
        ),
        "shards": sorted(bundled, key=lambda s: s["provider_namespace"].lower()),
        "skipped_shards": sorted(s["filename"] for s in skipped),
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
    args = parser.parse_args()

    if args.source_dir and args.zip:
        parser.error("--source-dir and --zip are mutually exclusive")

    size_limit = args.size_limit * 1024 if args.size_limit else None

    if args.source_dir:
        # Direct directory mode — used in CI where export output is on disk
        source_dir = args.source_dir
        print(f"Source dir:  {source_dir}")
        print(f"Output dir:  {args.out}")
        if size_limit:
            print(f"Size limit:  {args.size_limit} KB per shard")
        else:
            print("Size limit:  none (all shards included)")

        bundled, skipped = copy_shards_from_dir(source_dir, args.out, size_limit)
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

        bundled, skipped = extract_shards(zip_path, args.out, size_limit)
        source_label = os.path.basename(zip_path)

    print(f"\n  ✅ Bundled {len(bundled)} shards")
    if skipped:
        print(f"  ⏭️  Skipped {len(skipped)} shards (too large or errored)")

    write_manifest(args.out, bundled, skipped, source_label)
    print("\nDone.")


if __name__ == "__main__":
    main()

