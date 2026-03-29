// tests/test_loader.js — unit tests for lib/loader.js (pack-aware manifest handling)
//
// loader.js uses chrome.runtime.getURL() and fetch(), both of which are
// browser-specific.  This test file provides minimal stubs so the module can
// be evaluated in Node.js and its pure-logic functions can be exercised.

"use strict";

const { URL } = require("url");
if (typeof global.URL === "undefined") global.URL = URL;

// ── Browser API stubs ─────────────────────────────────────────────────────────

// Stub chrome.runtime.getURL so the module-level constant resolves without error.
global.chrome = {
  runtime: {
    getURL: (path) => "chrome-extension://test-id/" + path,
  },
};

// Stub localStorage so getEnabledPackIds / setEnabledPackIds can run.
const _localStorage = {};
global.localStorage = {
  getItem:    (k) => _localStorage[k] !== undefined ? _localStorage[k] : null,
  setItem:    (k, v) => { _localStorage[k] = v; },
  removeItem: (k) => { delete _localStorage[k]; },
};

// ── Load module ───────────────────────────────────────────────────────────────

// loader.js targets window in a browser context and exports in Node.js.
// We strip the chrome.runtime.getURL call from the top-level constant by
// patching it through the already-stubbed global.chrome above.
const mockExports = {};
eval(
  require("fs")
    .readFileSync(__dirname + "/../extension/lib/loader.js", "utf8")
    .replace('typeof window !== "undefined" ? window : exports', "mockExports")
);
const { Loader } = mockExports;

// ── Test helpers ──────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;

function assert(condition, label) {
  if (condition) {
    console.log("  ✅ " + label);
    pass++;
  } else {
    console.error("  ❌ FAIL: " + label);
    fail++;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const V2_MANIFEST = {
  schema_version: "2.0.0",
  description: "APISpy bundled pack manifest",
  packs: [
    {
      pack_id:              "azure-rest-api-specs",
      display_name:         "Azure REST API Specs",
      platform:             "azure",
      description:          "Azure Resource Manager API specifications.",
      source_label:         "inventory",
      source_metadata: {
        generated_at:   "2026-03-21T22:51:41Z",
        source_repo:    "Azure/azure-rest-api-specs",
        source_branch:  "main",
        source_commit:  "abc123",
        tool_name:      "SpecRecon",
        schema_version: "3.0.0",
      },
      total_bundled_shards: 2,
      total_skipped_shards: 0,
      shards: [
        { filename: "Microsoft.Storage.min.json",  provider_namespace: "Microsoft.Storage",  hosts: ["management.azure.com"], route_count: 20, size_bytes: 5000 },
        { filename: "Microsoft.KeyVault.min.json", provider_namespace: "Microsoft.KeyVault", hosts: ["management.azure.com"], route_count: 15, size_bytes: 3000 },
      ],
    },
    {
      pack_id:              "example-api",
      display_name:         "Example API",
      platform:             "other",
      description:          "Hypothetical second pack for testing.",
      source_label:         "example",
      source_metadata:      {},
      total_bundled_shards: 1,
      total_skipped_shards: 0,
      shards: [
        { filename: "example-api/Example.Service.min.json", provider_namespace: "Example.Service", hosts: ["api.example.com"], route_count: 5, size_bytes: 1000 },
      ],
    },
  ],
};

const V1_MANIFEST = {
  schema_version: "1.0.0",
  description: "APISpy bundled shard manifest — generated from SpecRecon export",
  source_zip: "inventory",
  source_metadata: {
    generated_at:   "2026-01-01T00:00:00Z",
    source_repo:    "Azure/azure-rest-api-specs",
    source_branch:  "main",
    source_commit:  "oldsha",
    tool_name:      "SpecRecon",
    schema_version: "3.0.0",
  },
  total_bundled_shards: 1,
  total_skipped_shards: 0,
  shards: [
    { filename: "Microsoft.Compute.min.json", provider_namespace: "Microsoft.Compute", hosts: ["management.azure.com"], route_count: 30, size_bytes: 8000 },
  ],
};

// ── Helper: inject a manifest directly into the loader's promise cache ────────

function _injectManifest(raw) {
  // Reset the module's cached manifest so we can inject a test fixture.
  Loader.resetCache();
  // Patch loadManifest to resolve immediately with our fixture.
  // We do this by replacing the fetch stub used by the module.
  global.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(raw),
  });
}

// ── Tests: _normaliseManifest (v1.0.0 → v2.0.0 upgrade) ─────────────────────

console.log("\n=== Loader: v1.0.0 manifest auto-upgrade ===");

(async () => {

  _injectManifest(V1_MANIFEST);
  const manifest = await Loader.loadManifest();

  assert(manifest.schema_version === "2.0.0", "v1.0.0 manifest upgraded to schema_version 2.0.0");
  assert(Array.isArray(manifest.packs),        "upgraded manifest has packs array");
  assert(manifest.packs.length === 1,          "upgraded manifest has exactly one pack");
  assert(manifest.packs[0].pack_id === "azure-rest-api-specs", "default pack_id applied");
  assert(manifest.packs[0].platform === "azure",               "default platform applied");
  assert(manifest.packs[0].shards.length === 1,                "shards preserved in upgrade");
  assert(manifest.packs[0].source_metadata.source_repo === "Azure/azure-rest-api-specs",
    "source_metadata preserved in upgrade");

  // ── Tests: listBundledPacks ─────────────────────────────────────────────────

  console.log("\n=== Loader.listBundledPacks (v1.0.0 manifest) ===");
  const packs = await Loader.listBundledPacks();
  assert(packs.length === 1,                  "listBundledPacks returns 1 pack");
  assert(packs[0].pack_id === "azure-rest-api-specs", "pack_id is azure-rest-api-specs");
  assert(packs[0].total_bundled_shards === 1, "total_bundled_shards is 1");
  assert(!("shards" in packs[0]),             "shards list is NOT included in pack summary");

  // ── Tests: listBundledProviders (v1.0.0 manifest) ──────────────────────────

  console.log("\n=== Loader.listBundledProviders (v1.0.0 manifest) ===");
  const providers = await Loader.listBundledProviders();
  assert(providers.length === 1,                     "listBundledProviders returns 1 provider");
  assert(providers[0] === "Microsoft.Compute",       "provider namespace is Microsoft.Compute");

  // ── Tests: v2.0.0 manifest ─────────────────────────────────────────────────

  console.log("\n=== Loader: v2.0.0 manifest (multi-pack) ===");
  Loader.resetCache();
  _injectManifest(V2_MANIFEST);
  const m2 = await Loader.loadManifest();
  assert(m2.schema_version === "2.0.0", "v2.0.0 manifest schema_version unchanged");
  assert(m2.packs.length === 2,         "v2.0.0 manifest retains 2 packs");

  console.log("\n=== Loader.listBundledPacks (v2.0.0 manifest) ===");
  Loader.resetCache();
  _injectManifest(V2_MANIFEST);
  const packs2 = await Loader.listBundledPacks();
  assert(packs2.length === 2,                       "listBundledPacks returns 2 packs");
  assert(packs2[0].pack_id === "azure-rest-api-specs", "first pack is azure-rest-api-specs");
  assert(packs2[1].pack_id === "example-api",          "second pack is example-api");
  assert(packs2[0].platform === "azure",               "azure pack platform is azure");
  assert(packs2[1].platform === "other",               "example pack platform is other");

  // ── Tests: listBundledProviders with all packs enabled ─────────────────────

  console.log("\n=== Loader.listBundledProviders (v2.0.0, all packs enabled) ===");
  Loader.setEnabledPackIds(null); // reset: all packs enabled
  Loader.resetCache();
  _injectManifest(V2_MANIFEST);
  const allProviders = await Loader.listBundledProviders();
  assert(allProviders.length === 3, "all 3 providers visible when all packs enabled");
  assert(allProviders.includes("Microsoft.Storage"),  "Microsoft.Storage present");
  assert(allProviders.includes("Microsoft.KeyVault"), "Microsoft.KeyVault present");
  assert(allProviders.includes("Example.Service"),    "Example.Service present");

  // ── Tests: listBundledProviders with one pack disabled ─────────────────────

  console.log("\n=== Loader.listBundledProviders (v2.0.0, example-api disabled) ===");
  Loader.setEnabledPackIds(["azure-rest-api-specs"]);
  Loader.resetCache();
  _injectManifest(V2_MANIFEST);
  const azureProviders = await Loader.listBundledProviders();
  assert(azureProviders.length === 2,                  "only 2 providers when example-api disabled");
  assert(azureProviders.includes("Microsoft.Storage"), "Microsoft.Storage still present");
  assert(!azureProviders.includes("Example.Service"),  "Example.Service not present when disabled");

  // ── Tests: findShardEntry respects enabled packs ───────────────────────────

  console.log("\n=== Loader.findShardEntry (pack filtering) ===");
  Loader.setEnabledPackIds(["azure-rest-api-specs"]);
  Loader.resetCache();
  _injectManifest(V2_MANIFEST);
  const manifest2 = await Loader.loadManifest();

  const storageMatch  = Loader.findShardEntry(manifest2, "Microsoft.Storage");
  const exampleMatch  = Loader.findShardEntry(manifest2, "Example.Service");
  assert(storageMatch !== null,                               "Microsoft.Storage found in enabled pack");
  assert(storageMatch.entry.filename === "Microsoft.Storage.min.json", "correct shard filename");
  assert(storageMatch.pack.pack_id === "azure-rest-api-specs",         "correct pack returned");
  assert(exampleMatch === null,                               "Example.Service not found when pack disabled");

  // Enable both packs and retry.
  Loader.setEnabledPackIds(null);
  Loader.resetCache();
  _injectManifest(V2_MANIFEST);
  const manifest3 = await Loader.loadManifest();
  const exampleMatch2 = Loader.findShardEntry(manifest3, "Example.Service");
  assert(exampleMatch2 !== null,                                                    "Example.Service found when all packs enabled");
  assert(exampleMatch2.entry.filename === "example-api/Example.Service.min.json",   "example-api shard has pack subdirectory in filename");

  // ── Tests: case-insensitive fallback ───────────────────────────────────────

  console.log("\n=== Loader.findShardEntry (case-insensitive fallback) ===");
  Loader.setEnabledPackIds(null);
  Loader.resetCache();
  _injectManifest(V2_MANIFEST);
  const manifest4 = await Loader.loadManifest();
  const ciMatch = Loader.findShardEntry(manifest4, "microsoft.storage");
  assert(ciMatch !== null,                                    "case-insensitive match found");
  assert(ciMatch.entry.provider_namespace === "Microsoft.Storage", "correct namespace returned");

  // ── Tests: getEnabledPackIds / setEnabledPackIds ───────────────────────────

  console.log("\n=== Loader: getEnabledPackIds / setEnabledPackIds ===");
  Loader.setEnabledPackIds(null);
  assert(Loader.getEnabledPackIds() === null,    "null returned when no preference saved");

  Loader.setEnabledPackIds(["azure-rest-api-specs", "example-api"]);
  const ids = Loader.getEnabledPackIds();
  assert(ids !== null,                           "Set returned when preference saved");
  assert(ids.has("azure-rest-api-specs"),        "azure-rest-api-specs in enabled set");
  assert(ids.has("example-api"),                 "example-api in enabled set");
  assert(!ids.has("unknown"),                    "unknown pack not in enabled set");

  Loader.setEnabledPackIds([]);
  const empty = Loader.getEnabledPackIds();
  assert(empty !== null && empty.size === 0,     "empty array persisted as empty Set");

  // Restore default (all enabled)
  Loader.setEnabledPackIds(null);

  // ── Tests: getSourceMetadata backward compat ───────────────────────────────

  console.log("\n=== Loader.getSourceMetadata (backward compat) ===");
  Loader.resetCache();
  _injectManifest(V2_MANIFEST);
  const meta = await Loader.getSourceMetadata();
  assert(meta.generated_at === "2026-03-21T22:51:41Z", "getSourceMetadata returns first pack metadata");
  assert(meta.source_repo === "Azure/azure-rest-api-specs",  "source_repo preserved");

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log(`\nLoader: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);

})().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
