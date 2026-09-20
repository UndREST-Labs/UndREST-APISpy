// tests/test_filters.js — unit tests for lib/filters.js

"use strict";

// Polyfill window.URL (provided by Node.js ≥ 10 via global URL)
const { URL } = require("url");
if (typeof global.URL === "undefined") global.URL = URL;

// Load the module (it targets `window` in browser, exports in Node.js)
const mockExports = {};
eval(require("fs").readFileSync(__dirname + "/../extension/lib/filters.js", "utf8")
  .replace('typeof window !== "undefined" ? window : exports', 'mockExports'));
const { Filters } = mockExports;

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

console.log("\n=== Filters.isInScopeHost ===");
assert(Filters.isInScopeHost("management.azure.com"),       "exact: management.azure.com");
assert(Filters.isInScopeHost("MANAGEMENT.AZURE.COM"),       "case-insensitive exact");
assert(Filters.isInScopeHost("graph.microsoft.com"),        "exact: graph.microsoft.com");
assert(!Filters.isInScopeHost("api.graph.microsoft.com"),   "Graph lookalike subdomain rejected");
assert(!Filters.isInScopeHost("graph.microsoft.com.example.org"), "Graph suffix lookalike rejected");
assert(!Filters.isInScopeHost("arbitrary.microsoft.com"),   "arbitrary microsoft.com host rejected");
assert(!Filters.isInScopeHost("arbitrary.microsoftonline.com"), "arbitrary microsoftonline.com host rejected");
assert(Filters.isInScopeHost("storage.blob.core.windows.net"), "suffix: .windows.net");
assert(Filters.isInScopeHost("contoso.azure.com"),          "suffix: .azure.com");
assert(!Filters.isInScopeHost("example.com"),               "out-of-scope: example.com");
assert(!Filters.isInScopeHost(""),                          "out-of-scope: empty");
assert(!Filters.isInScopeHost(null),                        "out-of-scope: null");

console.log("\n=== Filters.isInScopePath ===");
assert(Filters.isInScopePath("/subscriptions/abc/resourceGroups"), "path: /subscriptions/");
assert(Filters.isInScopePath("/providers/Microsoft.Storage/accounts"), "path: /providers/Microsoft.");
assert(!Filters.isInScopePath("/favicon.ico"),              "not azure path: favicon");
assert(!Filters.isInScopePath(""),                          "not azure path: empty");

console.log("\n=== Filters.classifyScope ===");
const inScope = Filters.classifyScope("https://management.azure.com/subscriptions/abc?api-version=2023-01-01");
assert(inScope.inScope === true,         "management.azure.com → inScope=true");
assert(inScope.reason === "host_match",  "management.azure.com → reason=host_match");

const outScope = Filters.classifyScope("https://example.com/api/data");
assert(outScope.inScope === false,       "example.com → inScope=false");

const graphScope = Filters.classifyScope("https://graph.microsoft.com/v1.0/users");
assert(graphScope.inScope === true,      "HTTPS Microsoft Graph request is in scope");
assert(graphScope.reason === "host_match", "HTTPS Microsoft Graph uses exact host match");

const graphHttp = Filters.classifyScope("http://graph.microsoft.com/v1.0/users");
assert(graphHttp.inScope === false,      "HTTP Microsoft Graph request is out of scope");
assert(graphHttp.reason === "unsupported_graph_origin", "HTTP Microsoft Graph reports unsupported origin");

const graphCustomPort = Filters.classifyScope("https://graph.microsoft.com:444/v1.0/users");
assert(graphCustomPort.inScope === false, "Microsoft Graph custom port is out of scope");
assert(graphCustomPort.reason === "unsupported_graph_origin", "Graph custom port reports unsupported origin");

const graphLookalike = Filters.classifyScope("https://api.graph.microsoft.com/v1.0/users");
assert(graphLookalike.inScope === false, "Graph lookalike host is out of scope");

const badUrl = Filters.classifyScope("not-a-url");
assert(badUrl.inScope === false,         "bad URL → inScope=false");
assert(badUrl.reason === "unparseable_url", "bad URL → reason=unparseable_url");

console.log("\n=== Filters.isBatchRequest ===");
assert(Filters.isBatchRequest("https://management.azure.com/batch?api-version=2020-06-01", "POST"),
  "ARM batch URL + POST → true");
assert(!Filters.isBatchRequest("https://management.azure.com/batch?api-version=2020-06-01", "GET"),
  "ARM batch URL + GET → false");
assert(!Filters.isBatchRequest("https://management.azure.com/subscriptions/abc", "POST"),
  "non-batch path → false");
assert(!Filters.isBatchRequest("https://example.com/batch", "POST"),
  "wrong host → false");
assert(!Filters.isBatchRequest("", "POST"),
  "empty URL → false");

// Summary
console.log(`\nFilters: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
