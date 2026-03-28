// lib/matcher.js — classifies normalised requests against the SpecRecon index
//
// Result states
// ─────────────
//   exact_match                — host + method + path template + api-version found
//   route_match_version_mismatch — route found but requested api-version absent
//   provider_known_route_unknown — provider namespace known; route not found
//   no_spec_match              — no provider namespace inferred or provider unknown
//   out_of_scope               — request is not Azure/Microsoft API traffic
//
// Route lookup strategy (v2 — ARM-aware)
// ────────────────────────────────────────
//   Route keys are tried in order of specificity:
//     1. norm.armPath  — ARM-structurally-templated path (subscriptionId,
//        resourceGroupName, {name}, etc.) — preferred because spec route keys
//        use semantic placeholders, not literal resource names.
//     2. norm.normalisedPath — generic-normalised path ({guid}, {id}) — kept as
//        a fallback to preserve backward compatibility with any shard whose
//        keys were generated from generic-normalised paths.
//   Using the ARM-templated path first reduces false "provider_known_route_unknown"
//   results caused by literal Azure resource names that the generic normaliser
//   does not replace (vault names, site names, storage account names, etc.).
//
// All results are returned as plain objects (never booleans).

"use strict";

(function (exports) {

  /**
   * Result states as a frozen enum-like object.
   */
  const STATUS = Object.freeze({
    EXACT_MATCH:               "exact_match",
    ROUTE_MISMATCH:            "route_match_version_mismatch",
    PROVIDER_KNOWN_NO_ROUTE:   "provider_known_route_unknown",
    NO_SPEC_MATCH:             "no_spec_match",
    ARM_ROOT_ROUTE:            "arm_root_route",
    OUT_OF_SCOPE:              "out_of_scope",
  });

  /**
   * Human-readable labels for each status.
   */
  const STATUS_LABELS = Object.freeze({
    [STATUS.EXACT_MATCH]:             "✅ Exact match",
    [STATUS.ROUTE_MISMATCH]:          "⚠️ Version mismatch",
    [STATUS.PROVIDER_KNOWN_NO_ROUTE]: "🔶 Unknown route",
    [STATUS.NO_SPEC_MATCH]:           "❌ No spec match",
    [STATUS.ARM_ROOT_ROUTE]:          "ℹ️ ARM root route",
    [STATUS.OUT_OF_SCOPE]:            "Out of scope",
  });

  /**
   * Regex source string for a valid Azure provider namespace segment, e.g.
   * "Microsoft.KeyVault" or "microsoft.insights".  Same pattern is used in
   * normalizer.js (_ARM_PROVIDER_NS_RE) for the double-provider detection and
   * here in `inferProviderNamespace` and `_canonicaliseRouteKey`.
   *
   * Format: starts with a letter, followed by letters/digits, a dot, then one
   * or more dot-separated alphanumeric components.
   * @private
   */
  const _ARM_NS_PATTERN_SRC = "[A-Za-z][A-Za-z0-9]*\\.[A-Za-z0-9.]+";

  /**
   * ARM root-level path keywords whose first segment unambiguously identifies
   * a request as targeting the Azure Resource Manager root surface (no
   * provider namespace in the URL).
   *
   * Examples: /subscriptions, /tenants, /providers,
   *           /subscriptions/{id}/providers (trailing /providers without a
   *           {Namespace} suffix).
   *
   * These are valid ARM endpoints documented by Microsoft, but they carry no
   * provider namespace in the URL, which means they cannot be matched against
   * a provider shard.  Under the classification model they receive the
   * ARM_ROOT_ROUTE status rather than NO_SPEC_MATCH to make the distinction
   * between "genuinely unrecognised" and "documented but provider-less" clear.
   */
  const ARM_ROOT_KEYWORDS = new Set([
    "subscriptions",
    "tenants",
    "providers",
    "managementGroups",
  ]);

  /**
   * Returns true when the request looks like a valid ARM root or tenant-scope
   * endpoint that has no provider namespace in the URL.
   *
   * Conditions:
   *   1. Host must be exactly "management.azure.com".
   *   2. The first non-empty path segment must be a known ARM root keyword.
   *
   * @param {object} norm  Output of Normalizer.normalise().
   * @returns {boolean}
   */
  function isArmRootPath(norm) {
    if (!norm || norm.host !== "management.azure.com") return false;
    const segs = (norm.pathname || "").split("/");
    for (let i = 0; i < segs.length; i++) {
      if (segs[i] !== "") return ARM_ROOT_KEYWORDS.has(segs[i]);
    }
    return false;
  }

  /**
   * Try to infer the provider namespace from a URL path.
   * Returns the **last** `/providers/Namespace` occurrence in the path.
   *
   * Azure ARM extension resources (e.g. diagnostic settings, metrics, role
   * assignments) are expressed as double-provider paths:
   *
   *   .../providers/Microsoft.Compute/virtualMachines/{name}/providers/microsoft.insights/metrics
   *
   * The first `/providers/` segment identifies the *parent* resource type;
   * the second identifies the *extension* provider that owns the route spec.
   * Returning the last match loads the correct shard (the extension provider)
   * and enables the scope-based suffix index to find the route.
   *
   * For single-provider paths the last match equals the first, so behaviour
   * for ordinary ARM routes is unchanged.
   *
   * Examples:
   *   /subscriptions/{guid}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/x
   *     → "Microsoft.Storage"
   *   /providers/Microsoft.AAD/domainServices
   *     → "Microsoft.AAD"
   *   .../providers/Microsoft.Compute/virtualMachines/{name}/providers/microsoft.insights/metrics
   *     → "microsoft.insights"
   *
   * Returns null if no provider segment is found.
   *
   * @param {string} path  Normalised or raw URL path.
   * @returns {string|null}
   */
  function inferProviderNamespace(path) {
    // Collect ALL /providers/Namespace occurrences and return the last one.
    const pattern = new RegExp("\\/providers\\/(" + _ARM_NS_PATTERN_SRC + "?)(?:\\/|$)", "g");
    let last = null;
    let match;
    while ((match = pattern.exec(path)) !== null) {
      last = match[1];
    }
    return last;
  }

  /**
   * Build the canonical route key used in the shard "routes" map.
   * Format: "METHOD /path/template"
   *
   * @param {string} method  Uppercase HTTP method.
   * @param {string} path    Path (may be normalised or raw).
   * @returns {string}
   */
  function buildRouteKey(method, path) {
    return method + " " + path;
  }

  /**
   * Replace ALL `{xxx}` placeholder names in a route key with `{name}`.
   *
   * Azure REST API spec path templates use resource-specific parameter names
   * such as `{vaultName}`, `{secretName}`, and `{accountName}`, while the ARM
   * normaliser always emits the structural placeholder `{name}` for resource-
   * name positions.  Normalising both sides to `{name}` before comparison
   * bridges this gap without requiring shard regeneration.
   *
   * @param {string} str  Route key or path string.
   * @returns {string}
   * @private
   */
  function _normalisePlaceholders(str) {
    return str.replace(/\{[^}]+\}/g, "{name}");
  }

  /**
   * Canonicalise a route key for resilient comparison across shard variations.
   *
   * Applies five normalisations on top of `_normalisePlaceholders`:
   *
   *   1. Placeholder normalisation: `{vaultName}` → `{name}` (same as
   *      `_normalisePlaceholders`).
   *
   *   2. ARM keyword case normalisation: fixed ARM scope keyword segments
   *      (`subscriptions`, `resourcegroups`, `tenants`, `locations`,
   *      `managementgroups`, `providers`) are lowercased.  Shard files
   *      generated from different versions of azure-rest-api-specs use
   *      inconsistent casing (e.g. `resourceGroups` vs `resourcegroups`,
   *      `managementGroups` vs `managementgroups`), so exact comparison
   *      fails without this step.
   *
   *   3. Trailing-slash stripping: some shard keys for collection list
   *      routes end with `/` (e.g. `.../deployments/`) while the normaliser
   *      always strips trailing slashes.  Stripping on both sides makes the
   *      comparison slash-agnostic.
   *
   *   4. Intermediate provider namespace normalisation: some Azure REST API
   *      specs (e.g. Microsoft.SecurityInsights) use a placeholder for the
   *      FIRST provider namespace in double-provider (extension resource)
   *      paths, e.g. `{operationalInsightsResourceProvider}`.  After step 1,
   *      this placeholder is already `{name}`.  The corresponding request key
   *      has the literal namespace (e.g. `Microsoft.OperationalInsights`).
   *      This step replaces every non-last provider namespace in the path
   *      with `{name}` so both sides normalise to the same canonical form.
   *
   *   5. `default` singleton value normalisation: Azure ARM specs often define
   *      singleton sub-resources using the parameter name `{default}`, whose
   *      only valid runtime value is the literal string "default".  After step 1
   *      the shard's `/{default}` placeholder becomes `/{name}`.  Meanwhile
   *      the request canonical key has the literal `/default` segment (preserved
   *      by ARM_LITERAL_SEGMENTS in the normaliser).  This step normalises
   *      `/default` to `/{name}` so both sides compare equal.
   *
   * @param {string} str  Route key string ("METHOD /path/template").
   * @returns {string}    Canonicalised route key.
   * @private
   */
  function _canonicaliseRouteKey(str) {
    // 1. Normalise all {xxx} placeholders to {name}
    let result = _normalisePlaceholders(str);

    // 2. Lowercase fixed ARM keyword path segments (case varies across shard
    //    generations: resourceGroups vs resourcegroups, managementGroups vs
    //    managementgroups, Subscriptions vs subscriptions, etc.)
    result = result.replace(
      /\/(subscriptions|resourcegroups|tenants|locations|managementgroups|providers)(?=\/|$)/gi,
      (_, kw) => "/" + kw.toLowerCase()
    );

    // 3. Strip trailing slash from path portion (some shard keys for
    //    collection routes end with '/', normaliser never emits one)
    result = result.replace(/\s(.+)\/$/, (_, path) => " " + path);

    // 4. Normalise intermediate provider namespaces to {name}.
    //    Double-provider (extension resource) paths have two /providers/
    //    occurrences.  Some specs (e.g. Microsoft.SecurityInsights) use a
    //    generic placeholder like {operationalInsightsResourceProvider} for
    //    the first (parent) namespace.  After step 1 this is already {name}.
    //    But the corresponding request canonical key has the literal namespace
    //    (e.g. `Microsoft.OperationalInsights`).  Replace ALL non-last
    //    provider namespace occurrences with {name} so both sides match.
    //    Pattern: /providers/NAMESPACE/ where NAMESPACE is X.Y form (literal)
    //    and ANOTHER /providers/ follows later in the path.
    //
    //    Regex: capture the path as everything after the space.
    //    We only change literal namespaces (X.Y pattern); placeholders
    //    ({name}) are already handled by step 1.
    result = result.replace(
      new RegExp("( .*?)\\/providers\\/(" + _ARM_NS_PATTERN_SRC + ")(\\/.*\\/providers\\/)", "g"),
      (_, pre, _ns, after) => pre + "/providers/{name}" + after
    );

    // 5. Normalise the literal path segment "default" to {name}.
    //    Azure ARM specs define singleton sub-resources via `{default}`, whose
    //    only valid value is "default".  After step 1 the shard's /{default}
    //    becomes /{name}.  The request path (which ARM_LITERAL_SEGMENTS
    //    preserves as /default) must also become /{name} for the comparison.
    result = result.replace(/\/default(?=\/|$)/g, "/{name}");

    return result;
  }

  /**
   * Build a secondary route index keyed by canonicalised route keys.
   *
   * Each entry stores both the original route definition and the original
   * route key so callers can report the real spec key to the user rather than
   * the normalised form.
   *
   * The canonical key applies three normalisations via `_canonicaliseRouteKey`:
   *   - `{xxx}` placeholders → `{name}`
   *   - ARM scope keyword segments lowercased
   *   - Trailing slash stripped from path
   *
   * When two shard routes canonicalise to the same key the first entry wins.
   *
   * @param {object} routes  Shard routes map (routeKey → routeDef).
   * @returns {object}       Canonical key → `{ routeDef, originalKey }`.
   * @private
   */
  function _buildCanonicalRouteIndex(routes) {
    const index = Object.create(null);
    for (const routeKey of Object.keys(routes)) {
      const canonKey = _canonicaliseRouteKey(routeKey);
      if (!index[canonKey]) {
        index[canonKey] = { routeDef: routes[routeKey], originalKey: routeKey };
      }
    }
    return index;
  }

  /**
   * Build a path → available-methods index for all routes in a shard host.
   *
   * The index enables a last-resort "method not in spec" check: when a request
   * fails all route-key lookups (exact, canonical, and singleton-suffix), we
   * can still detect that the requested path IS known in the shard but the
   * HTTP method is not defined for it.  This distinguishes an `OPTIONS` (CORS
   * preflight) or any other non-spec method from a genuinely unknown path.
   *
   * Keys are canonical paths (the canonical route key with the method prefix
   * stripped), so the lookup is resilient to the same casing and trailing-slash
   * variations handled by `_canonicaliseRouteKey`.
   *
   * @param {object} routes  Shard routes map (routeKey → routeDef).
   * @returns {object}       Canonical path → sorted array of HTTP methods.
   * @private
   */
  function _buildPathMethodIndex(routes) {
    const index = Object.create(null);
    for (const routeKey of Object.keys(routes)) {
      const spaceIdx = routeKey.indexOf(" ");
      if (spaceIdx < 0) continue;
      const method    = routeKey.slice(0, spaceIdx);
      const canonKey  = _canonicaliseRouteKey(routeKey);
      const canonPath = canonKey.slice(canonKey.indexOf(" ") + 1);

      if (!index[canonPath]) {
        index[canonPath] = [];
      }
      if (!index[canonPath].includes(method)) {
        index[canonPath].push(method);
      }
    }
    return index;
  }

  /**
   * Set of first-segment placeholder names that represent a variable-length
   * ARM scope or resource URI prefix in REST API spec route templates.
   *
   * Routes beginning with one of these placeholders follow the pattern:
   *
   *   /{scope-placeholder}/providers/Namespace/resource...
   *
   * The placeholder expands at runtime to a variable-length ARM path:
   *   - /subscriptions/{subId}
   *   - /subscriptions/{subId}/resourceGroups/{rgName}
   *   - /providers/Microsoft.Management/managementGroups/{mgId}
   *   - any other ARM resource URI
   *
   * @type {Set<string>}
   * @private
   */
  const _SCOPE_PLACEHOLDERS = new Set([
    "scope",           // Generic ARM scope (subscription, RG, management group, etc.)
    "resourceUri",     // Any ARM resource URI (used by diagnostics, metrics, etc.)
    "resourceScope",   // Policy-style scope
    "resourceId",      // Full ARM resource ID (used by security, backup, etc.)
    "connectedClusterResourceUri",  // Arc-enabled cluster extension routes
    "customLocationResourceUri",    // Custom location extension routes
    "billingScope",    // Billing scope (subscriptions, MCA accounts, etc.)
    "scopeId",         // Azure Policy scope assignment identifier
    "idScope",         // IoT Hub identity scope
  ]);

  /**
   * Escape special regular-expression characters in a string.
   *
   * Used to safely embed provider namespace strings (which contain `.`) in
   * regular expressions without `.` matching an arbitrary character.
   *
   * @param {string} str  Input string.
   * @returns {string}    Regex-escaped string.
   * @private
   */
  function _escapeRegexp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Canonicalise a scope-based suffix route key for resilient matching.
   *
   * Applies `_canonicaliseRouteKey` (placeholder normalisation + ARM keyword
   * lowercasing + trailing-slash stripping) and then lowercases the entire
   * path portion.  The extra lowercasing makes the scope suffix key insensitive
   * to provider namespace casing variations across shard generations
   * (e.g. `Microsoft.Resources` vs `microsoft.resources`, `microsoft.insights`
   * vs `Microsoft.Insights`).
   *
   * The method component is preserved in its original uppercase form.
   *
   * @param {string} method  Uppercase HTTP method (e.g. "GET").
   * @param {string} suffix  Path suffix starting at "/providers/Namespace/...".
   * @returns {string}       Canonicalised scope suffix key ("METHOD /path").
   * @private
   */
  function _canonicaliseScopeSuffix(method, suffix) {
    const canonFull = _canonicaliseRouteKey(method + " " + suffix);
    const spaceIdx  = canonFull.indexOf(" ");
    return canonFull.slice(0, spaceIdx + 1) + canonFull.slice(spaceIdx + 1).toLowerCase();
  }

  /**
   * Extract the "/providers/Namespace/..." scope suffix from a canonical path.
   *
   * Searches for the first occurrence of "/providers/ProviderNamespace" (case-
   * insensitive) and returns the path substring from that point.  The resulting
   * suffix can be fed into `_canonicaliseScopeSuffix` for scope-based index
   * lookup.
   *
   * Returns null if the provider namespace is not found in the canonical path.
   *
   * @param {string} canonPath   Canonical path (from `_canonicaliseRouteKey`).
   * @param {string} providerNs  Provider namespace to anchor the search
   *                             (e.g. "Microsoft.Resources").
   * @returns {string|null}
   * @private
   */
  function _extractScopeSuffix(canonPath, providerNs) {
    const pattern = new RegExp(
      "/providers/" + _escapeRegexp(providerNs) + "(?=/|$)",
      "i"
    );
    const match = canonPath.match(pattern);
    return match ? canonPath.slice(match.index) : null;
  }

  /**
   * Build scope-based route indices for resilient matching of routes defined
   * with a variable-length ARM scope placeholder as their first path segment.
   *
   * Many Azure ARM REST API specs define extension routes using a single
   * placeholder (`{scope}`, `{resourceUri}`, `{resourceScope}`, etc.) that
   * expands to a variable-length ARM path prefix at runtime:
   *
   *   /{scope}/providers/Microsoft.Resources/deployments/{name}
   *
   * When a request arrives at a concrete path (e.g.:
   *   /subscriptions/{subId}/resourceGroups/{rg}/providers/Microsoft.Resources/deployments/{name}
   * ), the ARM normaliser emits the full scoped path — which does not match
   * the `/{scope}/providers/...` shard key.  The scope-based index bridges
   * this gap by keying on the `/providers/Namespace/...` suffix rather than
   * the full route path.
   *
   * Returns two indices:
   *
   *   scopeRoutes  — `METHOD " " canonScopeSuffix` → `{ routeDef, originalKey }`.
   *                  Used for direct method + suffix matching.
   *
   *   scopeMethods — `canonScopeSuffix` → sorted array of HTTP methods.
   *                  Used for `http_method_not_in_spec` detection when the
   *                  request method is not defined for a known scope-based path.
   *
   * @param {object} routes  Shard routes map (routeKey → routeDef).
   * @returns {{ scopeRoutes: object, scopeMethods: object }}
   * @private
   */
  function _buildScopeBasedIndices(routes, providerNamespace) {
    const scopeRoutes  = Object.create(null);
    const scopeMethods = Object.create(null);
    const nsLower      = providerNamespace ? providerNamespace.toLowerCase() : "";

    for (const routeKey of Object.keys(routes)) {
      const spaceIdx = routeKey.indexOf(" ");
      if (spaceIdx < 0) continue;
      const method   = routeKey.slice(0, spaceIdx);
      const pathPart = routeKey.slice(spaceIdx + 1);

      // Split on "/" — leading slash means segs[0]="" segs[1]=first segment.
      const segs = pathPart.split("/");
      if (segs.length < 3) continue;

      let suffix = null;

      // Case 1: /{scope-placeholder}/providers/Namespace/...
      // The first path segment is a known ARM scope placeholder.
      const firstSeg = segs[1];
      if (firstSeg.startsWith("{") && firstSeg.endsWith("}") &&
          _SCOPE_PLACEHOLDERS.has(firstSeg.slice(1, -1))) {
        const providersIdx = pathPart.indexOf("/providers/", 1);
        if (providersIdx >= 0) {
          suffix = pathPart.slice(providersIdx);
        }
      }

      // Case 2: Double-provider path where the first provider namespace is a
      // {placeholder}, representing a variable parent resource type.
      //
      // Example:
      //   /subscriptions/{subId}/resourceGroups/{rg}/providers/{clusterRp}/
      //   {clusterResourceName}/{clusterName}/providers/Microsoft.KubernetesConfiguration/extensions
      //
      // These routes cannot be matched by the normaliser's ARM templating
      // because the first provider namespace is variable.  We index them by the
      // suffix starting at the SECOND /providers/ occurrence (the shard's own
      // provider namespace), just like scope-placeholder routes.
      if (!suffix) {
        const firstProvidersIdx = pathPart.indexOf("/providers/");
        if (firstProvidersIdx >= 0) {
          const afterFirst = pathPart.slice(firstProvidersIdx + "/providers/".length);
          const firstNsEnd = afterFirst.indexOf("/");
          const firstNs    = firstNsEnd >= 0 ? afterFirst.slice(0, firstNsEnd) : afterFirst;
          // First provider namespace is a placeholder (e.g. {clusterRp})
          if (firstNs.startsWith("{") && firstNs.endsWith("}")) {
            const secondProvidersIdx = pathPart.indexOf("/providers/", firstProvidersIdx + 1);
            if (secondProvidersIdx >= 0) {
              const afterSecond = pathPart.slice(secondProvidersIdx + "/providers/".length);
              const secondNsEnd = afterSecond.indexOf("/");
              const secondNs    = secondNsEnd >= 0 ? afterSecond.slice(0, secondNsEnd) : afterSecond;
              // Verify the second provider matches this shard's namespace
              if (secondNs.toLowerCase() === nsLower) {
                suffix = pathPart.slice(secondProvidersIdx);
              }
            }
          }
        }
      }

      if (!suffix) continue;

      const canonFull     = _canonicaliseScopeSuffix(method, suffix);
      const routeSpaceIdx = canonFull.indexOf(" ");
      const canonSuffix   = canonFull.slice(routeSpaceIdx + 1);

      // Scope routes index: method + " " + canonSuffix → route entry
      if (!scopeRoutes[canonFull]) {
        scopeRoutes[canonFull] = { routeDef: routes[routeKey], originalKey: routeKey };
      }
      // Scope methods index: canonSuffix → list of methods (for method detection)
      if (!scopeMethods[canonSuffix]) {
        scopeMethods[canonSuffix] = [];
      }
      if (!scopeMethods[canonSuffix].includes(method)) {
        scopeMethods[canonSuffix].push(method);
      }
    }

    return { scopeRoutes, scopeMethods };
  }

  /**
   * Build a secondary index of shard routes whose path ends with `/{default}`.
   *
   * Some Azure REST API specs model singleton resources using the parameter
   * name `{default}` (e.g. `GET /providers/Microsoft.Resources/dataBoundaries/{default}`).
   * There is exactly one valid value for `{default}`: the literal string
   * "default".  Clients sometimes call the parent path without the trailing
   * "/default" suffix (e.g. `GET /providers/Microsoft.Resources/dataBoundaries`).
   *
   * This index maps the canonical parent-path route key (the shard route key
   * with `/{default}` stripped and then canonicalised) to the original route
   * entry.  It is used as a last-resort fallback so that requests omitting the
   * "/default" singleton suffix are classified as "route match" rather than
   * "unknown route".
   *
   * Only shard routes whose last path segment is literally `{default}` in the
   * original key are indexed.  Generic resource-name placeholders such as
   * `{vaultName}` or `{deploymentName}` are intentionally excluded so that list
   * requests for a resource type are not incorrectly matched against the
   * single-resource GET route for that type.
   *
   * @param {object} routes  Shard routes map (routeKey → routeDef).
   * @returns {object}       Canonical parent key → `{ routeDef, originalKey }`.
   * @private
   */
  function _buildDefaultSingletonIndex(routes) {
    const index = Object.create(null);
    for (const routeKey of Object.keys(routes)) {
      // Split "METHOD /path" into method and path segments
      const spaceIdx = routeKey.indexOf(" ");
      if (spaceIdx < 0) continue;
      const pathPart = routeKey.slice(spaceIdx + 1);
      const segs = pathPart.split("/");
      // Only index routes whose last segment is the literal placeholder {default}
      if (segs[segs.length - 1] !== "{default}") continue;

      // Build the parent route key: strip the trailing /{default} segment
      const parentPathPart = segs.slice(0, -1).join("/");
      const parentRouteKey  = routeKey.slice(0, spaceIdx + 1) + parentPathPart;
      const parentCanonKey  = _canonicaliseRouteKey(parentRouteKey);

      if (!index[parentCanonKey]) {
        index[parentCanonKey] = { routeDef: routes[routeKey], originalKey: routeKey };
      }
    }
    return index;
  }

  /**
   * Resolve a match result for a found route entry against the request's
   * api-version.
   *
   * Centralises the "found route — check api-version" logic that is common to
   * the direct lookup, canonical-key fallback, and singleton-suffix fallback.
   *
   * @param {object}      routeDef         Route definition from the shard.
   * @param {string}      originalKey      Original shard route key.
   * @param {string}      providerNamespace  Provider namespace string.
   * @param {string|null} apiVersion       Request api-version (may be null).
   * @returns {object}    Match result (_result object).
   * @private
   */
  function _resolveRouteMatch(routeDef, originalKey, providerNamespace, apiVersion) {
    const versions = Object.keys(routeDef.versions || {});

    if (!apiVersion) {
      return _result(STATUS.ROUTE_MISMATCH, {
        provider_namespace:  providerNamespace,
        matched_route_key:   originalKey,
        matched_versions:    versions,
        reason:              "no_api_version_in_request",
        shard_name:          providerNamespace,
      });
    }

    if (routeDef.versions[apiVersion]) {
      return _result(STATUS.EXACT_MATCH, {
        provider_namespace:  providerNamespace,
        matched_route_key:   originalKey,
        matched_versions:    versions,
        matched_version:     apiVersion,
        shard_name:          providerNamespace,
        reason:              "exact",
      });
    }

    return _result(STATUS.ROUTE_MISMATCH, {
      provider_namespace:  providerNamespace,
      matched_route_key:   originalKey,
      matched_versions:    versions,
      reason:              "api_version_not_in_spec",
      shard_name:          providerNamespace,
    });
  }

  /**
   * Attempt a type-wildcard lookup for routes that use `{placeholder}` at
   * TYPE positions within the provider section.
   *
   * Some Azure REST API specs parameterise the resource type segment itself
   * (e.g. `{endpointType}` in Traffic Manager, `{recordType}` in Private DNS,
   * `{parentType}` in Event Grid, `{keyType}` in Web Apps, `{scopePath}` in
   * Application Insights, `{externalCloudProviderType}` in Cost Management).
   *
   * The ARM normaliser keeps the concrete type value (e.g. "AzureEndpoints",
   * "A", "topics") as a literal at those positions in the request canonical key.
   * The shard's canonical key, however, has `{name}` there (all `{xxx}` are
   * normalised by `_canonicaliseRouteKey`).
   *
   * This function retries the lookup by replacing each type-position literal
   * (segments at even offsets within the provider section: type, name, type,
   * name, …) one at a time with `{name}` and checking the canonical index.
   * The first hit is returned; null if none match.
   *
   * @param {string} canonKey    Canonical route key ("METHOD /path").
   * @param {object} canonIndex  Canonical route index from `_buildCanonicalRouteIndex`.
   * @param {string} providerNs  Provider namespace to anchor the suffix search.
   * @returns {{ routeDef: object, originalKey: string }|null}
   * @private
   */
  function _tryTypeWildcardLookup(canonKey, canonIndex, providerNs) {
    const spaceIdx = canonKey.indexOf(" ");
    const canonPath = canonKey.slice(spaceIdx + 1);

    // Extract the sub-path starting at /providers/providerNs
    const suffix = _extractScopeSuffix(canonPath, providerNs);
    if (!suffix) return null;

    // Position of the suffix inside canonPath
    const prefixLen  = canonPath.length - suffix.length;
    const keyPrefix  = canonKey.slice(0, spaceIdx + 1) + canonPath.slice(0, prefixLen);

    // suffix: /providers/Namespace/seg0/seg1/seg2/...
    // segs[0]="", segs[1]="providers", segs[2]=Namespace,
    // segs[3]=type0, segs[4]=name0, segs[5]=type1, segs[6]=name1, ...
    // Type positions within the provider section: indices 3, 5, 7, ...
    const segs = suffix.split("/");

    // Collect indices of type-position segments that are still concrete literals
    // (i.e. not already {name}).  These are candidates for wildcarding.
    const typePositions = [];
    for (let i = 3; i < segs.length; i += 2) {
      if (segs[i] !== "{name}") {
        typePositions.push(i);
      }
    }
    if (typePositions.length === 0) return null;

    // Strategy 1: Try replacing each type-position literal with {name} one at a
    // time.  This handles all single-discriminator cases regardless of how many
    // type-position literals are present (e.g. `{endpointType}` in Traffic
    // Manager, `{keyType}` in Web Apps even when several earlier type literals
    // like `sites`, `slots`, `host` precede it).
    for (const pos of typePositions) {
      const newSegs = segs.slice();
      newSegs[pos] = "{name}";
      const entry = canonIndex[keyPrefix + newSegs.join("/")];
      if (entry) return entry;
    }

    // Strategy 2: Try replacing pairs of type-position literals simultaneously.
    // This handles routes where the spec uses {placeholder} at two type positions
    // (e.g. ServiceFabric `/{location}/osType/{osType}/clusterVersions` where
    // both the concrete location and osType values need to be wildcarded).
    // Cap pair combinations at the first 4 positions to keep overhead bounded.
    const pairBound = Math.min(typePositions.length, 4);
    for (let a = 0; a < pairBound - 1; a++) {
      for (let b = a + 1; b < pairBound; b++) {
        const newSegs = segs.slice();
        newSegs[typePositions[a]] = "{name}";
        newSegs[typePositions[b]] = "{name}";
        const entry = canonIndex[keyPrefix + newSegs.join("/")];
        if (entry) return entry;
      }
    }
    return null;
  }

  /**
   * Regex that matches a valid Azure provider namespace — used by
   * `_normaliseNamePositions` to detect double-provider boundaries.
   *
   * @type {RegExp}
   * @private
   */
  const _ARM_PROVIDER_NS_RE_MATCHER = new RegExp("^" + _ARM_NS_PATTERN_SRC + "$");

  /**
   * Replace all name-position literals (odd offsets after each
   * ``/providers/Namespace/``) with ``{name}`` in a canonicalised route key.
   *
   * This mirrors the ARM normaliser's type/name alternation logic: after
   * ``/providers/{Namespace}``, even-indexed segments are resource types
   * (kept literal) and odd-indexed segments are resource names (replaced
   * with ``{name}``).  Extension resources (a second ``/providers/``
   * occurrence) reset the position counter.
   *
   * The canonical key has already been through ``_canonicaliseRouteKey``,
   * so all ``{xxx}`` placeholders are already ``{name}``, ARM keywords are
   * lowercased, and trailing slashes are stripped.  This function only
   * affects *literal* segments at name positions that the normaliser
   * might have replaced with ``{name}`` but the shard kept verbatim
   * (e.g. ``logs``, ``getEntityTypeImageUploadUrl``).
   *
   * @param {string} canonKey  Canonical route key ("METHOD /path").
   * @returns {string}         Name-normalised route key.
   * @private
   */
  function _normaliseNamePositions(canonKey) {
    const spaceIdx = canonKey.indexOf(" ");
    if (spaceIdx < 0) return canonKey;
    const method = canonKey.slice(0, spaceIdx);
    const path   = canonKey.slice(spaceIdx + 1);

    const segs   = path.split("/");
    const result = [];
    let inProv   = false;
    let resPos   = 0;
    let i = 0;

    while (i < segs.length) {
      const s  = segs[i];
      const sl = s.toLowerCase();

      // Before /providers/: pass through (scope segments already canonical)
      if (!inProv && sl === "providers") {
        result.push(s);
        i++;
        if (i < segs.length) { result.push(segs[i]); i++; }
        inProv = true;
        resPos = 0;
        continue;
      }

      if (inProv) {
        const next = segs[i + 1];
        // Double-provider detection
        if (sl === "providers" && next && _ARM_PROVIDER_NS_RE_MATCHER.test(next)) {
          result.push(s);
          result.push(next);
          i += 2;
          resPos = 0;
          continue;
        }
        const isName = (resPos % 2 === 1);
        if (isName && s !== "{name}") {
          result.push("{name}");
        } else {
          result.push(s);
        }
        resPos++;
        i++;
        continue;
      }

      result.push(s);
      i++;
    }

    return method + " " + result.join("/");
  }

  /**
   * Build a secondary route index where **all** name-position literals in
   * the provider section are normalised to ``{name}``.
   *
   * This handles the gap between the shard (which may keep literals like
   * ``logs``, ``listKeys``, or action verbs at name positions) and the
   * runtime normaliser (which replaces them with ``{name}`` unless they
   * appear in ``ARM_LITERAL_SEGMENTS``).  Adding every possible literal
   * to the allowlist is fragile; this index provides a robust fallback by
   * normalising *both* sides to ``{name}`` at every name position.
   *
   * When two shard routes normalise to the same key the first entry wins.
   *
   * @param {object} routes  Shard routes map (routeKey → routeDef).
   * @returns {object}       Name-normalised key → ``{ routeDef, originalKey }``.
   * @private
   */
  function _buildNameNormalisedIndex(routes) {
    const index = Object.create(null);
    for (const routeKey of Object.keys(routes)) {
      const canonKey    = _canonicaliseRouteKey(routeKey);
      const nameNormKey = _normaliseNamePositions(canonKey);
      // Only add if different from the canonical key — avoids bloating
      // the index with entries that the canonical index already covers.
      if (nameNormKey !== canonKey && !index[nameNormKey]) {
        index[nameNormKey] = { routeDef: routes[routeKey], originalKey: routeKey };
      }
    }
    return index;
  }

  /**
   * WeakMap cache for route indices keyed on the shard routes object.
   *
   * Indices are built lazily the first time a shard is matched and then reused
   * for every subsequent request to the same shard (same routes object
   * reference).  The WeakMap allows the cached indices to be garbage-collected
   * when the shard is no longer referenced.
   *
   * @type {WeakMap<object, { canon: object, singleton: object, pathMethod: object, scopeRoutes: object, scopeMethods: object, nameNorm: object }>}
   * @private
   */
  const _routeIndexCache = new WeakMap();

  /**
   * Return (or lazily build and cache) all route indices for a given routes
   * object: canonical, singleton, path-method, scope-routes, scope-methods,
   * and name-normalised.
   *
   * @param {object} routes           Shard routes map (routeKey → routeDef).
   * @param {string} providerNamespace  Shard provider namespace (e.g. "Microsoft.Resources").
   * @returns {{ canon: object, singleton: object, pathMethod: object, scopeRoutes: object, scopeMethods: object, nameNorm: object }}
   * @private
   */
  function _getRouteIndices(routes, providerNamespace) {
    if (_routeIndexCache.has(routes)) {
      return _routeIndexCache.get(routes);
    }
    const { scopeRoutes, scopeMethods } = _buildScopeBasedIndices(routes, providerNamespace);
    const indices = {
      canon:       _buildCanonicalRouteIndex(routes),
      singleton:   _buildDefaultSingletonIndex(routes),
      pathMethod:  _buildPathMethodIndex(routes),
      nameNorm:    _buildNameNormalisedIndex(routes),
      scopeRoutes,
      scopeMethods,
    };
    _routeIndexCache.set(routes, indices);
    return indices;
  }

  /**
   * Attempt to match a normalised request against a loaded shard.
   *
   * Strategy (v6 — ARM-aware with name-literal fallback):
   *   1. Build candidate route keys from norm.armPath (ARM-templated) and
   *      norm.normalisedPath (generic-normalised), in that priority order.
   *   2. Try each candidate in order; use the first matching route key.
   *   3. If found, check whether the api-version exists in that route's versions.
   *   4. Canonical-key fallback: normalise both sides (placeholders + ARM
   *      keyword casing + trailing slash) and retry.
   *   5. Default-singleton suffix fallback: if the spec defines the route with
   *      a `/{default}` suffix that the client omitted, match against that
   *      singleton route rather than reporting "unknown route".
   *   6. Name-literal fallback: normalise all name-position literals (odd
   *      offsets after /providers/{Namespace}) to `{name}` on the shard side.
   *      Handles shard routes that keep literals at name positions (actions,
   *      singletons, config endpoints) that the ARM normaliser replaced.
   *   7. Scope-based suffix fallback: many Azure specs define routes using a
   *      variable-length ARM scope placeholder (`{scope}`, `{resourceUri}`,
   *      `{resourceScope}`, …) as the first path segment.  The ARM normaliser
   *      emits the full concrete scope prefix, which never matches
   *      `/{scope}/providers/…` directly.  The scope-based index matches by
   *      the `/providers/Namespace/rest` suffix anchored on the shard's own
   *      provider namespace, handling both exact-method and
   *      `http_method_not_in_spec` cases.
   *   8. HTTP method not-in-spec fallback (non-scope routes): if the canonical
   *      path IS present in the shard under a different method (e.g. `OPTIONS`
   *      to a `POST`-only route), return reason="http_method_not_in_spec".
   *   9. If no key matches, report provider_known_route_unknown.
   *
   * Trying norm.armPath first reduces false "provider_known_route_unknown"
   * results caused by literal Azure resource names (vault names, site names,
   * storage account names, etc.) that the generic normaliser does not replace
   * but the ARM structural templating stage does.
   *
   * @param {object} norm    Output of Normalizer.normalise().
   * @param {object} shard   Loaded shard JSON for the inferred provider.
   * @returns {object}       Match result object.
   */
  function matchAgainstShard(norm, shard) {
    const providerNamespace = shard.provider_namespace;
    const hostData = shard.hosts && shard.hosts[norm.host];

    if (!hostData) {
      // Provider is known (we have a shard) but this host isn't in it
      return _result(STATUS.PROVIDER_KNOWN_NO_ROUTE, {
        provider_namespace: providerNamespace,
        reason: "host_not_in_shard",
        shard_name: shard.metadata && shard.metadata.provider_namespace,
      });
    }

    const routes = hostData.routes || {};

    // Build candidate path list: prefer armPath, fall back to normalisedPath.
    // armPath equals normalisedPath when no ARM structural rules applied, so
    // deduplication avoids a redundant lookup in that case.
    const candidatePaths = [];
    if (norm.armPath && norm.armPath !== norm.normalisedPath) {
      candidatePaths.push(norm.armPath);
    }
    candidatePaths.push(norm.normalisedPath);

    for (const candidatePath of candidatePaths) {
      const routeKey = buildRouteKey(norm.method, candidatePath);
      if (!routes[routeKey]) continue;
      return _resolveRouteMatch(routes[routeKey], routeKey, providerNamespace, norm.apiVersion);
    }

    // Canonical-key fallback.
    // Applies placeholder normalisation + ARM keyword lowercasing + trailing-
    // slash stripping to handle the two known shard inconsistencies:
    //   • ARM scope keywords: `resourceGroups` vs `resourcegroups`,
    //     `managementGroups` vs `managementgroups`, etc.
    //   • Collection list routes: shard key ends with '/', normalised path
    //     never does (e.g. ".../deployments/" in the shard vs
    //     ".../deployments" from the normaliser).
    //
    // Indices are cached per routes object (_getRouteIndices) and reused by all
    // subsequent fallbacks.
    if (norm.armPath) {
      const {
        canon:       canonIndex,
        singleton:   singletonIndex,
        pathMethod:  pathMethodIndex,
        nameNorm:    nameNormIndex,
        scopeRoutes: scopeRoutesIndex,
        scopeMethods: scopeMethodsIndex,
      } = _getRouteIndices(routes, providerNamespace);
      const canonKey  = _canonicaliseRouteKey(buildRouteKey(norm.method, norm.armPath));
      const canonPath = canonKey.slice(canonKey.indexOf(" ") + 1);

      const entry = canonIndex[canonKey];
      if (entry) {
        return _resolveRouteMatch(entry.routeDef, entry.originalKey, providerNamespace, norm.apiVersion);
      }

      // {default} singleton-suffix fallback.
      //
      // Some Azure ARM specs define singleton resources using the parameter
      // name `{default}` — e.g. `.../dataBoundaries/{default}`.  Clients
      // sometimes call the parent path without the trailing "/default" suffix
      // (e.g. `GET /providers/Microsoft.Resources/dataBoundaries`).
      //
      // The singleton index maps parent canonical keys to the `{default}`
      // singleton route so that these requests are classified as "route match"
      // rather than "unknown route".
      const singletonEntry = singletonIndex[canonKey];
      if (singletonEntry) {
        return _resolveRouteMatch(singletonEntry.routeDef, singletonEntry.originalKey, providerNamespace, norm.apiVersion);
      }

      // Type-wildcard fallback for type-position placeholder discriminators.
      //
      // Some Azure REST API specs use `{placeholder}` at TYPE positions within
      // the provider section (e.g. `{endpointType}` in Traffic Manager,
      // `{recordType}` in Private DNS, `{parentType}` in Event Grid, `{keyType}`
      // in Web Apps, `{scopePath}` in Application Insights,
      // `{externalCloudProviderType}` in Cost Management).
      //
      // The ARM normaliser keeps concrete type values (e.g. "AzureEndpoints",
      // "A", "topics") as literals at those positions while the shard canonical
      // has `{name}` there.  Try replacing each type-position literal with
      // `{name}` one at a time and check the canonical index.
      const typeWildEntry = _tryTypeWildcardLookup(canonKey, canonIndex, providerNamespace);
      if (typeWildEntry) {
        return _resolveRouteMatch(typeWildEntry.routeDef, typeWildEntry.originalKey, providerNamespace, norm.apiVersion);
      }

      // Name-literal fallback.
      //
      // Some shard route keys contain literal segments at name positions
      // (e.g. "config/logs", "images/getEntityTypeImageUploadUrl") that the
      // ARM normaliser replaces with {name} when the literal is not in
      // ARM_LITERAL_SEGMENTS.  The name-normalised index canonicalises the
      // SHARD side to {name} at every name position, so the request's
      // canonical key (which already has {name} from the normaliser) can
      // match directly.
      {
        const nameNormEntry = nameNormIndex[canonKey];
        if (nameNormEntry) {
          return _resolveRouteMatch(nameNormEntry.routeDef, nameNormEntry.originalKey, providerNamespace, norm.apiVersion);
        }
      }

      // Scope-based suffix fallback.
      //
      // Many Azure ARM specs define routes with a variable-length ARM scope
      // placeholder (`{scope}`, `{resourceUri}`, `{resourceScope}`, …) as the
      // first path segment:
      //
      //   GET /{scope}/providers/Microsoft.Resources/deployments/{name}
      //
      // The ARM normaliser always emits the full concrete scope prefix (e.g.
      // /subscriptions/{subId}/resourceGroups/{rg}/providers/…), which never
      // matches the `/{scope}/providers/…` shard key in any of the previous
      // lookup steps.
      //
      // The scope-based index (scopeRoutesIndex) is keyed by:
      //   METHOD " " lowercase(/providers/Namespace/rest)
      // extracted from the scope-placeholder route in the shard.  For lookup
      // we extract the same suffix from the canonical request path, anchored
      // on the shard's provider namespace.
      const scopeSuffix = _extractScopeSuffix(canonPath, providerNamespace);
      if (scopeSuffix !== null) {
        const canonScopeSuffixKey = _canonicaliseScopeSuffix(norm.method, scopeSuffix);
        const scopeEntry = scopeRoutesIndex[canonScopeSuffixKey];
        if (scopeEntry) {
          return _resolveRouteMatch(scopeEntry.routeDef, scopeEntry.originalKey, providerNamespace, norm.apiVersion);
        }

        // HTTP method not-in-spec for scope-based routes.
        // The path IS known via the scope index but the requested method is not
        // defined for it.
        const canonScopePathOnly      = canonScopeSuffixKey.slice(canonScopeSuffixKey.indexOf(" ") + 1);
        const scopeAvailableMethods   = scopeMethodsIndex[canonScopePathOnly];
        if (scopeAvailableMethods && scopeAvailableMethods.length > 0) {
          return _result(STATUS.PROVIDER_KNOWN_NO_ROUTE, {
            provider_namespace: providerNamespace,
            reason:             "http_method_not_in_spec",
            available_methods:  scopeAvailableMethods.slice().sort(),
            shard_name:         providerNamespace,
          });
        }
      }

      // HTTP method not-in-spec fallback (non-scope routes).
      //
      // Browsers send automatic `OPTIONS` (CORS preflight) and sometimes
      // `HEAD` requests to paths that the spec only defines for other methods
      // (GET, POST, PUT, …).  When ALL route-key lookups above fail but the
      // canonical path IS present in the shard under a different method, the
      // path itself is known — the method just isn't in the spec.
      //
      // Return a more informative reason ("http_method_not_in_spec") and the
      // list of spec-defined methods for the path so callers can distinguish
      // "OPTIONS to a known endpoint" from a genuinely unknown path.
      const availableMethods = pathMethodIndex[canonPath];
      if (availableMethods && availableMethods.length > 0) {
        return _result(STATUS.PROVIDER_KNOWN_NO_ROUTE, {
          provider_namespace: providerNamespace,
          reason:             "http_method_not_in_spec",
          available_methods:  availableMethods.slice().sort(),
          shard_name:         providerNamespace,
        });
      }
    }

    // No route key matched any candidate path
    return _result(STATUS.PROVIDER_KNOWN_NO_ROUTE, {
      provider_namespace: providerNamespace,
      reason:             "route_not_in_shard",
      shard_name:         providerNamespace,
    });
  }

  /**
   * Main classification entry point.
   * Accepts a normalised request and a (possibly null) shard.
   *
   * @param {object}      norm   Output of Normalizer.normalise() — must have ok===true.
   * @param {object|null} shard  Loaded shard JSON for the inferred provider, or null.
   * @param {object}      [opts]
   * @param {boolean}     [opts.inScope=true]       Whether the request is in scope per filters.
   * @param {string|null} [opts.shardLoadError=null] Error message if shard fetch/parse failed.
   * @returns {object}  Classification result.
   */
  function classify(norm, shard, opts) {
    const inScope        = (opts && opts.inScope        !== undefined) ? opts.inScope        : true;
    const shardLoadError = (opts && opts.shardLoadError !== undefined) ? opts.shardLoadError : null;

    if (!inScope) {
      return _result(STATUS.OUT_OF_SCOPE, {
        reason: "not_azure_microsoft",
      });
    }

    if (!norm || !norm.ok) {
      return _result(STATUS.NO_SPEC_MATCH, {
        reason: "normalisation_failed",
      });
    }

    if (!shard) {
      const inferredNs = inferProviderNamespace(norm.pathname);
      if (shardLoadError) {
        return _result(STATUS.NO_SPEC_MATCH, {
          provider_namespace: inferredNs || null,
          reason:             "shard_load_failed",
          error:              shardLoadError,
        });
      }
      if (!inferredNs) {
        // No provider namespace in the URL.  Distinguish between valid ARM
        // root/tenant endpoints (e.g. /subscriptions, /tenants, /providers)
        // and genuinely non-matching requests.
        if (isArmRootPath(norm)) {
          return _result(STATUS.ARM_ROOT_ROUTE, {
            reason: "arm_root_no_provider",
          });
        }
        return _result(STATUS.NO_SPEC_MATCH, {
          provider_namespace: null,
          reason: "no_provider_inferred",
        });
      }
      return _result(STATUS.NO_SPEC_MATCH, {
        provider_namespace: inferredNs,
        reason: "provider_shard_not_bundled",
      });
    }

    return matchAgainstShard(norm, shard);
  }

  /**
   * Convenience: build a result object with standard fields.
   * @private
   */
  function _result(status, extra) {
    return Object.assign(
      {
        status,
        label:              STATUS_LABELS[status] || status,
        provider_namespace: null,
        matched_route_key:  null,
        matched_versions:   null,
        matched_version:    null,
        available_methods:  null,
        shard_name:         null,
        reason:             null,
        error:              null,
      },
      extra
    );
  }

  // Export
  exports.Matcher = {
    classify,
    matchAgainstShard,
    inferProviderNamespace,
    isArmRootPath,
    buildRouteKey,
    normalisePlaceholders:  _normalisePlaceholders,
    canonicaliseRouteKey:   _canonicaliseRouteKey,
    normaliseNamePositions: _normaliseNamePositions,
    STATUS,
    STATUS_LABELS,
  };

}(typeof window !== "undefined" ? window : exports));
