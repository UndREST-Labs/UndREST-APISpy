// tests/test_matcher.js — unit tests for lib/matcher.js

"use strict";

const { URL } = require("url");
if (typeof global.URL === "undefined") global.URL = URL;

// Load normalizer (matcher depends on nothing, but we use normalizer to build norm objects)
const normExports = {};
eval(require("fs").readFileSync(__dirname + "/../extension/lib/normalizer.js", "utf8")
  .replace('typeof window !== "undefined" ? window : exports', 'normExports'));
const { Normalizer } = normExports;

const matchExports = {};
eval(require("fs").readFileSync(__dirname + "/../extension/lib/matcher.js", "utf8")
  .replace('typeof window !== "undefined" ? window : exports', 'matchExports'));
const { Matcher } = matchExports;

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

function eq(a, b, label) {
  assert(a === b, label + " (got: " + JSON.stringify(a) + ", expected: " + JSON.stringify(b) + ")");
}

// ── Minimal synthetic shard fixture ──────────────────────────────────────────
//
// Route keys must match what Normalizer.normalise() actually produces.
// The normalizer replaces GUIDs → {guid} and integers → {id} but does NOT
// replace arbitrary resource names in v1.  We therefore use route paths that
// only contain GUID-shaped variable segments so the exact-lookup still works.

const MOCK_SHARD = {
  metadata: { provider_namespace: "Microsoft.FakeProvider" },
  provider_namespace: "Microsoft.FakeProvider",
  hosts: {
    "management.azure.com": {
      routes: {
        // Path uses only GUID segment → normalizer produces matching key
        "GET /subscriptions/{guid}/providers/Microsoft.FakeProvider/operations": {
          method: "GET",
          path_template: "/subscriptions/{subscriptionId}/providers/Microsoft.FakeProvider/operations",
          provider_namespace: "Microsoft.FakeProvider",
          versions: {
            "2024-01-01": { is_preview: false, spec_files: ["fake/2024-01-01/fake.json"] },
            "2023-01-01": { is_preview: false, spec_files: ["fake/2023-01-01/fake.json"] },
          },
        },
      },
    },
  },
};

// ── Helper ────────────────────────────────────────────────────────────────────

function norm(url, method) {
  return Normalizer.normalise(url, method);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("\n=== Matcher.inferProviderNamespace ===");
eq(Matcher.inferProviderNamespace("/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/x"),
   "Microsoft.Storage", "infers Microsoft.Storage from path");
eq(Matcher.inferProviderNamespace("/providers/Microsoft.AAD/operations"),
   "Microsoft.AAD", "infers Microsoft.AAD from /providers/ root");
eq(Matcher.inferProviderNamespace("/subscriptions/abc"),
   null, "returns null when no provider segment");

console.log("\n=== Matcher.inferProviderNamespace — double-provider (extension resource) ===");
// Extension resources have two /providers/ segments; the LAST identifies the
// extension provider that owns the route spec.
eq(Matcher.inferProviderNamespace(
     "/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/myVM/providers/microsoft.insights/metrics"),
   "microsoft.insights",
   "double-provider: returns LAST provider namespace (microsoft.insights), not first (Microsoft.Compute)");
eq(Matcher.inferProviderNamespace(
     "/subscriptions/abc/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/myVault/providers/Microsoft.Authorization/roleAssignments"),
   "Microsoft.Authorization",
   "double-provider: returns Microsoft.Authorization (last), not Microsoft.KeyVault (first)");
eq(Matcher.inferProviderNamespace(
     "/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/sa/providers/Microsoft.Security/defenderForStorageSettings/mdsetting"),
   "Microsoft.Security",
   "double-provider: returns Microsoft.Security (last), not Microsoft.Storage (first)");
// Single-provider paths unchanged
eq(Matcher.inferProviderNamespace("/subscriptions/abc/providers/Microsoft.Resources/deployments/myDep"),
   "Microsoft.Resources",
   "single-provider: unchanged — still returns Microsoft.Resources");

console.log("\n=== Matcher.classify — out of scope ===");
{
  const n = norm("https://example.com/api/data", "GET");
  const r = Matcher.classify(n, null, { inScope: false });
  eq(r.status, Matcher.STATUS.OUT_OF_SCOPE, "out-of-scope status");
}

console.log("\n=== Matcher.classify — no shard / no provider inferred ===");
{
  // /subscriptions/abc has no provider namespace but IS a valid ARM root path.
  // Under the updated classification it returns arm_root_route, not no_spec_match.
  const n = norm("https://management.azure.com/subscriptions/abc", "GET");
  const r = Matcher.classify(n, null, { inScope: true });
  eq(r.status, Matcher.STATUS.ARM_ROOT_ROUTE, "arm_root_route for /subscriptions/... with no provider namespace");
}

console.log("\n=== Matcher.classify — exact match ===");
{
  // Only the subscription GUID is normalised; the rest of the path is literal.
  const n = norm(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/providers/Microsoft.FakeProvider/operations?api-version=2024-01-01",
    "GET"
  );
  const r = Matcher.classify(n, MOCK_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH, "exact_match status");
  eq(r.provider_namespace, "Microsoft.FakeProvider", "correct provider_namespace");
  eq(r.matched_version, "2024-01-01", "correct matched_version");
  assert(Array.isArray(r.matched_versions), "matched_versions is array");
}

console.log("\n=== Matcher.classify — route match, version mismatch ===");
{
  const n = norm(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/providers/Microsoft.FakeProvider/operations?api-version=2025-99-99",
    "GET"
  );
  const r = Matcher.classify(n, MOCK_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.ROUTE_MISMATCH, "route_match_version_mismatch status");
  assert(r.matched_versions.includes("2024-01-01"), "matched_versions contains known version");
}

console.log("\n=== Matcher.classify — provider known, route unknown ===");
{
  const n = norm(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/providers/Microsoft.FakeProvider/unknownResource?api-version=2024-01-01",
    "GET"
  );
  const r = Matcher.classify(n, MOCK_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.PROVIDER_KNOWN_NO_ROUTE, "provider_known_route_unknown status");
  eq(r.provider_namespace, "Microsoft.FakeProvider", "provider_namespace still reported");
}

console.log("\n=== Matcher.classify — no api-version → route_match_version_mismatch ===");
{
  const n = norm(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/providers/Microsoft.FakeProvider/operations",
    "GET"
  );
  const r = Matcher.classify(n, MOCK_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.ROUTE_MISMATCH, "missing api-version → route_mismatch");
  eq(r.reason, "no_api_version_in_request", "correct reason");
}

console.log("\n=== Matcher.classify — shard_load_failed ===");
{
  const n = norm(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/providers/Microsoft.FakeProvider/operations?api-version=2024-01-01",
    "GET"
  );
  const r = Matcher.classify(n, null, { inScope: true, shardLoadError: "HTTP 503: Service Unavailable" });
  eq(r.status, Matcher.STATUS.NO_SPEC_MATCH, "no_spec_match when shard load fails");
  eq(r.reason, "shard_load_failed", "reason=shard_load_failed");
  eq(r.error, "HTTP 503: Service Unavailable", "error message preserved");
  assert(r.provider_namespace === "Microsoft.FakeProvider", "provider_namespace inferred even on load failure");
}

console.log("\n=== Matcher.STATUS_LABELS ===");
Object.values(Matcher.STATUS).forEach((s) => {
  assert(Matcher.STATUS_LABELS[s], "label defined for status: " + s);
});

// ── ARM-templated route matching ──────────────────────────────────────────────
//
// These tests verify that the matcher uses norm.armPath (ARM-templated path)
// for route lookup, enabling requests with literal Azure resource names to
// match spec routes that use semantic placeholders like {name}.
//
// The shard below uses ARM-style placeholder keys as they appear in real
// SpecRecon shards derived from Azure REST API specs.

const ARM_MOCK_SHARD = {
  metadata: { provider_namespace: "Microsoft.KeyVault" },
  provider_namespace: "Microsoft.KeyVault",
  hosts: {
    "management.azure.com": {
      routes: {
        // KeyVault vault — spec route uses {subscriptionId}/{resourceGroupName}/{name}
        "GET /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.KeyVault/vaults/{name}": {
          method: "GET",
          path_template: "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.KeyVault/vaults/{vaultName}",
          provider_namespace: "Microsoft.KeyVault",
          versions: {
            "2023-07-01": { is_preview: false, spec_files: ["keyvault/2023-07-01/vaults.json"] },
            "2022-07-01": { is_preview: false, spec_files: ["keyvault/2022-07-01/vaults.json"] },
          },
        },
        // Storage blobServices/default — 'default' singleton preserved in spec key
        "GET /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Storage/storageAccounts/{name}/blobServices/default": {
          method: "GET",
          path_template: "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Storage/storageAccounts/{accountName}/blobServices/default",
          provider_namespace: "Microsoft.Storage",
          versions: {
            "2023-01-01": { is_preview: false, spec_files: ["storage/2023-01-01/blob.json"] },
          },
        },
        // Web app slots — two levels of resource names → {name}/{name}
        "GET /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Web/sites/{name}/slots/{name}": {
          method: "GET",
          path_template: "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Web/sites/{name}/slots/{slotName}",
          provider_namespace: "Microsoft.Web",
          versions: {
            "2023-12-01": { is_preview: false, spec_files: ["web/2023-12-01/sites.json"] },
          },
        },
      },
    },
  },
};

console.log("\n=== Matcher.classify — ARM-templated path: vault name → exact match ===");
{
  // Live request carries literal vault name "myvault".
  // Generic normaliser leaves it as-is; ARM templater replaces it with {name}.
  // The match succeeds via the ARM-templated path.
  const n = norm(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/rg-prod/providers/Microsoft.KeyVault/vaults/myvault?api-version=2023-07-01",
    "GET"
  );
  assert(n.normalisedPath.includes("myvault"),    "normalisedPath retains literal vault name");
  assert(!n.normalisedPath.includes("{name}"),    "normalisedPath does NOT have {name}");
  assert(n.armPath.includes("{name}"),            "armPath replaces vault name with {name}");
  assert(n.armPath.includes("{subscriptionId}"),  "armPath has {subscriptionId}");
  assert(n.armPath.includes("{resourceGroupName}"), "armPath has {resourceGroupName}");

  const r = Matcher.classify(n, ARM_MOCK_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH, "exact_match via ARM-templated path");
  eq(r.matched_version, "2023-07-01",      "correct api-version matched");
  eq(r.provider_namespace, "Microsoft.KeyVault", "correct provider_namespace");
}

console.log("\n=== Matcher.classify — ARM-templated path: version mismatch via ARM path ===");
{
  const n = norm(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/rg-prod/providers/Microsoft.KeyVault/vaults/myvault?api-version=2099-01-01",
    "GET"
  );
  const r = Matcher.classify(n, ARM_MOCK_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.ROUTE_MISMATCH, "route found via ARM path but version absent → mismatch");
  assert(Array.isArray(r.matched_versions) && r.matched_versions.includes("2023-07-01"),
    "matched_versions lists known versions");
}

console.log("\n=== Matcher.classify — ARM-templated path: 'default' singleton preserved ===");
{
  // blobServices/default — 'default' must remain literal (it's in allowlist)
  // so the ARM path matches the spec key which also uses 'default' literally.
  const n = norm(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/rg1/providers/Microsoft.Storage/storageAccounts/mystorage/blobServices/default?api-version=2023-01-01",
    "GET"
  );
  assert(n.armPath.includes("blobServices/default"), "armPath preserves 'default' literal");
  assert(!n.armPath.includes("blobServices/{name}"), "armPath does NOT template 'default'");

  const r = Matcher.classify(n, ARM_MOCK_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH, "exact_match with 'default' singleton preserved");
}

console.log("\n=== Matcher.classify — ARM-templated path: Web app slot → exact match ===");
{
  const n = norm(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/rg1/providers/Microsoft.Web/sites/mysite/slots/staging?api-version=2023-12-01",
    "GET"
  );
  eq(
    n.armPath,
    "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Web/sites/{name}/slots/{name}",
    "armPath templates both site name and slot name"
  );
  const r = Matcher.classify(n, ARM_MOCK_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH, "exact_match for web app slot via ARM path");
}

console.log("\n=== Matcher.classify — ARM fallback: generic normalisedPath still works ===");
{
  // MOCK_SHARD uses the old-style {guid} key — the matcher must fall back to
  // normalisedPath when armPath doesn't match, preserving backward compatibility.
  const n = norm(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/providers/Microsoft.FakeProvider/operations?api-version=2024-01-01",
    "GET"
  );
  // armPath uses {subscriptionId}, MOCK_SHARD key uses {guid} — no arm match.
  // normalisedPath uses {guid} — matches MOCK_SHARD key.
  assert(n.armPath.includes("{subscriptionId}"),  "armPath has {subscriptionId}");
  assert(n.normalisedPath.includes("{guid}"),     "normalisedPath has {guid}");

  const r = Matcher.classify(n, MOCK_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH, "exact_match via normalisedPath fallback when armPath misses");
}

// ── Normalised-placeholder fallback ──────────────────────────────────────────
//
// Real SpecRecon shard files use spec-specific parameter names such as
// {vaultName}, {secretName}, {keyName}, etc. — not the structural {name}
// placeholder emitted by the ARM normaliser.  The matcher must bridge this
// gap via a normalised-placeholder fallback that maps all {xxx} → {name}
// before comparing route keys.
//
// These tests reproduce the exact scenario shown in the GitHub issue where
// requests to known KeyVault routes were incorrectly classified as
// "Unknown route / route_not_in_shard".

const REAL_SHARD_FORMAT = {
  metadata: { provider_namespace: "Microsoft.KeyVault" },
  provider_namespace: "Microsoft.KeyVault",
  hosts: {
    "management.azure.com": {
      routes: {
        // Route key uses spec-specific {vaultName} — not the structural {name}
        "GET /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.KeyVault/vaults/{vaultName}": {
          method: "GET",
          path_template: "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.KeyVault/vaults/{vaultName}",
          provider_namespace: "Microsoft.KeyVault",
          versions: {
            "2024-11-01": { is_preview: false, spec_files: ["keyvault/2024-11-01/vaults.json"] },
            "2023-07-01": { is_preview: false, spec_files: ["keyvault/2023-07-01/vaults.json"] },
          },
        },
        // Multi-level resource names: {vaultName}/keys/{keyName}
        "GET /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.KeyVault/vaults/{vaultName}/keys/{keyName}": {
          method: "GET",
          path_template: "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.KeyVault/vaults/{vaultName}/keys/{keyName}",
          provider_namespace: "Microsoft.KeyVault",
          versions: {
            "2024-11-01": { is_preview: false, spec_files: ["keyvault/2024-11-01/keys.json"] },
          },
        },
        // Singleton 'default' preserved in spec key (blobServices/default pattern)
        "GET /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Storage/storageAccounts/{accountName}/blobServices/default": {
          method: "GET",
          path_template: "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Storage/storageAccounts/{accountName}/blobServices/default",
          provider_namespace: "Microsoft.Storage",
          versions: {
            "2023-01-01": { is_preview: false, spec_files: ["storage/2023-01-01/blob.json"] },
          },
        },
      },
    },
  },
};

console.log("\n=== Matcher.classify — normalised-placeholder fallback: real shard {vaultName} ===");
{
  // Reproduces the GitHub issue: a GET request to a real KeyVault vault URL
  // was flagged as "Unknown route / route_not_in_shard" because the shard
  // key uses {vaultName} while armPath produces {name}.
  const n = norm(
    "https://management.azure.com/subscriptions/7d8bc1a3-741d-40ab-916f-a209b0507a47/resourceGroups/SpecRecon-Demo-RG/providers/Microsoft.KeyVault/vaults/SpecRecon-Demo-KV?api-version=2024-11-01",
    "GET"
  );
  eq(
    n.armPath,
    "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.KeyVault/vaults/{name}",
    "armPath uses structural {name} (not literal vault name)"
  );

  const r = Matcher.classify(n, REAL_SHARD_FORMAT, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH,
    "exact_match via normalised-placeholder fallback (shard uses {vaultName})");
  eq(r.matched_version, "2024-11-01", "correct api-version matched");
  eq(r.provider_namespace, "Microsoft.KeyVault", "correct provider_namespace");
  // matched_route_key should be the original shard key (not the normalised form)
  eq(
    r.matched_route_key,
    "GET /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.KeyVault/vaults/{vaultName}",
    "matched_route_key is the original shard key with spec-specific param names"
  );
}

console.log("\n=== Matcher.classify — normalised-placeholder fallback: version mismatch ===");
{
  const n = norm(
    "https://management.azure.com/subscriptions/7d8bc1a3-741d-40ab-916f-a209b0507a47/resourceGroups/SpecRecon-Demo-RG/providers/Microsoft.KeyVault/vaults/SpecRecon-Demo-KV?api-version=2099-01-01",
    "GET"
  );
  const r = Matcher.classify(n, REAL_SHARD_FORMAT, { inScope: true });
  eq(r.status, Matcher.STATUS.ROUTE_MISMATCH,
    "route_mismatch when route found via normalised fallback but api-version absent");
  assert(Array.isArray(r.matched_versions) && r.matched_versions.includes("2024-11-01"),
    "matched_versions lists known versions");
}

console.log("\n=== Matcher.classify — normalised-placeholder fallback: multi-level resource names ===");
{
  // Shard key: ...vaults/{vaultName}/keys/{keyName}
  // armPath:   ...vaults/{name}/keys/{name}
  const n = norm(
    "https://management.azure.com/subscriptions/7d8bc1a3-741d-40ab-916f-a209b0507a47/resourceGroups/myRG/providers/Microsoft.KeyVault/vaults/myVault/keys/myKey?api-version=2024-11-01",
    "GET"
  );
  eq(
    n.armPath,
    "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.KeyVault/vaults/{name}/keys/{name}",
    "armPath templates both vault name and key name to {name}"
  );
  const r = Matcher.classify(n, REAL_SHARD_FORMAT, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH,
    "exact_match for multi-level resource names via normalised-placeholder fallback");
}

console.log("\n=== Matcher.classify — normalised-placeholder fallback: 'default' singleton ===");
{
  // Spec key uses {accountName} for the storage account name but 'default' literal
  // for the blobServices singleton.  Both must match correctly.
  const n = norm(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/rg1/providers/Microsoft.Storage/storageAccounts/mystorage/blobServices/default?api-version=2023-01-01",
    "GET"
  );
  assert(n.armPath.includes("blobServices/default"), "armPath preserves 'default' literal");
  const r = Matcher.classify(n, REAL_SHARD_FORMAT, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH,
    "exact_match: 'default' singleton preserved and {accountName}→{name} normalised");
}

console.log("\n=== Matcher.normalisePlaceholders ===");
eq(
  Matcher.normalisePlaceholders("/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.KeyVault/vaults/{vaultName}"),
  "/subscriptions/{name}/resourceGroups/{name}/providers/Microsoft.KeyVault/vaults/{name}",
  "all placeholders replaced with {name}"
);
eq(
  Matcher.normalisePlaceholders("/providers/Microsoft.AAD/operations"),
  "/providers/Microsoft.AAD/operations",
  "path with no placeholders unchanged"
);
eq(
  Matcher.normalisePlaceholders("GET /subscriptions/{subscriptionId}/providers/Microsoft.Foo/things/{thingName}"),
  "GET /subscriptions/{name}/providers/Microsoft.Foo/things/{name}",
  "route key string normalised correctly"
);

// ── canonicaliseRouteKey ──────────────────────────────────────────────────────
//
// Verifies that _canonicaliseRouteKey applies all three normalisations:
//   1. {xxx} placeholder → {name}
//   2. ARM keyword segments lowercased (resourceGroups → resourcegroups, etc.)
//   3. Trailing slash stripped

console.log("\n=== Matcher.canonicaliseRouteKey ===");
eq(
  Matcher.canonicaliseRouteKey(
    "GET /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Resources/deployments/"
  ),
  "GET /subscriptions/{name}/resourcegroups/{name}/providers/Microsoft.Resources/deployments",
  "canonical: placeholders + lowercase resourceGroups + trailing slash stripped"
);
eq(
  Matcher.canonicaliseRouteKey(
    "GET /subscriptions/{subscriptionId}/resourcegroups/{resourceGroupName}/providers/Microsoft.Resources/deployments/"
  ),
  "GET /subscriptions/{name}/resourcegroups/{name}/providers/Microsoft.Resources/deployments",
  "canonical: already lowercase resourcegroups, trailing slash stripped"
);
eq(
  Matcher.canonicaliseRouteKey(
    "GET /subscriptions/{name}/managementGroups/{name}/providers/Microsoft.Foo/bars/{barName}"
  ),
  "GET /subscriptions/{name}/managementgroups/{name}/providers/Microsoft.Foo/bars/{name}",
  "canonical: managementGroups lowercased, bar placeholder normalised"
);
eq(
  Matcher.canonicaliseRouteKey("GET /providers/Microsoft.AAD/operations"),
  "GET /providers/Microsoft.AAD/operations",
  "canonical: no change for already-clean key"
);

// ── Canonical-key fallback: keyword casing mismatch ──────────────────────────
//
// Reproduces the real-world scenario seen in the issue report where
// GET .../resourceGroups/.../providers/Microsoft.Resources/deployments
// was flagged as "Unknown route / route_not_in_shard" because the shard key
// used lowercase "resourcegroups" while the normaliser emits "resourceGroups".

const LOWERCASE_KEYWORD_SHARD = {
  metadata: { provider_namespace: "Microsoft.Resources" },
  provider_namespace: "Microsoft.Resources",
  hosts: {
    "management.azure.com": {
      routes: {
        // Shard key uses lowercase 'resourcegroups' and has trailing slash
        // (as generated from some azure-rest-api-specs versions)
        "GET /subscriptions/{subscriptionId}/resourcegroups/{resourceGroupName}/providers/Microsoft.Resources/deployments/": {
          method: "GET",
          path_template: "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Resources/deployments/",
          provider_namespace: "Microsoft.Resources",
          versions: {
            "2022-12-01": { is_preview: false, spec_files: ["resources/2022-12-01/deployments.json"] },
            "2024-11-01": { is_preview: false, spec_files: ["resources/2024-11-01/deployments.json"] },
          },
        },
        // Also verify camelCase version still matches (mixed shards)
        "GET /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Resources/deploymentStacks": {
          method: "GET",
          path_template: "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Resources/deploymentStacks",
          provider_namespace: "Microsoft.Resources",
          versions: {
            "2024-03-01": { is_preview: false, spec_files: ["resources/2024-03-01/deploymentStacks.json"] },
          },
        },
      },
    },
  },
};

console.log("\n=== Matcher.classify — canonical fallback: lowercase 'resourcegroups' in shard ===");
{
  // Real-world failing case from the issue report:
  // Shard key: "GET /subscriptions/{subscriptionId}/resourcegroups/{resourceGroupName}/providers/Microsoft.Resources/deployments/"
  // armPath:   "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Resources/deployments"
  // Mismatch: 'resourceGroups' vs 'resourcegroups', plus trailing slash
  const n = norm(
    "https://management.azure.com/subscriptions/7d8bc1a3-741d-40ab-916f-a209b0507a47/resourceGroups/CT-UMAMI-RG/providers/Microsoft.Resources/deployments?api-version=2022-12-01",
    "GET"
  );
  assert(n.armPath.includes("resourceGroups"),         "armPath has camelCase resourceGroups");
  assert(!n.armPath.endsWith("/"),                     "armPath has no trailing slash");

  const r = Matcher.classify(n, LOWERCASE_KEYWORD_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH,
    "exact_match despite shard using lowercase 'resourcegroups' + trailing slash");
  eq(r.matched_version, "2022-12-01", "correct api-version matched");
  eq(r.provider_namespace, "Microsoft.Resources", "correct provider_namespace");
  assert(
    r.matched_route_key ===
    "GET /subscriptions/{subscriptionId}/resourcegroups/{resourceGroupName}/providers/Microsoft.Resources/deployments/",
    "matched_route_key is the original shard key (with lowercase + trailing slash preserved)"
  );
}

console.log("\n=== Matcher.classify — canonical fallback: version mismatch with lowercase shard key ===");
{
  const n = norm(
    "https://management.azure.com/subscriptions/7d8bc1a3-741d-40ab-916f-a209b0507a47/resourceGroups/CT-UMAMI-RG/providers/Microsoft.Resources/deployments?api-version=2099-01-01",
    "GET"
  );
  const r = Matcher.classify(n, LOWERCASE_KEYWORD_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.ROUTE_MISMATCH,
    "version_mismatch when route matched via canonical fallback but api-version absent");
  assert(Array.isArray(r.matched_versions) && r.matched_versions.includes("2022-12-01"),
    "matched_versions contains known version");
}

console.log("\n=== Matcher.classify — canonical fallback: camelCase shard key still matches ===");
{
  // camelCase shard keys (the majority) continue to match after canonical normalisation
  const n = norm(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/rg1/providers/Microsoft.Resources/deploymentStacks?api-version=2024-03-01",
    "GET"
  );
  const r = Matcher.classify(n, LOWERCASE_KEYWORD_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH,
    "camelCase shard key still yields exact_match via canonical fallback");
  eq(r.matched_version, "2024-03-01", "correct api-version matched");
}

// ── {default} singleton-suffix fallback ──────────────────────────────────────
//
// Some Azure ARM specs define singleton resources as `/{resourceType}/{default}`
// where `{default}` takes the literal value "default".  Clients sometimes omit
// the trailing "/default" suffix and call the parent path directly.
//
// When no direct or canonical match is found, the matcher should try the
// request's canonical key against a "parent-path index" built from shard
// routes ending in `/{default}`.  This prevents valid singleton requests from
// being classified as "provider_known_route_unknown" (Unknown route).
//
// Real-world example (from issue report):
//   Request: GET /providers/Microsoft.Resources/dataBoundaries?api-version=2023-07-01
//   Shard:   GET /providers/Microsoft.Resources/dataBoundaries/{default}  (v: 2024-08-01)
//   Before:  🔶 provider_known_route_unknown / route_not_in_shard
//   After:   ⚠️ route_match_version_mismatch  (available: 2024-08-01)

const SINGLETON_SHARD = {
  metadata: { provider_namespace: "Microsoft.Resources" },
  provider_namespace: "Microsoft.Resources",
  hosts: {
    "management.azure.com": {
      routes: {
        // Singleton route: only one valid value for {default}, the literal "default"
        "GET /providers/Microsoft.Resources/dataBoundaries/{default}": {
          method: "GET",
          path_template: "/providers/Microsoft.Resources/dataBoundaries/{default}",
          provider_namespace: "Microsoft.Resources",
          versions: {
            "2024-08-01": { is_preview: false, spec_files: ["databoundaries/2024-08-01/dataBoundaries.json"] },
          },
        },
        "PUT /providers/Microsoft.Resources/dataBoundaries/{default}": {
          method: "PUT",
          path_template: "/providers/Microsoft.Resources/dataBoundaries/{default}",
          provider_namespace: "Microsoft.Resources",
          versions: {
            "2024-08-01": { is_preview: false, spec_files: ["databoundaries/2024-08-01/dataBoundaries.json"] },
          },
        },
        // Unrelated collection route that does NOT end in {default}
        "GET /subscriptions/{subscriptionId}/providers/Microsoft.Resources/tags": {
          method: "GET",
          path_template: "/subscriptions/{subscriptionId}/providers/Microsoft.Resources/tags",
          provider_namespace: "Microsoft.Resources",
          versions: {
            "2021-04-01": { is_preview: false, spec_files: ["tags/2021-04-01/tags.json"] },
          },
        },
      },
    },
  },
};

console.log("\n=== Matcher.classify — {default} singleton suffix: version mismatch (issue report) ===");
{
  // Real-world case: client calls without '/default' suffix, api-version not in spec
  const n = norm(
    "https://management.azure.com/providers/Microsoft.Resources/dataBoundaries?api-version=2023-07-01",
    "GET"
  );
  eq(n.normalisedPath, "/providers/Microsoft.Resources/dataBoundaries",
    "normalisedPath has no trailing {default}");

  const r = Matcher.classify(n, SINGLETON_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.ROUTE_MISMATCH,
    "route_mismatch (not unknown_route) when {default} suffix omitted and api-version not in spec");
  assert(r.matched_route_key === "GET /providers/Microsoft.Resources/dataBoundaries/{default}",
    "matched_route_key is the original shard key with {default}");
  assert(Array.isArray(r.matched_versions) && r.matched_versions.includes("2024-08-01"),
    "matched_versions includes the spec version");
  eq(r.reason, "api_version_not_in_spec", "reason=api_version_not_in_spec");
  eq(r.provider_namespace, "Microsoft.Resources", "correct provider_namespace");
}

console.log("\n=== Matcher.classify — {default} singleton suffix: exact match when api-version present ===");
{
  // Exact api-version match via singleton fallback
  const n = norm(
    "https://management.azure.com/providers/Microsoft.Resources/dataBoundaries?api-version=2024-08-01",
    "GET"
  );
  const r = Matcher.classify(n, SINGLETON_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH,
    "exact_match when {default} suffix omitted but api-version IS in spec");
  eq(r.matched_version, "2024-08-01", "correct api-version matched");
  assert(r.matched_route_key === "GET /providers/Microsoft.Resources/dataBoundaries/{default}",
    "matched_route_key is the singleton shard key");
}

console.log("\n=== Matcher.classify — {default} singleton suffix: no api-version ===");
{
  const n = norm(
    "https://management.azure.com/providers/Microsoft.Resources/dataBoundaries",
    "GET"
  );
  const r = Matcher.classify(n, SINGLETON_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.ROUTE_MISMATCH,
    "route_mismatch when {default} suffix omitted and no api-version");
  eq(r.reason, "no_api_version_in_request", "reason=no_api_version_in_request");
}

console.log("\n=== Matcher.classify — {default} singleton suffix: PUT method ===");
{
  const n = norm(
    "https://management.azure.com/providers/Microsoft.Resources/dataBoundaries?api-version=2024-08-01",
    "PUT"
  );
  const r = Matcher.classify(n, SINGLETON_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH,
    "PUT method also matches via {default} singleton suffix fallback");
}

console.log("\n=== Matcher.classify — {default} singleton suffix: non-default placeholder NOT matched ===");
{
  // A route ending in {vaultName} (NOT {default}) must NOT trigger the singleton fallback
  // and must remain provider_known_route_unknown for list requests.
  const nonDefaultShard = {
    metadata: { provider_namespace: "Microsoft.KeyVault" },
    provider_namespace: "Microsoft.KeyVault",
    hosts: {
      "management.azure.com": {
        routes: {
          "GET /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.KeyVault/vaults/{vaultName}": {
            method: "GET",
            path_template: "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.KeyVault/vaults/{vaultName}",
            provider_namespace: "Microsoft.KeyVault",
            versions: {
              "2023-07-01": { is_preview: false, spec_files: ["keyvault/2023-07-01/vaults.json"] },
            },
          },
        },
      },
    },
  };
  const n = norm(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/rg1/providers/Microsoft.KeyVault/vaults?api-version=2023-07-01",
    "GET"
  );
  // List-vaults is NOT in the shard (only single-vault is). {vaultName} ≠ {default},
  // so the singleton fallback must NOT activate and the result must still be UNKNOWN.
  const r = Matcher.classify(n, nonDefaultShard, { inScope: true });
  eq(r.status, Matcher.STATUS.PROVIDER_KNOWN_NO_ROUTE,
    "list-vaults request is NOT matched against single-vault route — {vaultName} is not a singleton");
  eq(r.reason, "route_not_in_shard",
    "reason stays route_not_in_shard when no {default} singleton key matches");
}

// ── ARM_ROOT_ROUTE status ─────────────────────────────────────────────────────
//
// Valid ARM root/tenant-scope endpoints on management.azure.com that have no
// provider namespace in the URL must receive ARM_ROOT_ROUTE rather than
// NO_SPEC_MATCH so callers can distinguish them from genuinely unrecognised
// requests.

console.log("\n=== Matcher.STATUS — ARM_ROOT_ROUTE defined ===");
assert(Matcher.STATUS.ARM_ROOT_ROUTE === "arm_root_route", "ARM_ROOT_ROUTE status value is 'arm_root_route'");
assert(typeof Matcher.STATUS_LABELS[Matcher.STATUS.ARM_ROOT_ROUTE] === "string", "ARM_ROOT_ROUTE has a label");

console.log("\n=== Matcher.isArmRootPath ===");
{
  // management.azure.com paths that start at an ARM root keyword
  const mkNorm = (pathname) => ({ host: "management.azure.com", pathname });
  assert(Matcher.isArmRootPath(mkNorm("/subscriptions")),       "/subscriptions is ARM root path");
  assert(Matcher.isArmRootPath(mkNorm("/tenants")),             "/tenants is ARM root path");
  assert(Matcher.isArmRootPath(mkNorm("/providers")),           "/providers is ARM root path");
  assert(Matcher.isArmRootPath(mkNorm("/managementGroups")),    "/managementGroups is ARM root path");
  assert(Matcher.isArmRootPath(mkNorm("/subscriptions/abc/providers")), "/subscriptions/.../providers is ARM root path");

  // Non-management.azure.com host — must return false
  assert(!Matcher.isArmRootPath({ host: "graph.microsoft.com", pathname: "/subscriptions" }),
    "isArmRootPath returns false for non-management.azure.com host");
  assert(!Matcher.isArmRootPath({ host: "login.microsoftonline.com", pathname: "/subscriptions" }),
    "isArmRootPath returns false for login host");

  // Path with provider namespace — not a root-only path (isArmRootPath still
  // returns true because the first segment is still 'subscriptions', which is
  // correct: the caller uses isArmRootPath only when no provider was inferred)
  assert(Matcher.isArmRootPath(mkNorm("/subscriptions/abc/providers/Microsoft.Compute/virtualMachines")),
    "isArmRootPath is first-segment only; provider inference handles the rest");
}

console.log("\n=== Matcher.classify — ARM_ROOT_ROUTE: /subscriptions ===");
{
  const n = norm("https://management.azure.com/subscriptions?api-version=2022-12-01", "GET");
  const r = Matcher.classify(n, null, { inScope: true });
  eq(r.status, Matcher.STATUS.ARM_ROOT_ROUTE, "/subscriptions → arm_root_route");
  eq(r.reason, "arm_root_no_provider", "reason=arm_root_no_provider");
}

console.log("\n=== Matcher.classify — ARM_ROOT_ROUTE: /tenants ===");
{
  const n = norm("https://management.azure.com/tenants?api-version=2022-12-01", "GET");
  const r = Matcher.classify(n, null, { inScope: true });
  eq(r.status, Matcher.STATUS.ARM_ROOT_ROUTE, "/tenants → arm_root_route");
}

console.log("\n=== Matcher.classify — ARM_ROOT_ROUTE: /providers (no namespace) ===");
{
  const n = norm("https://management.azure.com/providers?api-version=2022-12-01", "GET");
  const r = Matcher.classify(n, null, { inScope: true });
  eq(r.status, Matcher.STATUS.ARM_ROOT_ROUTE, "/providers without namespace → arm_root_route");
}

console.log("\n=== Matcher.classify — ARM_ROOT_ROUTE: /subscriptions/{id}/providers ===");
{
  const n = norm(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/providers?api-version=2022-12-01",
    "GET"
  );
  // inferProviderNamespace returns null (/providers has no {namespace} after it)
  const r = Matcher.classify(n, null, { inScope: true });
  eq(r.status, Matcher.STATUS.ARM_ROOT_ROUTE, "/subscriptions/{id}/providers → arm_root_route");
}

console.log("\n=== Matcher.classify — NO_SPEC_MATCH still returned for non-ARM root paths ===");
{
  // Non-management host with path starting at 'subscriptions' — not ARM root
  const n = norm("https://api.example.com/subscriptions?api-version=2022-12-01", "GET");
  const r = Matcher.classify(n, null, { inScope: true });
  eq(r.status, Matcher.STATUS.NO_SPEC_MATCH, "non-management host: still no_spec_match (not arm_root_route)");
}

// ── HTTP method not-in-spec fallback ─────────────────────────────────────────
//
// Browsers and load-balancers automatically issue `OPTIONS` (CORS preflight)
// and sometimes `HEAD` requests to paths that the spec defines only for other
// methods (GET, POST, PUT, DELETE, PATCH).  Previously these fell through to
// `reason: "route_not_in_shard"` — indistinguishable from a genuinely unknown
// path.  After the fix the matcher reports `reason: "http_method_not_in_spec"`
// and includes the spec-defined methods so callers can present a more
// accurate diagnosis.
//
// Real-world example from the issue report:
//   OPTIONS /providers/Microsoft.Management/getEntities  (CORS preflight)
//   Shard only has: POST /providers/Microsoft.Management/getEntities
//   Before: 🔶 Unknown route / route_not_in_shard
//   After:  🔶 Unknown route / http_method_not_in_spec (available: POST)

const METHOD_SHARD = {
  metadata: { provider_namespace: "Microsoft.Management" },
  provider_namespace: "Microsoft.Management",
  hosts: {
    "management.azure.com": {
      routes: {
        "POST /providers/Microsoft.Management/getEntities": {
          method: "POST",
          path_template: "/providers/Microsoft.Management/getEntities",
          provider_namespace: "Microsoft.Management",
          versions: {
            "2020-02-01": { is_preview: false, spec_files: ["management/2020-02-01/management.json"] },
            "2019-11-01": { is_preview: false, spec_files: ["management/2019-11-01/management.json"] },
          },
        },
        "GET /providers/Microsoft.Management/managementGroups/{name}": {
          method: "GET",
          path_template: "/providers/Microsoft.Management/managementGroups/{managementGroupId}",
          provider_namespace: "Microsoft.Management",
          versions: {
            "2020-05-01": { is_preview: false, spec_files: ["management/2020-05-01/management.json"] },
          },
        },
        "PATCH /providers/Microsoft.Management/managementGroups/{name}": {
          method: "PATCH",
          path_template: "/providers/Microsoft.Management/managementGroups/{managementGroupId}",
          provider_namespace: "Microsoft.Management",
          versions: {
            "2020-05-01": { is_preview: false, spec_files: ["management/2020-05-01/management.json"] },
          },
        },
        "DELETE /providers/Microsoft.Management/managementGroups/{name}": {
          method: "DELETE",
          path_template: "/providers/Microsoft.Management/managementGroups/{managementGroupId}",
          provider_namespace: "Microsoft.Management",
          versions: {
            "2020-05-01": { is_preview: false, spec_files: ["management/2020-05-01/management.json"] },
          },
        },
      },
    },
  },
};

console.log("\n=== Matcher.classify — http_method_not_in_spec: OPTIONS to POST-only path (issue report) ===");
{
  // CORS preflight to a POST-only endpoint — the path IS known, the method is not
  const n = norm(
    "https://management.azure.com/providers/Microsoft.Management/getEntities?api-version=2020-02-01",
    "OPTIONS"
  );
  const r = Matcher.classify(n, METHOD_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.PROVIDER_KNOWN_NO_ROUTE,
    "OPTIONS to POST-only path → PROVIDER_KNOWN_NO_ROUTE (not a genuinely unknown route)");
  eq(r.reason, "http_method_not_in_spec",
    "reason=http_method_not_in_spec (not route_not_in_shard)");
  assert(Array.isArray(r.available_methods) && r.available_methods.includes("POST"),
    "available_methods includes POST");
  assert(!r.available_methods.includes("OPTIONS"),
    "OPTIONS is not listed in available_methods (it is not in the spec)");
  eq(r.provider_namespace, "Microsoft.Management", "provider_namespace correct");
}

console.log("\n=== Matcher.classify — http_method_not_in_spec: HEAD to GET-only path ===");
{
  // HEAD is a common HTTP method that proxies/health-checks issue, but specs rarely define it
  const n = norm(
    "https://management.azure.com/providers/Microsoft.Management/getEntities?api-version=2020-02-01",
    "HEAD"
  );
  const r = Matcher.classify(n, METHOD_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.PROVIDER_KNOWN_NO_ROUTE,
    "HEAD to POST-only path → PROVIDER_KNOWN_NO_ROUTE");
  eq(r.reason, "http_method_not_in_spec",
    "reason=http_method_not_in_spec for HEAD");
  assert(Array.isArray(r.available_methods), "available_methods is an array");
}

console.log("\n=== Matcher.classify — http_method_not_in_spec: OPTIONS to multi-method path ===");
{
  // Path has GET, PATCH, DELETE — OPTIONS is still not in spec
  const n = norm(
    "https://management.azure.com/providers/Microsoft.Management/managementGroups/mg1",
    "OPTIONS"
  );
  const r = Matcher.classify(n, METHOD_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.PROVIDER_KNOWN_NO_ROUTE,
    "OPTIONS to multi-method path → PROVIDER_KNOWN_NO_ROUTE");
  eq(r.reason, "http_method_not_in_spec",
    "reason=http_method_not_in_spec for OPTIONS on multi-method path");
  assert(r.available_methods.includes("GET"),    "available_methods includes GET");
  assert(r.available_methods.includes("PATCH"),  "available_methods includes PATCH");
  assert(r.available_methods.includes("DELETE"), "available_methods includes DELETE");
  assert(!r.available_methods.includes("OPTIONS"), "available_methods does NOT include OPTIONS");
}

console.log("\n=== Matcher.classify — http_method_not_in_spec: OPTIONS to unknown path stays route_not_in_shard ===");
{
  // A genuinely unknown path must NOT benefit from the method-not-in-spec fallback
  const n = norm(
    "https://management.azure.com/providers/Microsoft.Management/doesNotExist?api-version=2020-02-01",
    "OPTIONS"
  );
  const r = Matcher.classify(n, METHOD_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.PROVIDER_KNOWN_NO_ROUTE,
    "OPTIONS to completely unknown path → still PROVIDER_KNOWN_NO_ROUTE");
  eq(r.reason, "route_not_in_shard",
    "reason stays route_not_in_shard for a genuinely unknown path");
  assert(r.available_methods === null,
    "available_methods is null for unknown path");
}

console.log("\n=== Matcher.classify — http_method_not_in_spec: POST to known path stays normal ===");
{
  // A normal POST request to a known path should NOT be affected by the new fallback
  const n = norm(
    "https://management.azure.com/providers/Microsoft.Management/getEntities?api-version=2020-02-01",
    "POST"
  );
  const r = Matcher.classify(n, METHOD_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH,
    "POST to POST-only path → exact_match (not affected by method fallback)");
  eq(r.matched_version, "2020-02-01", "correct api-version matched");
}



// ── Scope-based suffix fallback ───────────────────────────────────────────────
//
// Azure ARM specs frequently define routes with a variable-length scope
// placeholder (`{scope}`, `{resourceUri}`, `{resourceScope}`, …) as the first
// path segment:
//
//   GET /{scope}/providers/Microsoft.Resources/deployments/{name}
//
// The ARM normaliser always emits the full concrete scope prefix, which never
// matches the /{scope}/providers/… shard key directly.  The scope-based suffix
// index bridges this gap by matching on the /providers/Namespace/rest suffix.
//
// Real-world example from the issue report (CSV):
//   GET .../subscriptions/{subId}/providers/Microsoft.Resources/deployments
//   Shard only has: GET /{scope}/providers/Microsoft.Resources/deployments/
//   Before: 🔶 Unknown route / route_not_in_shard
//   After:  ✅ exact_match  (or ⚠️ route_match_version_mismatch)

const SCOPE_SHARD = {
  metadata: { provider_namespace: "Microsoft.Resources" },
  provider_namespace: "Microsoft.Resources",
  hosts: {
    "management.azure.com": {
      routes: {
        // Trailing-slash list route (common shard format quirk)
        "GET /{scope}/providers/Microsoft.Resources/deployments/": {
          method: "GET",
          path_template: "/{scope}/providers/Microsoft.Resources/deployments",
          provider_namespace: "Microsoft.Resources",
          versions: {
            "2024-11-01": { is_preview: false },
            "2020-08-01": { is_preview: false },
          },
        },
        "GET /{scope}/providers/Microsoft.Resources/deployments/{deploymentName}": {
          method: "GET",
          path_template: "/{scope}/providers/Microsoft.Resources/deployments/{deploymentName}",
          provider_namespace: "Microsoft.Resources",
          versions: {
            "2024-11-01": { is_preview: false },
            "2022-09-01": { is_preview: false },
          },
        },
        "DELETE /{scope}/providers/Microsoft.Resources/deployments/{deploymentName}": {
          method: "DELETE",
          path_template: "/{scope}/providers/Microsoft.Resources/deployments/{deploymentName}",
          provider_namespace: "Microsoft.Resources",
          versions: {
            "2024-11-01": { is_preview: false },
          },
        },
        "PATCH /{scope}/providers/Microsoft.Resources/tags/default": {
          method: "PATCH",
          path_template: "/{scope}/providers/Microsoft.Resources/tags/default",
          provider_namespace: "Microsoft.Resources",
          versions: {
            "2024-11-01": { is_preview: false },
          },
        },
      },
    },
  },
};

console.log("\n=== Matcher.classify — scope-based suffix: subscription-scope list (exact version) ===");
{
  // GET /subscriptions/{subId}/providers/Microsoft.Resources/deployments
  // Shard: GET /{scope}/providers/Microsoft.Resources/deployments/ (trailing slash)
  const n = norm(
    "https://management.azure.com/subscriptions/7d8bc1a3-741d-40ab-916f-a209b0507a47/providers/Microsoft.Resources/deployments?api-version=2024-11-01",
    "GET"
  );
  const r = Matcher.classify(n, SCOPE_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH,
    "subscription-scope list → exact_match via scope-based index");
  eq(r.matched_version, "2024-11-01", "correct api-version matched");
  eq(r.provider_namespace, "Microsoft.Resources", "provider_namespace correct");
}

console.log("\n=== Matcher.classify — scope-based suffix: resourceGroup-scope list (wrong version) ===");
{
  // GET /subscriptions/{subId}/resourceGroups/{rg}/providers/Microsoft.Resources/deployments
  // api-version not in spec → version mismatch (not unknown route)
  const n = norm(
    "https://management.azure.com/subscriptions/7d8bc1a3-741d-40ab-916f-a209b0507a47/resourceGroups/CT-UMAMI-RG/providers/Microsoft.Resources/deployments?api-version=2022-12-01",
    "GET"
  );
  const r = Matcher.classify(n, SCOPE_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.ROUTE_MISMATCH,
    "rg-scope list, wrong api-version → route_match_version_mismatch (not route_not_in_shard)");
  eq(r.reason, "api_version_not_in_spec", "reason=api_version_not_in_spec");
  assert(r.matched_versions && r.matched_versions.includes("2024-11-01"),
    "matched_versions includes correct spec version");
}

console.log("\n=== Matcher.classify — scope-based suffix: named resource exact match ===");
{
  // GET /subscriptions/{subId}/providers/Microsoft.Resources/deployments/{name}
  const n = norm(
    "https://management.azure.com/subscriptions/abc123/providers/Microsoft.Resources/deployments/myDeploy?api-version=2022-09-01",
    "GET"
  );
  const r = Matcher.classify(n, SCOPE_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH,
    "sub-scope named deployment → exact_match via scope-based index");
  eq(r.matched_version, "2022-09-01", "correct api-version matched");
  // matched_route_key should be the original scope-based shard key
  assert(r.matched_route_key && r.matched_route_key.includes("{scope}"),
    "matched_route_key preserves original {scope} placeholder");
}

console.log("\n=== Matcher.classify — scope-based suffix: DELETE on scope route ===");
{
  const n = norm(
    "https://management.azure.com/subscriptions/abc123/resourceGroups/rg1/providers/Microsoft.Resources/deployments/myDeploy?api-version=2024-11-01",
    "DELETE"
  );
  const r = Matcher.classify(n, SCOPE_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH,
    "DELETE on scope route → exact_match");
}

console.log("\n=== Matcher.classify — scope-based suffix: OPTIONS → http_method_not_in_spec ===");
{
  // CORS preflight to a scope-based path — path IS known, method is not
  const n = norm(
    "https://management.azure.com/subscriptions/abc123/resourceGroups/rg1/providers/Microsoft.Resources/deployments/myDeploy",
    "OPTIONS"
  );
  const r = Matcher.classify(n, SCOPE_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.PROVIDER_KNOWN_NO_ROUTE,
    "OPTIONS to scope route → PROVIDER_KNOWN_NO_ROUTE");
  eq(r.reason, "http_method_not_in_spec",
    "reason=http_method_not_in_spec (not route_not_in_shard)");
  assert(Array.isArray(r.available_methods) && r.available_methods.includes("GET"),
    "available_methods lists GET");
  assert(r.available_methods.includes("DELETE"),
    "available_methods lists DELETE");
  assert(!r.available_methods.includes("OPTIONS"),
    "OPTIONS is NOT in available_methods");
}

console.log("\n=== Matcher.classify — scope-based suffix: tags/default via scope ===");
{
  // ARM tags operations use /{scope}/providers/Microsoft.Resources/tags/default
  const n = norm(
    "https://management.azure.com/subscriptions/abc123/resourceGroups/rg1/providers/Microsoft.Resources/tags/default?api-version=2024-11-01",
    "PATCH"
  );
  const r = Matcher.classify(n, SCOPE_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH,
    "PATCH tags/default via scope route → exact_match");
}

console.log("\n=== Matcher.classify — scope-based suffix: genuinely unknown path stays route_not_in_shard ===");
{
  // A path that has no scope-based route for it must not false-positive
  const n = norm(
    "https://management.azure.com/subscriptions/abc123/providers/Microsoft.Resources/doesNotExist?api-version=2024-11-01",
    "GET"
  );
  const r = Matcher.classify(n, SCOPE_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.PROVIDER_KNOWN_NO_ROUTE,
    "truly unknown path → still PROVIDER_KNOWN_NO_ROUTE");
  eq(r.reason, "route_not_in_shard",
    "reason stays route_not_in_shard for genuinely unknown path");
  assert(r.available_methods === null,
    "available_methods is null for genuinely unknown path");
}

// ── Double-provider (ARM extension resource) end-to-end matching ──────────────
//
// Azure ARM extension resources use double-provider paths where the second
// /providers/Namespace/ identifies the extension that owns the route spec.
// Previously:
//  1. inferProviderNamespace returned the FIRST namespace → wrong shard loaded
//  2. templateAzureArmPath replaced the second namespace with {name} → wrong key
// Now both are fixed: inferProviderNamespace returns the LAST namespace and the
// normaliser preserves the second provider namespace literal.

const EXT_SHARD = {
  metadata: { provider_namespace: "Microsoft.FakeExtension" },
  provider_namespace: "Microsoft.FakeExtension",
  hosts: {
    "management.azure.com": {
      routes: {
        "GET /{resourceUri}/providers/Microsoft.FakeExtension/metrics": {
          method: "GET",
          path_template: "/{resourceUri}/providers/Microsoft.FakeExtension/metrics",
          provider_namespace: "Microsoft.FakeExtension",
          versions: { "2024-01-01": { is_preview: false } },
        },
        "GET /{resourceUri}/providers/Microsoft.FakeExtension/diagnosticSettings/{name}": {
          method: "GET",
          path_template: "/{resourceUri}/providers/Microsoft.FakeExtension/diagnosticSettings/{settingName}",
          provider_namespace: "Microsoft.FakeExtension",
          versions: { "2024-01-01": { is_preview: false } },
        },
        "DELETE /{resourceUri}/providers/Microsoft.FakeExtension/metrics": {
          method: "DELETE",
          path_template: "/{resourceUri}/providers/Microsoft.FakeExtension/metrics",
          provider_namespace: "Microsoft.FakeExtension",
          versions: { "2024-01-01": { is_preview: false } },
        },
      },
    },
  },
};

console.log("\n=== Matcher.classify — double-provider: extension metrics on VM (exact match) ===");
{
  const n = norm(
    "https://management.azure.com/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/myVM/providers/Microsoft.FakeExtension/metrics?api-version=2024-01-01",
    "GET"
  );
  // Verify normaliser fix: second provider namespace preserved in armPath
  assert(n.armPath && n.armPath.includes("Microsoft.FakeExtension"),
    "double-provider: normaliser preserves second namespace in armPath");
  assert(n.armPath && !n.armPath.endsWith("/providers/{name}/metrics"),
    "double-provider: second namespace is NOT replaced with {name}");
  const r = Matcher.classify(n, EXT_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH,
    "double-provider: VM extension metrics → exact_match (via scope-based suffix)");
  eq(r.matched_version, "2024-01-01", "correct api-version matched");
  assert(r.matched_route_key && r.matched_route_key.includes("{resourceUri}"),
    "matched_route_key contains original {resourceUri} placeholder");
}

console.log("\n=== Matcher.classify — double-provider: extension on Storage account (wrong version) ===");
{
  const n = norm(
    "https://management.azure.com/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/mysa/providers/Microsoft.FakeExtension/metrics?api-version=2022-01-01",
    "GET"
  );
  const r = Matcher.classify(n, EXT_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.ROUTE_MISMATCH,
    "double-provider: SA extension metrics (wrong version) → route_match_version_mismatch");
  eq(r.reason, "api_version_not_in_spec", "reason=api_version_not_in_spec");
}

console.log("\n=== Matcher.classify — double-provider: extension named child resource ===");
{
  const n = norm(
    "https://management.azure.com/subscriptions/abc/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/myVault/providers/Microsoft.FakeExtension/diagnosticSettings/mySetting?api-version=2024-01-01",
    "GET"
  );
  const r = Matcher.classify(n, EXT_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH,
    "double-provider: extension named setting → exact_match");
}

console.log("\n=== Matcher.classify — double-provider: OPTIONS → http_method_not_in_spec ===");
{
  const n = norm(
    "https://management.azure.com/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/myVM/providers/Microsoft.FakeExtension/metrics",
    "OPTIONS"
  );
  const r = Matcher.classify(n, EXT_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.PROVIDER_KNOWN_NO_ROUTE,
    "double-provider OPTIONS → PROVIDER_KNOWN_NO_ROUTE");
  eq(r.reason, "http_method_not_in_spec",
    "double-provider OPTIONS → reason=http_method_not_in_spec (not route_not_in_shard)");
  assert(Array.isArray(r.available_methods) && r.available_methods.includes("GET"),
    "available_methods lists GET");
  assert(r.available_methods.includes("DELETE"),
    "available_methods lists DELETE");
}

console.log("\n=== Matcher.classify — double-provider: genuinely unknown extension path ===");
{
  const n = norm(
    "https://management.azure.com/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/myVM/providers/Microsoft.FakeExtension/unknownThing?api-version=2024-01-01",
    "GET"
  );
  const r = Matcher.classify(n, EXT_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.PROVIDER_KNOWN_NO_ROUTE,
    "double-provider genuinely unknown path → PROVIDER_KNOWN_NO_ROUTE");
  eq(r.reason, "route_not_in_shard",
    "double-provider genuinely unknown path → reason=route_not_in_shard");
}

console.log(`\nMatcher: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

// ── Tests for _normaliseNamePositions ────────────────────────────────────────

console.log("\n=== Matcher.normaliseNamePositions — basic name-position normalisation ===");
{
  // After /providers/NS/, odd positions are name-positions.
  // "logs" at pos 3 (name) should become {name}.
  eq(
    Matcher.normaliseNamePositions("GET /subscriptions/{name}/resourcegroups/{name}/providers/microsoft.web/sites/{name}/config/logs"),
    "GET /subscriptions/{name}/resourcegroups/{name}/providers/microsoft.web/sites/{name}/config/{name}",
    "logs at name position normalised to {name}"
  );
}

console.log("\n=== Matcher.normaliseNamePositions — type positions left alone ===");
{
  // Type positions (even) should remain literal.
  eq(
    Matcher.normaliseNamePositions("GET /subscriptions/{name}/providers/microsoft.storage/storageaccounts/{name}"),
    "GET /subscriptions/{name}/providers/microsoft.storage/storageaccounts/{name}",
    "type-position literal preserved, name-position {name} unchanged"
  );
}

console.log("\n=== Matcher.normaliseNamePositions — action verb at name position ===");
{
  eq(
    Matcher.normaliseNamePositions("POST /subscriptions/{name}/resourcegroups/{name}/providers/microsoft.customerinsights/hubs/{name}/images/getEntityTypeImageUploadUrl"),
    "POST /subscriptions/{name}/resourcegroups/{name}/providers/microsoft.customerinsights/hubs/{name}/images/{name}",
    "action verb at name position normalised to {name}"
  );
}

console.log("\n=== Matcher.normaliseNamePositions — double-provider handled ===");
{
  eq(
    Matcher.normaliseNamePositions("GET /subscriptions/{name}/resourcegroups/{name}/providers/{name}/sites/{name}/providers/microsoft.insights/metrics"),
    "GET /subscriptions/{name}/resourcegroups/{name}/providers/{name}/sites/{name}/providers/microsoft.insights/metrics",
    "double-provider: second provider section type-position preserved"
  );
}

console.log("\n=== Matcher.normaliseNamePositions — no provider section ===");
{
  eq(
    Matcher.normaliseNamePositions("GET /subscriptions/{name}/resourcegroups/{name}"),
    "GET /subscriptions/{name}/resourcegroups/{name}",
    "no provider section: path unchanged"
  );
}

// ── Tests for name-literal fallback in matchAgainstShard ─────────────────────

// Build a shard that has a literal at a name position (config/logs)
const NAME_LITERAL_SHARD = {
  metadata: { provider_namespace: "Microsoft.Web" },
  provider_namespace: "Microsoft.Web",
  hosts: {
    "management.azure.com": {
      routes: {
        "GET /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Web/sites/{name}/config/logs": {
          method: "GET",
          path_template: "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Web/sites/{siteName}/config/logs",
          versions: { "2023-12-01": { is_preview: false } },
        },
        "PUT /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Web/sites/{name}/config/logs": {
          method: "PUT",
          path_template: "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Web/sites/{siteName}/config/logs",
          versions: { "2023-12-01": { is_preview: false } },
        },
      },
    },
  },
};

console.log("\n=== Matcher.classify — name-literal fallback: config/logs matches ===");
{
  // The normaliser replaces "logs" at name position with {name} because
  // "logs" is not in ARM_LITERAL_SEGMENTS.  The shard has the literal.
  // The name-literal fallback index should bridge this gap.
  const n = norm(
    "https://management.azure.com/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Web/sites/mySite/config/logs?api-version=2023-12-01",
    "GET"
  );
  const r = Matcher.classify(n, NAME_LITERAL_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH,
    "name-literal fallback: config/logs → exact_match");
  eq(r.matched_version, "2023-12-01",
    "correct api-version matched via name-literal fallback");
}

console.log("\n=== Matcher.classify — name-literal fallback: PUT config/logs matches ===");
{
  const n = norm(
    "https://management.azure.com/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Web/sites/mySite/config/logs?api-version=2023-12-01",
    "PUT"
  );
  const r = Matcher.classify(n, NAME_LITERAL_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.EXACT_MATCH,
    "name-literal fallback: PUT config/logs → exact_match");
}

console.log("\n=== Matcher.classify — name-literal fallback: unknown route still not matched ===");
{
  // Use a genuinely different TYPE structure, not just a different name value
  const n = norm(
    "https://management.azure.com/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Web/sites/mySite/unknownType/someChild?api-version=2023-12-01",
    "GET"
  );
  const r = Matcher.classify(n, NAME_LITERAL_SHARD, { inScope: true });
  eq(r.status, Matcher.STATUS.PROVIDER_KNOWN_NO_ROUTE,
    "name-literal fallback: genuinely unknown route type → PROVIDER_KNOWN_NO_ROUTE");
}

console.log(`\nMatcher: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
