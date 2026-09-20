// tests/test_capture_pipeline.js — shared panel/sweep request pipeline regressions

"use strict";

const fs = require("fs");
const vm = require("vm");
const { URL } = require("url");
if (typeof global.URL === "undefined") global.URL = URL;

function loadLibrary(relativePath, exportName) {
  const target = {};
  const source = fs.readFileSync(__dirname + "/../" + relativePath, "utf8")
    .replace('typeof window !== "undefined" ? window : exports', "target");
  eval(source);
  return target[exportName];
}

global.Filters = loadLibrary("extension/lib/filters.js", "Filters");
global.Normalizer = loadLibrary("extension/lib/normalizer.js", "Normalizer");
global.Matcher = loadLibrary("extension/lib/matcher.js", "Matcher");

let manifestLoads = 0;
global.Loader = {
  async loadManifest() {
    manifestLoads++;
    return { schema_version: "2.0.0", packs: [] };
  },
  findShardEntryForRequest() {
    return null;
  },
  async loadShardEntry() {
    throw new Error("loadShardEntry should not be called without a shard");
  },
};
global.RequestPipeline = loadLibrary(
  "extension/lib/request-pipeline.js",
  "RequestPipeline"
);

const storage = {
  apispy_sweep_mode: "1",
};
global.localStorage = {
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null;
  },
  setItem(key, value) {
    storage[key] = String(value);
  },
  removeItem(key) {
    delete storage[key];
  },
};

let sweepListener = null;
global.chrome = {
  devtools: {
    panels: {
      create(_title, _icon, _page, callback) {
        callback({});
      },
    },
    network: {
      onRequestFinished: {
        addListener(listener) {
          sweepListener = listener;
        },
      },
    },
  },
};

vm.runInThisContext(
  fs.readFileSync(__dirname + "/../extension/devtools.js", "utf8"),
  { filename: "extension/devtools.js" }
);

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

(async () => {
  console.log("\n=== Sweep capture — Microsoft Graph without a shard ===");
  await sweepListener({
    startedDateTime: "2026-09-20T16:00:00.000Z",
    request: {
      url: "https://graph.microsoft.com/v1.0/users/42?$select=id",
      method: "GET",
      headers: [],
    },
    response: {
      status: 200,
      headers: [],
    },
  });

  let entries = JSON.parse(storage.apispy_sweep_entries || "[]");
  assert(entries.length === 1, "sweep retains supported Graph request");
  assert(entries[0].host === "graph.microsoft.com", "sweep stores Graph host");
  assert(entries[0].normPath === "/v1.0/users/{id}", "sweep stores Graph-normalised path");
  assert(entries[0].apiVersion === "v1.0", "sweep stores Graph path version");
  assert(entries[0].result.status === Matcher.STATUS.NO_SPEC_MATCH,
    "Graph request without shard remains no_spec_match");

  console.log("\n=== Shared pipeline — ARM root survives manifest failure ===");
  manifestLoads = 0;
  Loader.loadManifest = async function () {
    manifestLoads++;
    throw new Error("simulated manifest failure");
  };

  const armUrl = "https://management.azure.com/subscriptions?api-version=2022-12-01";
  const armNorm = Normalizer.normalise(armUrl, "GET");
  const armClassified = await RequestPipeline.classifyRequest(
    armNorm,
    Filters.classifyScope(armUrl)
  );
  assert(manifestLoads === 0, "provider-less ARM root skips manifest loading");
  assert(armClassified.result.status === Matcher.STATUS.ARM_ROOT_ROUTE,
    "ARM root remains ARM_ROOT_ROUTE when manifest loading would fail");
  assert(RequestPipeline.shouldRetain(armClassified.result, armNorm),
    "ARM root remains eligible for panel and sweep retention");

  await sweepListener({
    startedDateTime: "2026-09-20T16:01:00.000Z",
    request: {
      url: armUrl,
      method: "GET",
      headers: [],
    },
    response: {
      status: 200,
      headers: [],
    },
  });
  entries = JSON.parse(storage.apispy_sweep_entries || "[]");
  assert(entries.length === 2, "sweep retains ARM root while manifest loader is failing");
  assert(entries[1].result.status === Matcher.STATUS.ARM_ROOT_ROUTE,
    "sweep stores ARM root classification");

  console.log(`\nCapture pipeline: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
