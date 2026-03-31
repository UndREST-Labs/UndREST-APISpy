// devtools.js — registers the APISpy DevTools panel
// Runs in the DevTools context (devtools_page).

"use strict";

chrome.devtools.panels.create(
  "APISpy",           // panel title shown in DevTools tab bar
  "icons/icon16.png", // icon shown next to the tab
  "panel.html",       // the panel page
  function (panel) {
    // panel is a chrome.devtools.panels.ExtensionPanel
    // Future: attach panel shown/hidden listeners here if needed
    void panel;
  }
);

// ── Sweep-mode network capture ────────────────────────────────────────────────
// Chrome lazy-loads the DevTools panel page (panel.html) only when the user
// first clicks the "APISpy" tab.  During automated Playwright sweeps the panel
// is never clicked, so the onRequestFinished listener in panel.js never fires.
//
// This always-active listener in the devtools_page (which loads immediately
// when DevTools opens) bridges that gap.  When sweep mode is active it
// processes each ARM request through the full Normalizer/Matcher/Loader
// pipeline — exactly the same way panel.js processes requests in normal use —
// and stores the compact results to localStorage under "apispy_sweep_entries".
//
// Standalone panel.html reads "apispy_sweep_entries" at startup, assigns row
// indices, renders the rows synchronously, and saveCSV() exports the result.
// No async shard loading needed at restore time because all matching is done
// here as requests arrive.

// In-memory buffer of processed entries — written to localStorage after each
// entry so the data is always up-to-date without O(n^2) read/parse overhead.
const _sweepBuffer = [];

// Kick off enrichment data load — optional; failure is silently ignored.
if (typeof AzureEnrichment !== "undefined") {
  AzureEnrichment.load().catch(() => {});
}

function _flushSweepBuffer() {
  try {
    localStorage.setItem("apispy_sweep_entries", JSON.stringify(_sweepBuffer));
  } catch (_) {
    // localStorage quota exceeded — the last successful write is still valid.
  }
}

/**
 * Build and store a compact processed entry for a single ARM request.
 * Mirrors the logic in panel.js's onRequestFinished / buildEntry.
 *
 * @param {object} req   HAR-style request object (from onRequestFinished or synthetic).
 * @param {boolean} [isBatchSub]  True when this is a batch sub-request.
 * @param {string|null} [batchName]  Sub-request name/index within the batch.
 */
async function _processSweepRequest(req, isBatchSub, batchName) {
  const url    = req.request && req.request.url;
  const method = req.request && req.request.method;
  if (!url) return;

  // Filter to management.azure.com — the ARM control-plane endpoint.
  try {
    if (new URL(url).hostname.toLowerCase() !== "management.azure.com") return;
  } catch (_) {
    return;
  }

  const time  = req.startedDateTime
    ? new Date(req.startedDateTime).toLocaleTimeString()
    : "--:--:--";

  const scope = Filters.classifyScope(url);
  const norm  = Normalizer.normalise(url, method);

  let result;
  if (!scope.inScope) {
    result = Matcher.classify(norm, null, { inScope: false });
  } else if (!norm.ok) {
    result = Matcher.classify(norm, null, { inScope: true });
  } else {
    const ns = Matcher.inferProviderNamespace(norm.pathname);
    let shard = null;
    let shardLoadError = null;
    if (ns) {
      try {
        shard = await Loader.loadShard(ns);
      } catch (err) {
        shardLoadError = err && err.message ? err.message : String(err);
      }
    }
    result = Matcher.classify(norm, shard, { inScope: true, shardLoadError });
  }

  // Optional Azure enrichment (only when loaded — graceful fallback otherwise)
  let enrichment = null;
  let enrichmentConfidence = null;
  let enrichmentParts = null;
  if (typeof AzureEnrichment !== "undefined" && AzureEnrichment.isLoaded()) {
    try {
      const em = AzureEnrichment.matchRequest(norm);
      if (em) {
        enrichment = em.record;
        enrichmentConfidence = em.confidence;
        enrichmentParts = em.parts;
        // Promote status when no exact/version match but enrichment is confident
        const promotable = result.status === Matcher.STATUS.PROVIDER_KNOWN_NO_ROUTE ||
                           result.status === Matcher.STATUS.NO_SPEC_MATCH;
        if (promotable && (enrichmentConfidence === "high" || enrichmentConfidence === "medium")) {
          result.status = Matcher.STATUS.PROVIDER_KNOWN;
          result.label  = Matcher.STATUS_LABELS[Matcher.STATUS.PROVIDER_KNOWN];
        }
      }
    } catch (_) { /* enrichment is optional */ }
  }

  // Only store entries where a provider namespace was identified, or ARM root
  // routes — same filter as panel.js's onRequestFinished.
  if (result.provider_namespace === null && result.status !== Matcher.STATUS.ARM_ROOT_ROUTE) {
    return;
  }

  const entry = {
    time,
    url,
    method:     norm.ok ? norm.method        : (method || "?").toUpperCase(),
    host:       norm.ok ? norm.host          : "?",
    pathname:   norm.ok ? norm.pathname      : "?",
    normPath:   norm.ok ? norm.normalisedPath : "?",
    apiVersion: norm.ok ? norm.apiVersion   : null,
    isBatchSub: isBatchSub || false,
    batchName:  batchName  != null ? String(batchName) : null,
    result: {
      status:             result.status,
      reason:             result.reason             || null,
      label:              result.label              || null,
      provider_namespace: result.provider_namespace || null,
      matched_route_key:  result.matched_route_key  || null,
      matched_versions:   result.matched_versions   || null,
      shard_name:         result.shard_name         || null,
      error:              result.error              || null,
      enrichment:           enrichment,
      enrichmentConfidence: enrichmentConfidence,
      enrichmentParts:      enrichmentParts,
    },
  };

  _sweepBuffer.push(entry);
  _flushSweepBuffer();
}

/**
 * Expand an ARM batch request body into individual sub-request entries.
 * Mirrors panel.js's expandBatchSubRequests.
 *
 * @param {object} req  The parent batch request (HAR-style).
 */
async function _expandBatchSubRequests(req) {
  const bodyText = req.request && req.request.postData && req.request.postData.text;
  if (!bodyText) return;

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (_) {
    return;
  }

  const subRequests = Array.isArray(body.requests) ? body.requests : [];
  for (const sub of subRequests) {
    const subUrl    = sub.url || sub.Url || sub.URL;
    const subMethod = sub.httpMethod || sub.method || "GET";
    if (!subUrl) continue;

    const syntheticReq = {
      startedDateTime: req.startedDateTime,
      request: { url: subUrl, method: subMethod, postData: null },
    };

    const subName = sub.name != null ? String(sub.name) : null;
    await _processSweepRequest(syntheticReq, true, subName);
  }
}

if (chrome.devtools && chrome.devtools.network) {
  chrome.devtools.network.onRequestFinished.addListener(async function (req) {
    // Only active during an automated portal sweep.
    if (localStorage.getItem("apispy_sweep_mode") !== "1") return;

    try {
      await _processSweepRequest(req, false, null);

      // Expand ARM batch requests after the parent entry is stored.
      const url    = req.request && req.request.url;
      const method = req.request && req.request.method;
      if (url && method && Filters.isBatchRequest(url, method)) {
        await _expandBatchSubRequests(req);
      }
    } catch (_) {
      // Silently ignore per-entry errors — don't let one bad request
      // stop the listener from processing subsequent requests.
    }
  });
}