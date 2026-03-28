// lib/normalizer.js — request field extraction and normalisation for APISpy
// Intentionally conservative in v1: we do not aggressively guess path templates.
// Template matching heuristics should be improved in later iterations.

"use strict";

(function (exports) {

  /**
   * Known path-segment patterns that represent template parameters in
   * Azure Resource Manager URLs.  A segment is replaced with `{param}` when
   * it matches one of these rules.
   *
   * Rules are ordered from most specific to least specific.
   * Only UUID/GUID-shaped segments and numeric resource IDs are normalised
   * in v1 — we do NOT try to guess arbitrary resource names.
   */
  const TEMPLATE_RULES = [
    // GUIDs / UUIDs  (e.g. subscriptionId, tenantId)
    {
      test: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      replace: "{guid}",
    },
    // Pure numeric IDs
    {
      test: /^\d+$/,
      replace: "{id}",
    },
  ];

  // ─── Azure ARM host guard ────────────────────────────────────────────────────

  /**
   * Hostname suffixes that identify Azure/Microsoft API hosts.
   * ARM structural templating is ONLY applied when the request host matches
   * one of these suffixes (or is an exact host from ARM_EXACT_HOSTS below).
   *
   * This ensures that templateAzureArmPath() is never applied to non-Azure APIs,
   * even if those APIs happen to have path segments named "subscriptions" or
   * "tenants" — which would otherwise be incorrectly replaced with ARM
   * placeholders.
   *
   * Kept in sync conceptually with Filters.HOST_SUFFIXES / Filters.EXACT_HOSTS
   * in lib/filters.js, but defined independently here so normalizer.js remains
   * a standalone module with no cross-module dependency.
   */
  const ARM_HOST_SUFFIXES = [
    ".azure.com",
    ".microsoft.com",
    ".microsoftonline.com",
    ".windows.net",
    ".azure.net",
    ".azure-api.net",
  ];

  const ARM_EXACT_HOSTS = new Set([
    "management.azure.com",
    "graph.microsoft.com",
    "login.microsoftonline.com",
    "login.windows.net",
    "graph.windows.net",
    "api.loganalytics.io",
    "api.applicationinsights.io",
  ]);

  /**
   * Returns true only if `host` is a known Azure/Microsoft API host.
   * ARM structural path templating is gated on this check so it is never
   * applied to non-Azure APIs that APISpy may monitor in the future.
   *
   * @param {string} host  Lower-case hostname (no port).
   * @returns {boolean}
   */
  function isAzureArmHost(host) {
    if (!host) return false;
    if (ARM_EXACT_HOSTS.has(host)) return true;
    for (const suffix of ARM_HOST_SUFFIXES) {
      if (host.endsWith(suffix)) return true;
    }
    return false;
  }

  // ─── Azure ARM structural templating ────────────────────────────────────────

  /**
   * Regex that matches a valid Azure provider namespace (e.g. "Microsoft.KeyVault"
   * or "microsoft.insights").  Same character class is used in matcher.js for
   * `inferProviderNamespace` and `_canonicaliseRouteKey`.
   *
   * Format: one identifier component, a dot, then one or more dot-separated
   * identifier components, e.g. "Microsoft.ResourceHealth" or "a.b.c".
   * @private
   */
  const _ARM_PROVIDER_NS_RE = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z0-9.]+$/;

  /**
   * Allowlist of known ARM path segments that should remain literal even when
   * they appear in a structural "name" position within a resource path.
   *
   * These are typically singleton sub-resources, action verbs, or fixed
   * collection names that appear verbatim in Azure REST API spec path templates.
   * They should NOT be replaced with {name} even though they sit in what is
   * structurally a resource-name slot after a type segment.
   *
   * Populated by exhaustive analysis of all provider shard files: every segment
   * that appears at an odd (name) position in any shard route key and is not a
   * `{placeholder}` is included here.
   *
   * Based on common patterns across Azure REST API specs:
   * https://learn.microsoft.com/en-us/rest/api/azure/
   */
  const ARM_LITERAL_SEGMENTS = new Set([
    // Already established singletons / action verbs
    "default",
    "dafault",        // intentional: typo for "default" in the Microsoft.Network spec
                      // (applicationGatewayWafDynamicManifests/dafault)
    "current",        // singleton "current state" (SQL, HybridCompute, Synapse, etc.)
    "latest",         // singleton "latest version/invoice" (Billing, Compute, etc.)
    "service",        // singleton service endpoint (e.g. microsoft.insights diagnosticSettings/service)
    "listKeys",
    "listConnectionStrings",
    "regenerateKey",
    "regeneratePrimaryKey",
    "regenerateSecondaryKey",
    "start",
    "stop",
    "restart",
    "validate",
    "sync",
    "operations",
    "usages",
    "metrics",

    // DocumentDB / CosmosDB API type discriminators at name positions
    "sql",
    "mongodb",
    "cassandra",
    "gremlin",
    "table",
    "throughput",     // settings/throughput sub-resource

    // Azure Web Apps config sub-resource names
    "web",
    "appsettings",
    "authsettings",
    "authsettingsV2",
    "azurestorageaccounts",
    "backup",
    "configreferences",
    "connectionstrings",
    "customdnssuffix",
    "ftp",
    "functionappsettings",
    "metadata",
    "publishingcredentials",
    "pushsettings",
    "scm",
    "slotConfigNames",
    "virtualNetwork",
    "virtualNetworks",
    "virtualip",
    "networking",
    "onedeploy",
    "zip",
    "MSDeploy",

    // Action verb paths
    "reset",
    "disable",
    "discover",
    "cancel",
    "publish",
    "refresh",
    "export",
    "download",
    "search",
    "undoEdit",
    "generateUri",
    "listSecrets",
    "listV2",
    "getStatus",
    "modify",
    "getEntityTypeImageUploadUrl",   // CustomerInsights image upload action
    "getDataImageUploadUrl",         // CustomerInsights image upload action

    // RecoveryServices / Backup singleton config names
    "vaultstorageconfig",
    "vaultconfig",
    "vaultExtendedInfo",
    "backupResourceEncryptionConfig",

    // Singleton sub-resource config singletons across multiple providers
    "management",
    "activeDirectory",
    "global",
    "main",
    "access",
    "configuration",
    "delegation",
    "policy",
    "status",
    "admin",
    "compute",
    "limit",
    "json",
    "item",
    "content",
    "network",
    "domain",

    // Azure Monitor / Insights singleton agent configs
    "azureMonitor",
    "azureMonitorAgent",
    "clustermonitoring",
    "serviceMap",

    // Automation / Logic Apps singleton resources
    "testJob",
    "runtime",
    "workflow",
    "startOperation",
    "operationresults",
    "operationstatuses",
    "operationResults",
    "azureasyncoperations",

    // Compute image / extension singletons
    "vmimage",
    "vmextension",
    "VMExtension",
    "platformImage",
    "diskInspection",

    // Authn / RBAC portals
    "signin",
    "signup",

    // API Management analytics sub-resources
    "byApi",
    "byUser",
    "byOperation",
    "byProduct",
    "byGeo",
    "bySubscription",
    "byTime",
    "byRequest",

    // Miscellaneous singletons seen in one or more providers
    "checkNameAvailability",
    "CheckNameAvailability",
    "premiumCheck",
    "riskyIp",
    "alertfeedback",
    "badpassword",
    "alerts",
    "balanceSummary",
    "aggregatedcost",
    "aggregatedCost",
    "canonical",
    "counts",
    "DevOps",
    "flexibleServers",
    "hostName",
    "ip",
    "list",
    "locations",
    "machines",
    "maxMonthlyVirtualUserHours",
    "osType",
    "clusterVersions",
    "password",
    "revisionsApi",
    "rootApi",
    "routes",
    "skus",
    "spot",
    "spotPlacementRecommender",
    "user",
    "vmAttributeBased",
    "apiAccess",

    // OData metadata endpoint
    "$metadata",
  ]);

  /**
   * Maps ARM scope-level segment keywords to the semantic placeholder to use
   * for the value segment immediately following each keyword.
   *
   * Keys are intentionally all-lowercase so the lookup in templateAzureArmPath
   * can use `seg.toLowerCase()` — making it robust to shard files and client
   * requests that use inconsistent casing such as `/Subscriptions/` (capital S)
   * in older Microsoft.RecoveryServices specs.
   *
   * Based on Azure ARM resource ID scope conventions:
   * https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/template-functions-scope
   * https://learn.microsoft.com/en-us/azure/azure-resource-manager/troubleshooting/error-invalid-name-segments
   */
  const ARM_SCOPE_RULES = Object.freeze({
    subscriptions:    "{subscriptionId}",
    resourcegroups:   "{resourceGroupName}",
    tenants:          "{tenantId}",
    locations:        "{location}",
    managementgroups: "{managementGroupId}",
  });

  /**
   * Returns true if `seg` is a known literal ARM segment that should remain
   * unchanged even when it appears in a structural name position.
   *
   * @param {string} seg
   * @returns {boolean}
   */
  function isLiteralArmSegment(seg) {
    return ARM_LITERAL_SEGMENTS.has(seg);
  }

  /**
   * First-segment keywords that unambiguously identify a path as an Azure ARM
   * resource identifier.  Used by looksLikeArmPath() to distinguish real ARM
   * paths from non-ARM paths on Azure/Microsoft hosts.
   *
   * For example, Microsoft Graph paths like /v1.0/subscriptions/{id}
   * (webhook subscriptions) start with "v1.0", not "subscriptions", so they
   * are correctly excluded.  Azure Resource Manager paths always start with
   * one of these keywords at the first segment position.
   *
   * All values are lower-cased; looksLikeArmPath() compares with .toLowerCase()
   * so that paths using `Subscriptions` (capital S, used in some older
   * Microsoft.RecoveryServices spec generations) are still recognised.
   */
  const ARM_ROOT_SEGMENTS = new Set([
    "subscriptions",
    "tenants",
    "providers",
    "managementgroups",
  ]);

  /**
   * Returns true if `path` looks like an Azure ARM resource identifier — i.e.,
   * its first non-empty segment is a known ARM root keyword.
   *
   * This is the second gate for ARM scope templating (the first being
   * isAzureArmHost()).  Even on known Azure/Microsoft hosts, paths that do not
   * start at an ARM root segment must NOT have scope rules applied.  The
   * canonical example is Microsoft Graph webhook subscriptions:
   *
   *   /v1.0/subscriptions/{id}   ← first segment is "v1.0", NOT "subscriptions"
   *
   * Without this check, the scope rule for "subscriptions" would fire in the
   * wrong path position and produce an incorrect {subscriptionId} substitution.
   *
   * @param {string} path  Normalised path (already through normalisePath()).
   * @returns {boolean}
   */
  function looksLikeArmPath(path) {
    // paths always start with "/" so split gives ["", firstSeg, ...]
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      if (segments[i] !== "") {
        return ARM_ROOT_SEGMENTS.has(segments[i].toLowerCase());
      }
    }
    return false;
  }

  /**
   * Apply Azure ARM structural templating to a path that has already been
   * through normalisePath().
   *
   * This is NOT fuzzy matching.  It only substitutes segments in structurally
   * justified positions defined by the ARM resource ID grammar:
   *
   *   /subscriptions/{subscriptionId}
   *   /resourceGroups/{resourceGroupName}
   *   /tenants/{tenantId}
   *   /locations/{location}
   *   /managementGroups/{managementGroupId}
   *   /providers/{Namespace}/{type}/{name}/{childType}/{childName}/...
   *
   * Scope keywords (subscriptions, resourceGroups, etc.) are recognised only
   * before the /providers/ segment.  After /providers/{Namespace}, ARM paths
   * follow a strict type/name alternation:
   *   - Even positions (0, 2, 4, …) → resource type — always kept literal.
   *   - Odd positions  (1, 3, 5, …) → resource name  — replaced with {name}
   *     unless the segment is already a placeholder (starts with "{") or
   *     appears in the ARM_LITERAL_SEGMENTS allowlist.
   *
   * This reduces false "provider_known_route_unknown" results caused by literal
   * Azure resource names (vault names, site names, storage account names, etc.)
   * that would never appear literally in spec path templates.
   *
   * @param {string} normalisedPath  Output of normalisePath() — generic
   *   normalization (GUID/integer replacement) has already been applied.
   * @returns {string}  ARM-templated path, or the input unchanged if no
   *   structural rules apply.
   */
  function templateAzureArmPath(normalisedPath) {
    const segments = normalisedPath.split("/");
    const result = [];
    let i = 0;
    // resourcePosition counts segments within the provider resource path:
    // even = resource type (keep literal), odd = resource name (template).
    let inProviderResourcePath = false;
    let resourcePosition = 0;

    while (i < segments.length) {
      const seg = segments[i];

      // ── Scope-level keywords (only before /providers/) ──────────────────────
      // e.g. subscriptions, resourceGroups, tenants, locations, managementGroups
      // The segment immediately after each keyword is the scope-parameter value.
      // Use toLowerCase() so paths with capital-S "Subscriptions" (used in some
      // older Microsoft.RecoveryServices spec generations) are handled correctly.
      // The original segment casing is preserved in armPath (canonicaliseRouteKey
      // normalises it anyway during matching).
      const segLower = seg.toLowerCase();
      if (!inProviderResourcePath &&
          Object.prototype.hasOwnProperty.call(ARM_SCOPE_RULES, segLower)) {
        result.push(seg); // preserve original casing in armPath output
        i++;
        if (i < segments.length) {
          // Replace the scope-value segment with the semantic placeholder,
          // regardless of its literal value (resource group names, tenant IDs,
          // etc. can be arbitrary strings that generic normalisation misses).
          result.push(ARM_SCOPE_RULES[segLower]);
          i++;
        }
        continue;
      }

      // ── /providers/{Namespace} ───────────────────────────────────────────────
      // Keep the provider namespace literal (e.g. "Microsoft.KeyVault").
      // Everything after the namespace follows the type/name alternation.
      if (!inProviderResourcePath && seg === "providers") {
        result.push(seg);
        i++;
        if (i < segments.length) {
          // Provider namespace — always keep literal, never template.
          result.push(segments[i]);
          i++;
          inProviderResourcePath = true;
          resourcePosition = 0;
        }
        continue;
      }

      // ── Provider resource path: strict type/name alternation ─────────────────
      // After /providers/{Namespace}, ARM paths alternate:
      //   type / name / childType / childName / ...
      // We only replace name positions, never type positions.
      //
      // Special case: extension resources add a second /providers/{Namespace}
      // suffix after the parent resource name position.  For example:
      //   .../virtualMachines/{vmName}/providers/microsoft.insights/metrics
      //                               ↑ a new provider prefix, NOT a name position
      // Detect this by checking whether the current segment is literally
      // "providers" and the next segment looks like a provider namespace
      // (contains a dot).  When detected, treat it as a new /providers/ entry:
      // keep both segments literal and reset the resource-position counter.
      if (inProviderResourcePath) {
        const nextSeg = segments[i + 1];
        if (
          seg === "providers" &&
          nextSeg &&
          _ARM_PROVIDER_NS_RE.test(nextSeg)
        ) {
          // New /providers/{Namespace} pair inside the resource path.
          // Keep "providers" and the namespace literal; reset position counter.
          result.push(seg);       // "providers"
          result.push(nextSeg);   // e.g. "microsoft.insights"
          i += 2;
          resourcePosition = 0;
          continue;
        }
        const isNamePosition = (resourcePosition % 2 === 1);
        if (isNamePosition && !seg.startsWith("{") && !isLiteralArmSegment(seg)) {
          // Name position: replace with conservative structural placeholder.
          result.push("{name}");
        } else {
          result.push(seg);
        }
        resourcePosition++;
        i++;
        continue;
      }

      // ── Default: keep segment unchanged ─────────────────────────────────────
      result.push(seg);
      i++;
    }

    return result.join("/");
  }

  /**
   * Attempt to identify the api-version query parameter from a parsed URL.
   * Returns null if absent.
   * @param {URL} parsed
   * @returns {string|null}
   */
  function extractApiVersion(parsed) {
    return parsed.searchParams.get("api-version") || null;
  }

  /**
   * Normalise a URL path minimally for v1.
   * - Strip trailing slash (unless root "/")
   * - Decode percent-encoding per-segment (RFC 3986 §3.3)
   * - Replace known-shape segments (GUIDs, pure integers) with placeholders
   *
   * Decoding is applied per-segment (after splitting on "/") so that
   * percent-encoded slashes (%2F) inside a segment do not corrupt the
   * path hierarchy.  RFC 3986 §3.3 requires that the path be split on
   * literal "/" before any pct-decoding is applied to individual segments.
   * Encoded slashes (%2F / %2f) are preserved as "%2F" in the output to
   * keep them distinct from real path separators.
   *
   * We do NOT attempt to match arbitrary resource-name segments to spec
   * path templates here — that is the job of templateAzureArmPath(), which
   * is applied as a second stage after this function.
   *
   * @param {string} rawPath  The raw URL pathname.
   * @returns {string}  Normalised path.
   */
  function normalisePath(rawPath) {
    // Split on "/" BEFORE decoding so that %2F inside a segment does not
    // become a path separator and corrupt the segment boundaries.
    const rawSegments = rawPath.split("/");

    // Decode each segment individually, preserving encoded slashes (%2F)
    // so they cannot corrupt segment boundaries when the path is re-joined.
    const decoded = rawSegments.map((seg) => {
      if (!seg) return seg; // fast-path empty (leading/trailing) segments
      // Temporarily replace encoded slashes before decoding, then restore them.
      // This ensures %2F never becomes a literal "/" that looks like a separator.
      const withProtectedSlashes = seg.replace(/%2[Ff]/g, "\x00");
      let result;
      try {
        result = decodeURIComponent(withProtectedSlashes);
      } catch (_) {
        result = withProtectedSlashes;
      }
      return result.replace(/\x00/g, "%2F");
    });

    // Strip trailing empty segment produced by a trailing slash (e.g. "/a/b/"
    // splits to ["", "a", "b", ""] — drop the trailing "" but only when the
    // path is not the root "/").
    if (decoded.length > 2 && decoded[decoded.length - 1] === "") {
      decoded.pop();
    }

    // Replace known-shape segments with placeholders.
    const normalised = decoded.map((seg) => {
      for (const rule of TEMPLATE_RULES) {
        if (rule.test.test(seg)) return rule.replace;
      }
      return seg;
    });

    return normalised.join("/");
  }

  /**
   * Parse and normalise all relevant fields from a raw request URL + method.
   *
   * Normalisation is applied in two stages:
   *   1. Generic normalisation (normalisePath): replaces GUIDs and integers
   *      with {guid} and {id} — output is `normalisedPath`.
   *   2. Azure ARM structural templating (templateAzureArmPath): replaces
   *      scope-level segments (subscriptionId, resourceGroupName, etc.) and
   *      resource-name positions after /providers/{Namespace} with semantic
   *      placeholders — output is `armPath`.
   *
   * The matcher prefers `armPath` for route-key lookup to reduce false
   * "provider_known_route_unknown" results caused by literal resource names.
   * Both paths are returned so the UI/debug layer can display either.
   *
   * @param {string} rawUrl     Full request URL string.
   * @param {string} rawMethod  HTTP method string (may be mixed case).
   * @returns {{
   *   ok: boolean,
   *   error?: string,
   *   method: string,
   *   host: string,
   *   pathname: string,
   *   normalisedPath: string,
   *   armPath: string,
   *   apiVersion: string|null,
   *   fullUrl: string,
   * }}
   */
  function normalise(rawUrl, rawMethod) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (err) {
      return { ok: false, error: "invalid_url: " + String(err) };
    }

    const method = (rawMethod || "GET").toUpperCase().trim();
    const host   = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;
    const normalisedPath = normalisePath(pathname);
    // ARM structural templating requires BOTH conditions:
    //   1. The host is a known Azure/Microsoft API host (isAzureArmHost).
    //   2. The path starts at an ARM root segment (looksLikeArmPath).
    // Condition 2 prevents scope rules firing on Azure hosts that use
    // "subscriptions" for non-ARM purposes, e.g. Microsoft Graph webhook
    // subscriptions: /v1.0/subscriptions/{id} — first segment is "v1.0",
    // not "subscriptions", so looksLikeArmPath() returns false and the
    // path is left unchanged.
    const armPath = (isAzureArmHost(host) && looksLikeArmPath(normalisedPath))
      ? templateAzureArmPath(normalisedPath)
      : normalisedPath;
    const apiVersion = extractApiVersion(parsed);

    return {
      ok: true,
      method,
      host,
      pathname,
      normalisedPath,
      armPath,
      apiVersion,
      fullUrl: rawUrl,
    };
  }

  // Export
  // Predicates are the primary public API for checking ARM segment/host rules.
  // The constant snapshots (ARM_LITERAL_SEGMENTS_LIST, ARM_EXACT_HOSTS_LIST,
  // ARM_HOST_SUFFIXES_LIST) are frozen arrays exposed only for diagnostics and
  // testing — the live mutable Sets/arrays are intentionally NOT exported so
  // callers cannot accidentally mutate normalization behavior at runtime.
  exports.Normalizer = {
    normalise,
    normalisePath,
    templateAzureArmPath,
    isLiteralArmSegment,
    isAzureArmHost,
    looksLikeArmPath,
    extractApiVersion,
    TEMPLATE_RULES,
    ARM_SCOPE_RULES,
    // Read-only snapshots of the internal sets/arrays for diagnostics/tests only.
    ARM_LITERAL_SEGMENTS_LIST: Object.freeze(Array.from(ARM_LITERAL_SEGMENTS)),
    ARM_EXACT_HOSTS_LIST:      Object.freeze(Array.from(ARM_EXACT_HOSTS)),
    ARM_HOST_SUFFIXES_LIST:    Object.freeze(ARM_HOST_SUFFIXES.slice()),
    ARM_ROOT_SEGMENTS_LIST:    Object.freeze(Array.from(ARM_ROOT_SEGMENTS)),
  };

}(typeof window !== "undefined" ? window : exports));
