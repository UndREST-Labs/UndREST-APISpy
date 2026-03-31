// lib/azure-enrichment.js — Azure pack enrichment layer for APISpy
//
// Loads a local provider-operation intelligence dataset derived from
// scripts/provider_ops_sweep.py output (via scripts/prepare_provider_ops.py)
// and uses it to enrich Azure ARM requests that did not get an exact spec match.
//
// Architecture
// ────────────
// This module is Azure-specific and intentionally isolated from the generic
// extension machinery (filters.js, normalizer.js, matcher.js).  It is only
// loaded when the Azure pack is active, and all enrichment logic is contained
// here so the rest of the extension stays pack-agnostic.
//
// Data file
// ─────────
// Enrichment data lives in extension/data/azure-provider-ops.json.
// This file is optional — if it is absent the module resolves to "not loaded"
// and the extension falls back to its existing classification behaviour.
// Generate the file with:
//   python scripts/provider_ops_sweep.py   (produces azure-provider-operations-<ts>.json)
//   python scripts/prepare_provider_ops.py (produces extension/data/azure-provider-ops.json)
//
// Lookup key format
// ─────────────────
// Records are indexed by:   provider_lower|resourcePath_lower|actionName_lower
// e.g. "microsoft.web|connections|dynamicinvoke"
//
// matchRequest() tries four keys in decreasing specificity:
//   1. provider|full_resourcePath|actionName       → high confidence
//   2. provider|primaryResourceType|actionName      → high confidence
//   3. provider|full_resourcePath|suffixKind        → medium confidence
//   4. provider|primaryResourceType|suffixKind      → medium confidence
//
// Only high and medium results are returned; low-confidence hits are discarded.
//
// Confidence → status promotion (in panel.js)
// ────────────────────────────────────────────
// If matchRequest() returns a high- or medium-confidence result AND the existing
// classification status is provider_known_route_unknown or no_spec_match, the
// status is upgraded to "provider_known".  Exact matches and version-mismatch
// results are never downgraded.

"use strict";

(function (exports) {

  // URL is resolved at runtime so this module works in the browser extension
  // (chrome.runtime.getURL) and gracefully degrades in test environments.
  const ENRICHMENT_URL = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL("data/azure-provider-ops.json")
    : null;

  /** Promise returned by load() — cached after the first call. */
  let _loadPromise = null;

  /**
   * In-memory index: key → enrichment record.
   * null  = data not yet loaded (or load not attempted).
   * {}    = loaded but empty (no records in data file).
   * {...} = loaded and populated.
   */
  let _index = null;

  /** True once load() has been called, regardless of outcome. */
  let _loadAttempted = false;

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Load and index the enrichment dataset.
   *
   * Safe to call multiple times — the Promise is cached after the first call.
   * Resolves to true when data was loaded successfully, false otherwise (file
   * absent, malformed JSON, etc.).
   *
   * @returns {Promise<boolean>}
   */
  function load() {
    if (_loadPromise) return _loadPromise;
    _loadAttempted = true;

    if (!ENRICHMENT_URL) {
      // Not running in a browser extension context (e.g. unit tests).
      _loadPromise = Promise.resolve(false);
      return _loadPromise;
    }

    _loadPromise = fetch(ENRICHMENT_URL)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || typeof data.byKey !== "object") return false;
        _index = data.byKey;
        return true;
      })
      .catch(function () {
        // File absent or JSON parse error — gracefully stay unloaded.
        return false;
      });

    return _loadPromise;
  }

  /**
   * Returns true when enrichment data has been loaded and indexed.
   * @returns {boolean}
   */
  function isLoaded() {
    return _index !== null;
  }

  /**
   * Returns true once load() has been called (regardless of outcome).
   * Used by diagnostics to distinguish "not attempted" from "attempted but missing".
   * @returns {boolean}
   */
  function wasAttempted() {
    return _loadAttempted;
  }

  // ── Request inference ─────────────────────────────────────────────────────

  /**
   * Infer Azure ARM request structure from a normalised request object.
   *
   * Extracts:
   *   provider            — Azure provider namespace (last /providers/X.Y occurrence)
   *   primaryResourceType — first type segment after the provider
   *   resourcePath        — full type-segment path (slash-joined, no {name} slots)
   *   actionName          — action verb for POST actions; suffixKind for CRUD
   *   suffixKind          — "read" | "write" | "delete" | "action"
   *   candidateMethod     — HTTP method as uppercase string
   *
   * ARM normalisation has already replaced resource-name slots with {name} in
   * norm.armPath, so filtering out {name} leaves only the type-position segments.
   *
   * Returns an object with providerInferred: false when no provider was found,
   * or resourcePathInferred: false when the path after the provider is empty.
   *
   * @param {object} norm  Output of Normalizer.normalise().
   * @returns {object|null}  Inferred parts, or null for non-ARM requests.
   */
  function inferRequestParts(norm) {
    if (!norm || !norm.ok) return null;

    const path = norm.armPath || norm.normalisedPath;
    if (!path) return null;

    // Find the LAST /providers/Namespace occurrence (extension resources use
    // the final provider segment, not the first — same logic as matcher.js).
    const provRe = /\/providers\/([A-Za-z][A-Za-z0-9]*\.[A-Za-z0-9.]+?)(?:\/|$)/g;
    let lastMatch = null;
    let m;
    while ((m = provRe.exec(path)) !== null) { lastMatch = m; }

    if (!lastMatch) {
      return { providerInferred: false, resourcePathInferred: false, actionInferred: false };
    }

    const provider       = lastMatch[1];
    const afterProvider  = path.slice(lastMatch.index + "/providers/".length + provider.length);

    if (!afterProvider || afterProvider === "/") {
      return { providerInferred: true, provider, resourcePathInferred: false, actionInferred: false };
    }

    // Split the path after the provider and strip placeholder segments.
    // ARM normalization has already produced {name} at every resource-name
    // position, so the remaining literals are all type-position segments.
    const typeSegs = afterProvider.split("/").filter(function (s) {
      return s && s !== "{name}" && s !== "{guid}" && s !== "{id}";
    });

    if (typeSegs.length === 0) {
      return { providerInferred: true, provider, resourcePathInferred: false, actionInferred: false };
    }

    const method            = (norm.method || "GET").toUpperCase();
    const candidateMethod   = method;
    const primaryResourceType = typeSegs[0];

    let suffixKind, actionName, resourcePath;

    if (method === "GET" || method === "HEAD") {
      suffixKind   = "read";
      actionName   = "read";
      resourcePath = typeSegs.join("/");
    } else if (method === "DELETE") {
      suffixKind   = "delete";
      actionName   = "delete";
      resourcePath = typeSegs.join("/");
    } else if (method === "PUT" || method === "PATCH") {
      suffixKind   = "write";
      actionName   = "write";
      resourcePath = typeSegs.join("/");
    } else if (method === "POST") {
      // POST with more than one type segment: the last segment is most likely
      // an action verb (e.g. "dynamicInvoke", "listKeys", "regenerateKey").
      if (typeSegs.length > 1) {
        suffixKind   = "action";
        actionName   = typeSegs[typeSegs.length - 1];
        resourcePath = typeSegs.slice(0, -1).join("/");
      } else {
        // Single-segment POST — treat as write (e.g. resource creation).
        suffixKind   = "write";
        actionName   = "write";
        resourcePath = typeSegs[0];
      }
    } else {
      suffixKind   = "action";
      actionName   = typeSegs[typeSegs.length - 1] || "action";
      resourcePath = typeSegs.length > 1 ? typeSegs.slice(0, -1).join("/") : typeSegs[0];
    }

    return {
      providerInferred:     true,
      provider,
      primaryResourceType,
      resourcePath:         resourcePath || primaryResourceType,
      actionName,
      suffixKind,
      candidateMethod,
      resourcePathInferred: true,
      actionInferred:       suffixKind === "action" && typeSegs.length > 1,
    };
  }

  // ── Enrichment lookup ─────────────────────────────────────────────────────

  /**
   * Look up enrichment data for a normalised request.
   *
   * Returns { enrichment, confidence: "high"|"medium", parts } when a match
   * is found at high or medium confidence, or null otherwise.
   *
   * Only high/medium confidence results are returned so that callers can safely
   * promote the request status to "provider_known" without false positives.
   *
   * @param {object} norm  Output of Normalizer.normalise().
   * @returns {{ enrichment: object, confidence: string, parts: object }|null}
   */
  function matchRequest(norm) {
    if (!_index) return null;

    const parts = inferRequestParts(norm);
    if (!parts || !parts.providerInferred || !parts.resourcePathInferred) return null;

    const pLow  = parts.provider.toLowerCase();
    const rpLow = parts.resourcePath.toLowerCase();
    const ptLow = parts.primaryResourceType.toLowerCase();
    const anLow = parts.actionName.toLowerCase();
    const sk    = parts.suffixKind;

    // 1. High confidence: exact provider + full resourcePath + actionName
    var entry = _index[pLow + "|" + rpLow + "|" + anLow];
    if (entry) return { enrichment: entry, confidence: "high", parts: parts };

    // 2. High confidence: provider + primaryResourceType (shorter path) + actionName
    if (ptLow !== rpLow) {
      entry = _index[pLow + "|" + ptLow + "|" + anLow];
      if (entry) return { enrichment: entry, confidence: "high", parts: parts };
    }

    // 3. Medium confidence: provider + full resourcePath + suffixKind
    entry = _index[pLow + "|" + rpLow + "|" + sk];
    if (entry) return { enrichment: entry, confidence: "medium", parts: parts };

    // 4. Medium confidence: provider + primaryResourceType + suffixKind
    if (ptLow !== rpLow) {
      entry = _index[pLow + "|" + ptLow + "|" + sk];
      if (entry) return { enrichment: entry, confidence: "medium", parts: parts };
    }

    return null;
  }

  // ── Export ────────────────────────────────────────────────────────────────

  exports.AzureEnrichment = {
    load,
    isLoaded,
    wasAttempted,
    inferRequestParts,
    matchRequest,
  };

}(typeof window !== "undefined" ? window : exports));
