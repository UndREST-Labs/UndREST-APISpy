#!/usr/bin/env python3
"""Tests for generated API pack preparation and the bundled Graph pack."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPO_ROOT / "scripts" / "prepare_data.py"
SPEC = importlib.util.spec_from_file_location("prepare_data", SCRIPT_PATH)
prepare_data = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare_data)


class PrepareDataTests(unittest.TestCase):
    def test_find_sharded_zip_prefers_stable_release_asset(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            legacy = root / "api-index-sharded-123.zip"
            stable = root / "api-index-sharded.zip"
            legacy.touch()
            stable.touch()
            self.assertEqual(prepare_data.find_sharded_zip(str(root)), str(stable))

    def test_merge_preserves_existing_pack(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "output"
            shards = source / "shards"
            shards.mkdir(parents=True)
            output.mkdir()

            existing = {
                "schema_version": "2.0.0",
                "description": "APISpy bundled pack manifest",
                "packs": [{"pack_id": "azure-rest-api-specs", "shards": []}],
            }
            (output / "manifest.json").write_text(json.dumps(existing), encoding="utf-8")
            payload = {
                "metadata": {
                    "generated_at": "2026-09-20T17:23:57Z",
                    "source_repo": "microsoftgraph/msgraph-metadata",
                    "source_branch": "master",
                    "source_commit": "b8cbef92f6959dca8150bf3edcc650863765e529",
                    "tool_name": "SpecRecon",
                    "schema_version": "3.2.0",
                },
                "provider_namespace": "Microsoft.Graph",
                "hosts": {"graph.microsoft.com": {"routes": {"GET /v1.0/users": {}}}},
            }
            (shards / "Microsoft.Graph.min.json").write_text(json.dumps(payload), encoding="utf-8")

            bundled, skipped = prepare_data.copy_shards_from_dir(
                str(source), str(output), None, "microsoft-graph"
            )
            prepare_data.write_manifest(
                str(output), bundled, skipped, "source", "microsoft-graph",
                "Microsoft Graph", "microsoft-graph", "Graph metadata", True,
            )

            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual([pack["pack_id"] for pack in manifest["packs"]], [
                "azure-rest-api-specs", "microsoft-graph"
            ])
            self.assertEqual(
                manifest["packs"][1]["shards"][0]["filename"],
                "microsoft-graph/Microsoft.Graph.min.json",
            )

    def test_bundled_graph_pack_matches_pinned_candidate(self):
        manifest_path = REPO_ROOT / "extension" / "data" / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        graph = next(pack for pack in manifest["packs"] if pack["pack_id"] == "microsoft-graph")
        self.assertEqual(graph["source_metadata"]["source_repo"], "microsoftgraph/msgraph-metadata")
        self.assertEqual(
            graph["source_metadata"]["source_commit"],
            "b8cbef92f6959dca8150bf3edcc650863765e529",
        )
        self.assertEqual(graph["source_label"], "microsoft-graph")
        self.assertEqual(graph["total_bundled_shards"], 1)
        self.assertEqual(graph["total_skipped_shards"], 0)
        self.assertEqual(graph["shards"][0]["hosts"], ["graph.microsoft.com"])
        self.assertEqual(graph["shards"][0]["route_count"], 47451)

        shard_path = REPO_ROOT / "extension" / "data" / "shards" / graph["shards"][0]["filename"]
        self.assertEqual(shard_path.stat().st_size, graph["shards"][0]["size_bytes"])
        with shard_path.open(encoding="utf-8") as handle:
            shard = json.load(handle)

        self.assertEqual(shard["provider_namespace"], "Microsoft.Graph")
        routes = shard["hosts"]["graph.microsoft.com"]["routes"]
        self.assertEqual(len(routes), 47451)
        version_counts = {"v1.0": 0, "beta": 0}
        for route in routes.values():
            for version in route.get("versions", {}):
                if version in version_counts:
                    version_counts[version] += 1
        self.assertEqual(version_counts, {"v1.0": 17870, "beta": 29581})
        stable = routes["GET /v1.0/users"]["versions"]["v1.0"]
        self.assertIn("GET /v1.0/users/{name}", routes)
        preview = routes["GET /beta/users"]["versions"]["beta"]
        self.assertFalse(stable["is_preview"])
        self.assertTrue(preview["is_preview"])
        self.assertIn("$select", stable["parameters"]["query"])
        self.assertIn("$select", preview["parameters"]["query"])


if __name__ == "__main__":
    unittest.main()
