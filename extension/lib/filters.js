// lib/filters.js — in-scope heuristics for APISpy
// Determines whether a network request is worth inspecting against the index.
// All logic is intentionally explicit and easy to extend.

"use strict";

(function (exports) {

  // Hostnames that are always considered in-scope.
  // Exact match (case-insensitive).
  const EXACT_HOSTS = new Set([
    "management.azure.com",
    "graph.microsoft.com",
    "login.microsoftonline.com",
    "login.windows.net",
    "graph.windows.net",
    "api.loganalytics.io",
    "api.applicationinsights.io",
  ]);

  // Host suffixes that indicate in-scope traffic.
  // If the hostname ends with one of these, it is considered in-scope.
  const HOST_SUFFIXES = [
    ".management.azure.com",
    ".azure.com",
    ".microsoft.com",
    ".microsoftonline.com",
    ".windows.net",
    ".azure.net",
    ".azure-api.net",
  ];

  // URL path prefixes that are strong indicators this is an Azure RM call.
  const PATH_PREFIXES = [
    "/subscriptions/",
    "/providers/Microsoft.",
    "/providers/microsoft.",
    "/tenants/",
  ];

  /**
   * Returns true if the hostname looks like an Azure/Microsoft API host.
   * @param {string} host  Lower-case hostname (no port).
   * @returns {boolean}
   */
  function isInScopeHost(host) {
    if (!host) return false;
    const lower = host.toLowerCase();
    if (EXACT_HOSTS.has(lower)) return true;
    for (const suffix of HOST_SUFFIXES) {
      if (lower.endsWith(suffix)) return true;
    }
    return false;
  }

  /**
   * Returns true if the URL path looks like an Azure/Microsoft API path.
   * Used as a secondary signal when the host alone is ambiguous.
   * @param {string} path  URL path (may include query string).
   * @returns {boolean}
   */
  function isInScopePath(path) {
    if (!path) return false;
    for (const prefix of PATH_PREFIXES) {
      if (path.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * Decides whether a request (given its URL string) is in scope for APISpy.
   * @param {string} url  Full request URL.
   * @returns {{ inScope: boolean, reason: string }}
   */
  function classifyScope(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return { inScope: false, reason: "unparseable_url" };
    }

    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname;

    if (isInScopeHost(host)) {
      return { inScope: true, reason: "host_match" };
    }
    if (isInScopePath(path)) {
      return { inScope: true, reason: "path_match" };
    }
    return { inScope: false, reason: "not_azure_microsoft" };
  }

  /**
   * Returns true if this is an ARM batch request (POST to management.azure.com/batch).
   * When detected, the request body should be inspected to extract sub-requests.
   * @param {string} url     Full request URL.
   * @param {string} method  HTTP method.
   * @returns {boolean}
   */
  function isBatchRequest(url, method) {
    if (!url || (method || "").toUpperCase() !== "POST") return false;
    try {
      const parsed = new URL(url);
      return (
        parsed.hostname.toLowerCase() === "management.azure.com" &&
        parsed.pathname === "/batch"
      );
    } catch (_) {
      return false;
    }
  }

  // Export
  exports.Filters = {
    isInScopeHost,
    isInScopePath,
    classifyScope,
    isBatchRequest,
    // Expose lists for testing / extension
    EXACT_HOSTS,
    HOST_SUFFIXES,
    PATH_PREFIXES,
  };

}(typeof window !== "undefined" ? window : exports));
