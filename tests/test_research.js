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

console.log("\n=== SpecQL 3.1 documented differential metadata ===");
{
  const url = "https://management.azure.com/providers/Microsoft.Test/things?api-version=2024-01-01&expand=all&hidden=1";
  const event = Research.buildResearchEvent({
    url,
    method: "POST",
    norm: Normalizer.normalise(url, "POST"),
    headers: {},
    requestBodyText: JSON.stringify({ name: "demo", undocumentedInput: true }),
    responseStatus: 200,
    responseSchema: Research.schemaSummary(JSON.stringify({ id: "1", undocumentedOutput: "value" })),
    result: {
      status: "exact_match",
      provider_namespace: "Microsoft.Test",
      matched_route_key: "POST /providers/Microsoft.Test/things",
      matched_versions: ["2024-01-01"],
      matched_version: "2024-01-01",
      shard_name: "Microsoft.Test.min.json",
      operation_metadata: {
        plane: "management",
        auth: { status: "required", requirements: [{ oauth2: ["Things.Write"] }], schemes: [{ name: "oauth2", type: "oauth2" }] },
        parameters: { query: ["api-version", "expand"] },
        request_schemas: [{ fingerprint: "sha256:req", type: "object", top_level_fields: [{ name: "name", type: "string", required: true }] }],
        response_schemas: [{ fingerprint: "sha256:res", type: "object", top_level_fields: [{ name: "id", type: "string", required: true }], status_codes: ["200"] }],
      },
    },
  });

  eq(event.schemaVersion, "1.2.0", "research event schema bumped additively");
  eq(event.specification.documentedAuth.status, "required", "documented auth copied into event");
  assert(event.findings.some((finding) => finding.category === "undocumented_query_parameter" && finding.evidence.some((item) => item.includes("hidden"))), "undocumented query parameter compared with spec metadata");
  assert(event.findings.some((finding) => finding.category === "undocumented_request_fields"), "undocumented request field detected");
  assert(event.findings.some((finding) => finding.category === "undocumented_response_fields"), "undocumented response field detected");
}

console.log("\n=== SpecQL 3.2 session correlation metadata ===");
{
  function correlatedEvent(url, method, plane, authStatus, host, version, stability, reason, availableMethods) {
    const parsed = new URL(url);
    parsed.hostname = host;
    parsed.searchParams.set("api-version", version);
    return Research.buildResearchEvent({
      url: parsed.toString(),
      method,
      norm: Normalizer.normalise(parsed.toString(), method),
      headers: {},
      result: {
        status: reason === "http_method_not_in_spec" ? "provider_known_route_unknown" : "exact_match",
        reason: reason || "exact",
        provider_namespace: "Microsoft.Correlate",
        matched_route_key: method + " /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Correlate/widgets/{widgetName}",
        matched_versions: ["2024-01-01-preview", "2024-06-01"],
        available_methods: availableMethods || [],
        matched_version: reason ? null : version,
        operation_metadata: {
          plane,
          auth: { status: authStatus, requirements: [], schemes: [] },
          api_family: {
            family_key: "Microsoft.Correlate/widgets",
            provider_namespace: "Microsoft.Correlate",
            resource_type_path: ["widgets"],
            resource_key: "Microsoft.Correlate/widgets",
            resource_depth: 1,
          },
          version_lineage: {
            ordered_versions: [
              { api_version: "2024-01-01-preview", stability: "preview", next_version: "2024-06-01" },
              { api_version: "2024-06-01", stability: "stable", previous_version: "2024-01-01-preview" },
            ],
          },
        },
      },
    });
  }

  const base = "https://management.azure.com/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/rg/providers/Microsoft.Correlate/widgets/w1";
  const events = [
    correlatedEvent(base, "GET", "management", "required", "management.azure.com", "2024-01-01-preview", "preview"),
    correlatedEvent(base, "POST", "management", "none", "management.azure.com", "2024-06-01", "stable", "http_method_not_in_spec", ["GET"]),
    correlatedEvent(base, "GET", "data", "required", "widgets.contoso.example", "2024-06-01", "stable"),
  ];
  const correlation = Research.buildSessionCorrelation(events);
  eq(events[0].specification.apiFamily.family_key, "Microsoft.Correlate/widgets", "api_family copied into event");
  eq(events[0].specification.versionLineage.ordered_versions[0].stability, "preview", "version_lineage copied into event");
  assert(correlation.resources[0].hosts.includes("management.azure.com") && correlation.resources[0].hosts.includes("widgets.contoso.example"), "correlation groups hosts per resource");
  assert(correlation.resources[0].planes.includes("management") && correlation.resources[0].planes.includes("data"), "correlation groups planes per resource");
  assert(correlation.resources[0].methods.includes("GET") && correlation.resources[0].methods.includes("POST"), "correlation groups HTTP verbs per resource");
  assert(correlation.resources[0].api_versions.some((item) => item.api_version === "2024-01-01-preview" && item.stability === "preview"), "correlation records version stability");
  assert(correlation.families[0].auth_statuses.includes("required") && correlation.families[0].auth_statuses.includes("none"), "correlation groups auth requirements per family");
  assert(correlation.findings.some((finding) => finding.category === "same_resource_observed_on_management_and_data_planes"), "cross-plane finding generated");
  assert(correlation.findings.some((finding) => finding.category === "preview_version_used_with_stable_available"), "preview-with-stable finding generated");
  assert(correlation.findings.some((finding) => finding.category === "inconsistent_auth_requirements_across_family"), "inconsistent family auth finding generated");
  assert(correlation.findings.some((finding) => finding.category === "resource_undocumented_observed_verbs"), "undocumented observed verb finding generated");
  assert(correlation.findings.some((finding) => finding.category === "same_resource_multiple_hosts"), "same resource multiple hosts finding generated");

  const boundedEvents = [];
  for (let i = 0; i < 510; i++) {
    boundedEvents.push(correlatedEvent(base + i, "GET", "management", "required", "management.azure.com", "2024-06-01", "stable"));
  }
  const bounded = Research.buildSessionCorrelation(boundedEvents);
  assert(bounded.truncation.events === true, "correlation event truncation is explicit");

  const context = Research.buildModelContext(events);
  eq(context.schema_version, "1.2.0", "model context schema bumped additively");
  assert(context.session_correlation && context.session_correlation.findings.length > 0, "model context includes bounded session correlation");
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
  eq(exported.schema_version, "1.2.0", "session export schema bumped additively");
  assert(exported.session_metadata && exported.session_metadata.session_name === "demo-session", "session metadata exported");
  assert(Array.isArray(exported.observed_operations) && exported.observed_operations.length === 1, "observed operations exported");
  assert(exported.session_correlation && Array.isArray(exported.session_correlation.resources), "session correlation exported");
  assert(Array.isArray(exported.deterministic_findings), "deterministic findings exported");
  assert(exported.redaction_status.credentials_removed === true, "redaction status exported");
}

console.log("\n=== Research schema 1.1 compatibility ===");
{
  const legacyEvent = {
    schemaVersion: "1.1.0",
    eventId: "legacy-event",
    method: "GET",
    hostname: "management.azure.com",
    normalisedPath: "/providers/Microsoft.Legacy/things",
    provider: "Microsoft.Legacy",
    apiVersion: "2024-01-01",
    classification: { status: "exact_match", reason: "exact" },
    specification: {
      matchedRouteKey: "GET /providers/Microsoft.Legacy/things",
      documentedAuth: { status: "required", requirements: [], schemes: [] },
    },
    auth: { jwtMetadata: null },
    findings: [],
  };
  const exported = Research.exportSession("legacy-import", [legacyEvent]);
  assert(exported.observed_operations[0].schemaVersion === "1.1.0", "legacy event remains loadable without mutation");
  assert(exported.session_correlation.resources.length === 1, "legacy event can be correlated through fallback keys");
}

console.log("\n=== Summary ===");
console.log("pass=" + pass + " fail=" + fail);
if (fail > 0) process.exit(1);
