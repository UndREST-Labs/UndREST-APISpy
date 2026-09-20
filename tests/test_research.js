"use strict";

const { URL } = require("url");
if (typeof global.URL === "undefined") global.URL = URL;

const normExports = {};
eval(require("fs").readFileSync(__dirname + "/../extension/lib/normalizer.js", "utf8")
  .replace('typeof window !== "undefined" ? window : exports', 'normExports'));
const { Normalizer } = normExports;

const researchExports = {};
eval(require("fs").readFileSync(__dirname + "/../extension/lib/research.js", "utf8")
  .replace('typeof window !== "undefined" ? window : exports', 'researchExports'));
const { Research } = researchExports;

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

function b64url(value) {
  return Buffer.from(value).toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function makeJwt(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = b64url(JSON.stringify(header));
  const encodedPayload = b64url(JSON.stringify(payload));
  return encodedHeader + "." + encodedPayload + ".signature";
}

console.log("\n=== Research sanitisation and JWT extraction ===");
{
  const token = makeJwt({
    aud: "api://test-api",
    tid: "tenant-123",
    appid: "app-123",
    roles: ["User.Read"],
    scp: "User.Read",
    iss: "https://login.microsoftonline.com/tenant-123/v2.0",
    azp: "client-456",
  });
  const metadata = Research.extractJwtMetadata("Bearer " + token);
  assert(metadata !== null, "JWT metadata extracted");
  eq(metadata.audience, "api://test-api", "JWT audience captured");
  eq(metadata.tenantId, "tenant-123", "tenant ID captured");
  eq(metadata.appId, "app-123", "app ID captured");
  eq(metadata.issuer, "https://login.microsoftonline.com/tenant-123/v2.0", "issuer captured");
  assert(Array.isArray(metadata.roles) && metadata.roles.includes("User.Read"), "roles captured");
}

console.log("\n=== Research sanitisation ===");
{
  const norm = Normalizer.normalise(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/providers/Microsoft.Storage/storageAccounts/myacct?api-version=2024-99-99&token=abc123&sig=secret&x-ms-api-key=key1",
    "GET"
  );
  const headers = {
    Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJhcGk6Ly90ZXN0LWFwaSJ9.signature",
    Cookie: "session=abc",
    "x-ms-api-key": "super-secret",
  };
  const event = Research.buildResearchEvent({
    url: "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/providers/Microsoft.Storage/storageAccounts/myacct?api-version=2024-99-99&token=abc123&sig=secret&x-ms-api-key=key1",
    method: "GET",
    norm,
    headers,
    result: {
      status: "route_match_version_mismatch",
      provider_namespace: "Microsoft.Storage",
      matched_route_key: "GET /subscriptions/{subscriptionId}/providers/Microsoft.Storage/storageAccounts/{name}",
      matched_versions: ["2023-01-01"],
      shard_name: "Microsoft.Storage.min.json",
    },
  });

  assert(event.requestHeaders.authorization === Research.REDACTED, "Authorization header redacted");
  eq(event.query.token, "[REDACTED]", "token query param redacted");
  eq(event.query.sig, "[REDACTED]", "sig query param redacted");
  assert(event.auth.jwtMetadata && event.auth.jwtMetadata.audience, "JWT metadata retained after redaction");
  assert(event.findings.some((f) => f.category === "api_version_mismatch"), "version mismatch finding generated");
}

console.log("\n=== Research differential hints and hypotheses ===");
{
  const norm = Normalizer.normalise(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/providers/Microsoft.SecurityInsights/incidents/abc?api-version=2024-01-01&customFlag=1",
    "GET"
  );
  const event = Research.buildResearchEvent({
    url: "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/providers/Microsoft.SecurityInsights/incidents/abc?api-version=2024-01-01&customFlag=1",
    method: "GET",
    norm,
    headers: {},
    result: {
      status: "provider_known_route_unknown",
      provider_namespace: "Microsoft.SecurityInsights",
      matched_route_key: null,
      matched_versions: [],
      shard_name: "Microsoft.SecurityInsights.min.json",
    },
  });

  assert(event.findings.some((f) => f.category === "observed_undocumented_route"), "provider-known route unknown is reported as a finding");
  const generated = Research.generateHypotheses(event);
  assert(generated.hypotheses.length > 0, "structured hypothesis generated");
  assert(generated.hypotheses[0].requires_manual_approval === true, "AI output requires manual approval");
  assert(generated.hypotheses[0].confidence, "confidence present");
  assert(generated.hypotheses[0].test_plans[0].execution === "not_supported", "test plan cannot execute");
}

console.log("\n=== Research export session ===");
{
  const norm = Normalizer.normalise(
    "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/providers/Microsoft.Storage/storageAccounts/myacct?api-version=2023-01-01",
    "GET"
  );
  const event = Research.buildResearchEvent({
    url: "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/providers/Microsoft.Storage/storageAccounts/myacct?api-version=2023-01-01",
    method: "GET",
    norm,
    headers: { Authorization: "Bearer " + makeJwt({ aud: "api://storage" }) },
    result: {
      status: "exact_match",
      provider_namespace: "Microsoft.Storage",
      matched_route_key: "GET /subscriptions/{subscriptionId}/providers/Microsoft.Storage/storageAccounts/{name}",
      matched_versions: ["2023-01-01"],
      shard_name: "Microsoft.Storage.min.json",
    },
  });
  const exported = Research.exportSession("demo-session", [event]);
  assert(exported.session_metadata && exported.session_metadata.session_name === "demo-session", "session metadata exported");
  assert(Array.isArray(exported.observed_operations) && exported.observed_operations.length === 1, "observed operations exported");
  assert(Array.isArray(exported.deterministic_findings), "deterministic findings exported");
  assert(exported.redaction_status.credentials_removed === true, "redaction status exported");
}

console.log("\n=== Summary ===");
console.log("pass=" + pass + " fail=" + fail);
if (fail > 0) process.exit(1);
