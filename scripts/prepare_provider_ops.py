#!/usr/bin/env python3
"""Convert provider_ops_sweep.py output into the compact indexed format
consumed by the APISpy Azure enrichment module.

Input
-----
    azure-provider-operations-<timestamp>.json
    (list of operation records produced by provider_ops_sweep.py)

Output
------
    extension/data/azure-provider-ops.json
    {
      "meta": { "generatedAt": "...", "totalRecords": N, "uniqueKeys": K },
      "byKey": {
        "microsoft.compute|virtualmachines|runcommand": { ...slim record... },
        ...
      }
    }

The key format matches azure-enrichment.js's lookup: lower-case
    "{provider}|{resourcePath}|{actionName}"

Multiple records may share the same lookup key (e.g. same operation described
by both a full resourcePath and a trimmed primaryResourceType).  When a
collision occurs the higher riskScore entry wins; equal scores keep the first.

Usage
-----
    # From the repo root (default paths):
    python scripts/prepare_provider_ops.py

    # With explicit paths:
    python scripts/prepare_provider_ops.py \\
        --input  results/azure-provider-operations-20250101T000000.json \\
        --output extension/data/azure-provider-ops.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Fields kept in the compact output record.  All others are dropped.
_KEEP_FIELDS = {
    "summaryTitle",
    "summaryWhyItMatters",
    "riskScore",
    "primaryRiskClass",
    "presentationSeverity",
    "capabilityTags",
    "riskTags",
    "isControlPlaneBridge",
    # Keep these so azure-enrichment.js can use them for secondary lookups.
    "primaryResourceType",
    "suffixKind",
    "candidateMethod",
}


def _slim(record: dict) -> dict:
    """Return a slimmed copy of *record* containing only _KEEP_FIELDS."""
    out: dict = {}
    for field in _KEEP_FIELDS:
        val = record.get(field)
        if val is not None:
            # Normalise sets/lists to sorted lists for JSON serialisation.
            if isinstance(val, set):
                val = sorted(val)
            out[field] = val
    return out


def _make_key(provider: str, resource_path: str, action_name: str) -> str:
    return f"{provider.lower()}|{resource_path.lower()}|{action_name.lower()}"


def build_index(records: list[dict]) -> dict[str, dict]:
    """Build a byKey index from a list of raw operation records.

    For each record we emit up to two keys:
    - provider | resourcePath  | actionName  (exact)
    - provider | primaryResourceType | actionName  (alias — may differ from resourcePath)

    When two records share a key the higher riskScore wins.
    """
    index: dict[str, dict] = {}

    def _upsert(key: str, slim_rec: dict) -> None:
        existing = index.get(key)
        if existing is None:
            index[key] = slim_rec
        else:
            # Higher risk score wins; ties keep the existing entry.
            if (slim_rec.get("riskScore") or 0) > (existing.get("riskScore") or 0):
                index[key] = slim_rec

    for rec in records:
        provider      = rec.get("provider", "")
        resource_path = rec.get("resourcePath", "")
        primary_rt    = rec.get("primaryResourceType", "")
        action_name   = rec.get("actionName", "") or rec.get("suffixKind", "")

        if not provider:
            continue

        slim = _slim(rec)

        # Key 1 — full resourcePath + actionName
        if resource_path and action_name:
            _upsert(_make_key(provider, resource_path, action_name), slim)

        # Key 2 — primaryResourceType + actionName (only if different from key 1)
        if primary_rt and action_name and primary_rt.lower() != resource_path.lower():
            _upsert(_make_key(provider, primary_rt, action_name), slim)

    return index


def main(argv: list[str] | None = None) -> int:
    repo_root = Path(__file__).parent.parent

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--input", "-i",
        metavar="FILE",
        help="Path to azure-provider-operations-<ts>.json  "
             "(default: newest matching file in cwd or results/)",
    )
    parser.add_argument(
        "--output", "-o",
        metavar="FILE",
        default=str(repo_root / "extension" / "data" / "azure-provider-ops.json"),
        help="Output path (default: extension/data/azure-provider-ops.json)",
    )
    parser.add_argument(
        "--indent", type=int, default=None,
        help="JSON indent level for output (default: compact / no indent)",
    )
    args = parser.parse_args(argv)

    # ── Resolve input file ────────────────────────────────────────────────────
    input_path: Path | None = None
    if args.input:
        input_path = Path(args.input)
    else:
        # Auto-discover: look in cwd then results/ subdirectory.
        candidates: list[Path] = []
        for search_dir in (Path.cwd(), Path.cwd() / "results", repo_root / "results"):
            candidates.extend(search_dir.glob("azure-provider-operations-*.json"))
        if not candidates:
            print(
                "ERROR: No azure-provider-operations-*.json file found.\n"
                "Run provider_ops_sweep.py first, or pass --input <path>.",
                file=sys.stderr,
            )
            return 1
        # Pick the most recently modified file.
        input_path = max(candidates, key=lambda p: p.stat().st_mtime)
        print(f"Using input: {input_path}", file=sys.stderr)

    if not input_path.is_file():
        print(f"ERROR: Input file not found: {input_path}", file=sys.stderr)
        return 1

    # ── Load records ──────────────────────────────────────────────────────────
    print(f"Loading {input_path} …", file=sys.stderr)
    with input_path.open(encoding="utf-8") as fh:
        raw = json.load(fh)

    if isinstance(raw, dict):
        # provider_ops_sweep.py wraps output as { "metadata": {...}, "records": [...] }
        records: list[dict] = raw.get("records", raw.get("operations", []))
    elif isinstance(raw, list):
        records = raw
    else:
        print("ERROR: Unexpected JSON structure; expected a list or {operations:[...]}", file=sys.stderr)
        return 1

    print(f"  {len(records):,} records loaded.", file=sys.stderr)

    # ── Build index ───────────────────────────────────────────────────────────
    by_key = build_index(records)
    print(f"  {len(by_key):,} unique lookup keys generated.", file=sys.stderr)

    # ── Write output ──────────────────────────────────────────────────────────
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "meta": {
            "generatedAt":   datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sourceFile":    input_path.name,
            "totalRecords":  len(records),
            "uniqueKeys":    len(by_key),
        },
        "byKey": by_key,
    }

    with output_path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=args.indent, ensure_ascii=False)

    print(f"Written: {output_path}  ({output_path.stat().st_size:,} bytes)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
