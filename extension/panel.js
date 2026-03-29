// panel.js — APISpy DevTools Panel main script
// Wires together: network observation, filtering, normalisation, matching, and UI.

"use strict";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * All status values that can appear in the table.
 * `out_of_scope` and requests with no inferred provider are never recorded,
 * so only provider-matched statuses are listed here.
 */
const ALL_STATUSES = Object.freeze([
  "exact_match",
  "route_match_version_mismatch",
  "provider_known_route_unknown",
  "no_spec_match",
  "arm_root_route",
]);

const DEFAULT_DETAIL_HEIGHT = 220; // px

/** CSV column headers (must match entryToCsvRow order). */
const CSV_HEADER = [
  "Time", "URL", "Batch Sub", "Batch Name", "Method", "Host", "Path",
  "Normalised Path", "api-version", "Status", "Reason",
  "Provider Namespace", "Matched Route", "Available Versions", "Shard", "Load Error",
].join(",");

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  /** @type {Array<RequestEntry>} All observed requests. */
  requests: [],
  /**
   * Set of status values currently visible.
   * An entry is shown when its status is in this set.
   * @type {Set<string>}
   */
  activeFilters: new Set(ALL_STATUSES),
  /**
   * Per-column filter sets.  null = no filter (all values shown).
   * When a Set is present only entries whose column value is in the Set are shown.
   * @type {Object.<string, Set<string>|null>}
   */
  columnFilters: {
    method:     null,
    apiVersion: null,
    status:     null,
    reason:     null,
    shard:      null,
  },
  /** @type {number|null} Index of the selected row (for detail panel). */
  selectedIdx: null,
  /** @type {boolean} Whether newly added rows should be scrolled into view. */
  autoscroll: true,
  /** @type {number} Current height of the detail panel in px. */
  detailHeight: DEFAULT_DETAIL_HEIGHT,
};

// ── DOM refs ─────────────────────────────────────────────────────────────────

const tbody          = document.getElementById("request-tbody");
const statusText     = document.getElementById("status-text");
const requestCount   = document.getElementById("request-count");
const filterGroup    = document.getElementById("filter-group");
const btnClear       = document.getElementById("btn-clear");
const btnAutoscroll  = document.getElementById("btn-autoscroll");
const btnPacks       = document.getElementById("btn-packs");
const btnCopyAll     = document.getElementById("btn-copy-all");
const btnCsv         = document.getElementById("btn-csv");
const emptyState     = document.getElementById("empty-state");
const detailPanel    = document.getElementById("detail-panel");
const detailResizer  = document.getElementById("detail-resizer");
const detailClose    = document.getElementById("detail-close");
const detailCopy     = document.getElementById("detail-copy");
const detailNetwork  = document.getElementById("detail-find-network");
const detailFields   = document.getElementById("detail-fields");
const detailHeading  = document.getElementById("detail-heading");
const colFilterDropdown  = document.getElementById("col-filter-dropdown");
const colFilterSelectAll = document.getElementById("col-filter-select-all");
const colFilterList      = document.getElementById("col-filter-list");
const packDialog         = document.getElementById("pack-dialog");
const packList           = document.getElementById("pack-list");
const packDialogClose    = document.getElementById("pack-dialog-close");
const packApply          = document.getElementById("pack-apply");
const packCancel         = document.getElementById("pack-cancel");

// ── Initialisation ────────────────────────────────────────────────────────────

async function init() {
  setStatus("Loading index...");

  try {
    const packs     = await Loader.listBundledPacks();
    const providers = await Loader.listBundledProviders();
    // Build a status line that mentions pack counts when multiple packs exist.
    if (packs.length === 1) {
      const meta  = packs[0].source_metadata || {};
      const stamp = meta.generated_at ? new Date(meta.generated_at).toLocaleDateString() : "unknown";
      setStatus(providers.length + " providers bundled (export " + stamp + ")");
    } else {
      const enabledIds = Loader.getEnabledPackIds();
      const enabledCount = enabledIds ? packs.filter((p) => enabledIds.has(p.pack_id)).length : packs.length;
      setStatus(providers.length + " providers from " + enabledCount + "/" + packs.length + " packs");
    }
  } catch (err) {
    setStatus("Failed to load data manifest: " + err.message);
  }

  updateTbodyHeight();

  // In standalone mode (opened as a normal page, not inside DevTools), restore
  // previously captured requests from localStorage so saveCSV() has data to export.
  // Check the explicit flag set by the Playwright script via add_init_script; fall back
  // to the chrome.devtools heuristic for normal DevTools usage.
  const standaloneFlag = localStorage.getItem("apispy_standalone_mode") === "1";
  const inDevTools = !standaloneFlag && typeof chrome !== "undefined" && !!(chrome.devtools && chrome.devtools.network);
  if (!inDevTools) {
    // Primary path: render pre-processed entries stored by devtools.js during
    // the sweep.  All Normalizer/Matcher/shard work was already done at capture
    // time (one request at a time as they arrived), so this is synchronous.
    try {
      _restoreFromProcessedEntries();
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error("[APISpy] restore failed:", msg);
      setStatus("Restore error: " + msg);
    }
    // Fallback: restore already-processed entries from the legacy key written
    // by panel.js when it was running live inside DevTools.
    if (state.requests.length === 0) {
      _restoreFromStorage();
    }
    // Signal to the Playwright sweep script that restore is complete.
    // This is set unconditionally (even on error) so the poll always resolves.
    _restoreComplete = true;
  }

  attachNetworkObserver();
  attachUIListeners();
}

// ── Layout / sizing ───────────────────────────────────────────────────────────

/**
 * Recalculate and apply the tbody height so it fills the space above the
 * detail panel (or all remaining space when the panel is hidden).
 */
function updateTbodyHeight() {
  const toolbarEl = document.querySelector(".toolbar");
  const theadEl   = document.querySelector(".request-table thead");
  const toolbarH  = toolbarEl ? toolbarEl.offsetHeight : 42;
  const theadH    = theadEl   ? theadEl.offsetHeight   : 28;
  const detailH   = detailPanel.classList.contains("hidden") ? 0 : state.detailHeight;
  const hasRows   = tbody.children.length > 0;
  tbody.style.height = hasRows
    ? Math.max(60, window.innerHeight - toolbarH - theadH - detailH) + "px"
    : "0px";
}

/**
 * Set to true once the standalone-mode restore has finished (even when 0
 * requests were captured).  The Playwright sweep script polls this flag
 * instead of polling state.requests.length so it can tell "still loading"
 * from "genuinely empty".
 */
let _restoreComplete = false;

// ── localStorage persistence (for automated CSV export) ───────────────────────

/**
 * Persist state.requests to localStorage so a standalone panel.html page can
 * read and export the data after a Playwright sweep without needing DevTools.
 * Only active when the sweep script has set the `apispy_sweep_mode` flag.
 */
function _persistRequests() {
  if (localStorage.getItem("apispy_sweep_mode") !== "1") return;
  try {
    localStorage.setItem("apispy_requests", JSON.stringify(state.requests));
  } catch (_) {
    // Quota exceeded or private-browsing restrictions — silently ignore.
  }
}

/**
 * Restore requests from localStorage into state and re-render the table.
 * Only called when the panel is opened in standalone mode (not inside DevTools).
 * This is the legacy path for the old "apispy_requests" key (already-processed
 * entries written by panel.js when it was running live inside DevTools).
 */
function _restoreFromStorage() {
  try {
    const raw = localStorage.getItem("apispy_requests");
    if (!raw) return;
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length === 0) return;
    entries.forEach((entry, i) => {
      state.requests.push(entry);
      renderRow(entry, i);
    });
    updateCountBadge();
    setStatus("Restored " + entries.length + " captured request(s) from previous sweep.");
  } catch (_) {
    // Corrupt data — ignore.
  }
}

/**
 * Read the pre-processed ARM entries stored by devtools.js during the sweep
 * and render them into the table synchronously.
 *
 * devtools.js processes each request through the full Normalizer/Matcher/Loader
 * pipeline as it arrives and writes compact entries to "apispy_sweep_entries".
 * There is no async shard loading needed here — all matching is already done.
 */
function _restoreFromProcessedEntries() {
  let entries;
  try {
    const stored = localStorage.getItem("apispy_sweep_entries");
    if (!stored) return;
    entries = JSON.parse(stored);
    if (!Array.isArray(entries) || entries.length === 0) return;
  } catch (_) {
    return;
  }

  setStatus("Restoring " + entries.length + " captured entry(s)…");

  entries.forEach((entry, i) => {
    // Assign a fresh sequential index for this panel session.
    entry.idx = i;
    state.requests.push(entry);
    renderRow(entry, i);
  });

  updateCountBadge();

  if (state.requests.length > 0) {
    setStatus("Restored " + state.requests.length + " entry(s) from sweep.");
  }
}

// ── Network observation ───────────────────────────────────────────────────────

function attachNetworkObserver() {
  // Guard: chrome.devtools is only available when running inside Chrome DevTools.
  // When panel.html is opened as a standalone page (for CSV export automation),
  // this API is absent and we skip the listener registration.
  if (typeof chrome === "undefined" || !chrome.devtools || !chrome.devtools.network) {
    return;
  }
  chrome.devtools.network.onRequestFinished.addListener(onRequestFinished);
}

/**
 * Called by the DevTools network observer for each finished request.
 * @param {chrome.devtools.network.Request} req
 */
async function onRequestFinished(req) {
  const url    = req.request && req.request.url;
  const method = req.request && req.request.method;
  if (!url) return;

  const scope = Filters.classifyScope(url);
  const norm = Normalizer.normalise(url, method);
  const entry = await buildEntry(req, norm, scope);

  // Record entries where a provider namespace was identified, or entries for
  // ARM root routes (valid ARM endpoints with no provider namespace such as
  // /subscriptions or /tenants).  Skip out-of-scope and no-spec-match entries.
  if (entry.result.provider_namespace !== null ||
      entry.result.status === Matcher.STATUS.ARM_ROOT_ROUTE) {
    state.requests.push(entry);
    renderRow(entry, state.requests.length - 1);
    updateCountBadge();
    _persistRequests();
  }

  // Always expand ARM batch requests even if the parent row was filtered out.
  if (Filters.isBatchRequest(url, method)) {
    await expandBatchSubRequests(req);
  }
}

/**
 * Parse an ARM batch request body and add a row for each contained sub-request.
 * Sub-request bodies are read from req.request.postData.text.
 * @param {object} req  HAR-style request object.
 */
async function expandBatchSubRequests(req) {
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
    const subUrl    = sub.url    || sub.Url    || sub.URL;
    const subMethod = sub.httpMethod || sub.method || "GET";
    if (!subUrl) continue;

    // Build a minimal synthetic HAR-like object so buildEntry can process it.
    const syntheticReq = {
      startedDateTime: req.startedDateTime,
      request: { url: subUrl, method: subMethod, postData: null },
    };

    const scope = Filters.classifyScope(subUrl);
    const norm  = Normalizer.normalise(subUrl, subMethod);
    const entry = await buildEntry(syntheticReq, norm, scope);
    entry.isBatchSub = true;
    entry.batchName  = sub.name != null ? String(sub.name) : null;

    if (entry.result.provider_namespace === null) continue;

    state.requests.push(entry);
    renderRow(entry, state.requests.length - 1);
    updateCountBadge();
    _persistRequests();
  }
}

/**
 * @typedef {object} RequestEntry
 * @property {number}  idx
 * @property {string}  time
 * @property {string|null} url  Full original request URL (for deep-linking).
 * @property {string}  method
 * @property {string}  host
 * @property {string}  pathname
 * @property {string|null} apiVersion
 * @property {boolean} [isBatchSub]  True when this row originated from a batch sub-request.
 * @property {string|null} [batchName]  Name/index of the sub-request within the batch.
 * @property {object}  norm
 * @property {object}  result
 * @property {object}  raw
 */

/**
 * Build a full RequestEntry from a finished network request.
 * @param {object} req  HAR-style request object from DevTools.
 * @param {object} norm  Output of Normalizer.normalise().
 * @param {object} scope  Output of Filters.classifyScope().
 * @returns {Promise<RequestEntry>}
 */
async function buildEntry(req, norm, scope) {
  const idx = state.requests.length;
  const time = req.startedDateTime
    ? new Date(req.startedDateTime).toLocaleTimeString()
    : "--:--:--";

  let result;
  if (!scope.inScope) {
    result = Matcher.classify(norm, null, { inScope: false });
  } else if (!norm.ok) {
    result = Matcher.classify(norm, null, { inScope: true });
  } else {
    // Infer provider namespace and load shard lazily
    const ns = Matcher.inferProviderNamespace(norm.pathname);
    let shard = null;
    let shardLoadError = null;
    if (ns) {
      try {
        shard = await Loader.loadShard(ns);
      } catch (err) {
        shardLoadError = err && err.message ? err.message : String(err);
        shard = null;
      }
    }
    result = Matcher.classify(norm, shard, { inScope: true, shardLoadError });
  }

  return {
    idx,
    time,
    url:        (req.request && req.request.url) || null,
    method:     norm.ok ? norm.method : (req.request && req.request.method || "?").toUpperCase(),
    host:       norm.ok ? norm.host : "?",
    pathname:   norm.ok ? norm.pathname : "?",
    normPath:   norm.ok ? norm.normalisedPath : "?",
    apiVersion: norm.ok ? norm.apiVersion : null,
    norm,
    result,
    raw: req,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Append a single table row for an entry.
 * @param {RequestEntry} entry
 * @param {number} idx
 */
function renderRow(entry, idx) {
  if (!passesFilter(entry)) return;

  const tr = document.createElement("tr");
  tr.dataset.idx = idx;
  tr.setAttribute("role", "button");
  tr.setAttribute("tabindex", "0");
  tr.setAttribute("aria-label", entry.method + " " + entry.pathname);
  if (entry.isBatchSub) tr.classList.add("batch-sub");

  tr.innerHTML = [
    cell(entry.time,                              "col-time"),
    methodCell(entry.method),
    cell(entry.host,                              "col-host"),
    batchPathCell(entry),
    cell(entry.apiVersion || "",                  "col-version"),
    statusCell(entry.result),
    cell(entry.result.reason || "",               "col-reason"),
    cell(entry.result.shard_name || "",           "col-shard"),
  ].join("");

  tr.addEventListener("click", () => selectRow(idx, tr));
  tr.addEventListener("keydown", (e) => { if (e.key === "Enter") selectRow(idx, tr); });
  tbody.appendChild(tr);

  if (state.autoscroll) {
    tbody.scrollTop = tbody.scrollHeight;
  }

  toggleEmptyState();
}

function cell(text, cls) {
  const safe = escHtml(text);
  return `<td class="${cls}" title="${safe}">${safe}</td>`;
}

/**
 * Render the path cell, prefixing batch sub-requests with a visual indicator.
 * @param {RequestEntry} entry
 * @returns {string}
 */
function batchPathCell(entry) {
  const safe = escHtml(entry.pathname);
  if (entry.isBatchSub) {
    const name = entry.batchName != null ? " [" + escHtml(entry.batchName) + "]" : "";
    return `<td class="col-path" title="${safe}"><span class="batch-sub-indicator">&#x21B3;</span>${safe}${name}</td>`;
  }
  return `<td class="col-path" title="${safe}">${safe}</td>`;
}

function methodCell(method) {
  const cls = "method-badge method-" + escHtml(method);
  return `<td class="col-method"><span class="${cls}">${escHtml(method)}</span></td>`;
}

function statusCell(result) {
  const status = result.status;
  const label  = escHtml(result.label || status);
  return `<td class="col-status"><span class="status-badge status-${escHtml(status)}">${label}</span></td>`;
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Re-render the table from scratch applying current filter. */
function rerender() {
  tbody.innerHTML = "";
  state.requests.forEach((entry, idx) => renderRow(entry, idx));
  toggleEmptyState();
  updateCountBadge();
}

function toggleEmptyState() {
  const hasRows = tbody.children.length > 0;
  emptyState.classList.toggle("hidden", hasRows);
  updateTbodyHeight();
}

function updateCountBadge() {
  const total   = state.requests.length;
  const visible = state.requests.filter(passesFilter).length;
  if (visible === total) {
    requestCount.textContent = total;
  } else {
    requestCount.textContent = visible + " / " + total;
  }
}

function setStatus(msg) {
  statusText.textContent = msg;
}

/** Temporarily show a message in the status bar, then restore the previous text. */
let _flashTimer = null;
let _flashBaseText = null;
function flashStatus(msg, durationMs) {
  // Capture the base text only on the first call (not mid-flash).
  if (!_flashTimer) {
    _flashBaseText = statusText.textContent;
  } else {
    clearTimeout(_flashTimer);
  }
  statusText.textContent = msg;
  _flashTimer = setTimeout(() => {
    statusText.textContent = _flashBaseText;
    _flashTimer = null;
    _flashBaseText = null;
  }, durationMs || 3000);
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function selectRow(idx, tr) {
  // Deselect previous
  tbody.querySelectorAll("tr.selected").forEach((r) => r.classList.remove("selected"));
  tr.classList.add("selected");
  state.selectedIdx = idx;
  showDetail(state.requests[idx]);
}

function showDetail(entry) {
  const r = entry.result;
  const heading = (entry.isBatchSub ? "[batch] " : "") + entry.method + " " + entry.host + entry.pathname;
  detailHeading.textContent = heading;
  detailFields.innerHTML = "";

  // Fields: [label, value, cssClass?, isLink?]
  const fields = [
    ["URL",                 entry.url || "",                             "url-field", true],
    ["Time",                entry.time],
    ...(entry.isBatchSub ? [["Batch sub-request", entry.batchName != null ? "#" + entry.batchName : "yes"]] : []),
    ["Method",              entry.method],
    ["Host",                entry.host],
    ["Path",                entry.pathname],
    ["Normalised path",     entry.normPath],
    ["api-version",         entry.apiVersion || ""],
    ["Status",              r.label || r.status, "status-text"],
    ["Provider namespace",  r.provider_namespace || ""],
    ["Matched route",       r.matched_route_key || ""],
    ["Available versions",  (r.matched_versions && r.matched_versions.join(", ")) || ""],
    ...(r.available_methods ? [["Available methods", r.available_methods.join(", ")]] : []),
    ["Shard / source",      r.shard_name || ""],
    ["Reason",              r.reason || ""],
    ...(r.error ? [["Load error", r.error, "load-error"]] : []),
  ];

  fields.forEach(([label, value, extraClass, isLink]) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    if (isLink && value) {
      const a = document.createElement("a");
      a.href = value;
      a.textContent = value;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      dd.appendChild(a);
    } else {
      dd.textContent = value;
    }
    if (extraClass) dd.classList.add(extraClass);
    detailFields.appendChild(dt);
    detailFields.appendChild(dd);
  });

  detailPanel.style.height = state.detailHeight + "px";
  detailPanel.classList.remove("hidden");
  updateTbodyHeight();
}

function closeDetail() {
  detailPanel.classList.add("hidden");
  tbody.querySelectorAll("tr.selected").forEach((r) => r.classList.remove("selected"));
  state.selectedIdx = null;
  updateTbodyHeight();
}

// ── Filtering ─────────────────────────────────────────────────────────────────

/**
 * Returns true if the entry should be shown given the current active filters.
 * @param {RequestEntry} entry
 * @returns {boolean}
 */
function passesFilter(entry) {
  if (!state.activeFilters.has(entry.result.status)) return false;
  const cf = state.columnFilters;
  if (cf.method     !== null && !cf.method.has(entry.method || ""))                return false;
  if (cf.apiVersion !== null && !cf.apiVersion.has(entry.apiVersion || ""))        return false;
  if (cf.status     !== null && !cf.status.has(entry.result.status || ""))         return false;
  if (cf.reason     !== null && !cf.reason.has(entry.result.reason || ""))         return false;
  if (cf.shard      !== null && !cf.shard.has(entry.result.shard_name || ""))      return false;
  return true;
}

// ── Column-level filter dropdown ──────────────────────────────────────────────

/** Currently open column filter key, or null if the dropdown is closed. */
let _colFilterActive = null;

/**
 * Return the column filter value for a given entry.
 * @param {RequestEntry} entry
 * @param {string} col  Column key (method|apiVersion|status|reason|shard)
 * @returns {string}
 */
function getColumnValue(entry, col) {
  switch (col) {
    case "method":     return entry.method || "";
    case "apiVersion": return entry.apiVersion || "";
    case "status":     return entry.result.status || "";
    case "reason":     return entry.result.reason || "";
    case "shard":      return entry.result.shard_name || "";
    default:           return "";
  }
}

/**
 * Return sorted unique values for a column across all recorded requests.
 * @param {string} col
 * @returns {string[]}
 */
function getUniqueColumnValues(col) {
  const vals = new Set();
  state.requests.forEach((e) => vals.add(getColumnValue(e, col)));
  return Array.from(vals).sort();
}

/**
 * Open (or toggle) the column filter dropdown for the given column,
 * positioned directly below the triggering button element.
 * @param {string} col     Column key.
 * @param {Element} btnEl  The header button that was clicked.
 */
function openColumnFilter(col, btnEl) {
  // Toggle: close if already open for the same column
  if (_colFilterActive === col && !colFilterDropdown.classList.contains("hidden")) {
    closeColumnFilter();
    return;
  }
  _colFilterActive = col;

  // Populate checkbox list
  const values = getUniqueColumnValues(col);
  const currentFilter = state.columnFilters[col]; // null or Set
  colFilterList.innerHTML = "";
  values.forEach((val) => {
    const label = document.createElement("label");
    label.className = "col-filter-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = val;
    cb.checked = currentFilter === null || currentFilter.has(val);
    cb.addEventListener("change", onColFilterItemChange);
    label.appendChild(cb);
    label.appendChild(document.createTextNode("\u00a0" + (val || "(empty)")));
    colFilterList.appendChild(label);
  });
  syncSelectAll();

  // Position dropdown below the button
  const rect = btnEl.getBoundingClientRect();
  colFilterDropdown.style.left = Math.max(0, rect.left) + "px";
  colFilterDropdown.style.top  = (rect.bottom + 2) + "px";
  colFilterDropdown.classList.remove("hidden");
}

/** Close the column filter dropdown without applying any further change. */
function closeColumnFilter() {
  _colFilterActive = null;
  colFilterDropdown.classList.add("hidden");
}

/**
 * Sync the "Select All" checkbox state to reflect the current item checkboxes.
 */
function syncSelectAll() {
  const boxes = Array.from(colFilterList.querySelectorAll("input[type=checkbox]"));
  const checkedCount = boxes.filter((b) => b.checked).length;
  colFilterSelectAll.checked       = checkedCount === boxes.length;
  colFilterSelectAll.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
}

/** Called when an individual value checkbox changes. */
function onColFilterItemChange() {
  const boxes   = Array.from(colFilterList.querySelectorAll("input[type=checkbox]"));
  const checked = boxes.filter((b) => b.checked).map((b) => b.value);
  state.columnFilters[_colFilterActive] =
    checked.length === boxes.length ? null : new Set(checked);
  syncSelectAll();
  applyColumnFilter(_colFilterActive);
}

/** Called when the "Select All" checkbox changes. */
function onColFilterSelectAllChange() {
  const allChecked = colFilterSelectAll.checked;
  colFilterList.querySelectorAll("input[type=checkbox]")
    .forEach((b) => { b.checked = allChecked; });
  state.columnFilters[_colFilterActive] = allChecked ? null : new Set();
  colFilterSelectAll.indeterminate = false;
  applyColumnFilter(_colFilterActive);
}

/**
 * Re-render the table and update the count badge after a column filter change.
 * Also marks the column header button as active when a filter is in effect.
 * @param {string} col
 */
function applyColumnFilter(col) {
  const btn = document.querySelector(".col-filter-btn[data-col=\"" + col + "\"]");
  if (btn) btn.classList.toggle("active", state.columnFilters[col] !== null);
  rerender();
}

// ── Clipboard / export ────────────────────────────────────────────────────────

/**
 * Write text to the clipboard using the Clipboard API with an execCommand fallback.
 * @param {string} text
 */
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => execCommandCopy(text));
  } else {
    execCommandCopy(text);
  }
}

function execCommandCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (_) {}
  document.body.removeChild(ta);
}

/**
 * Build a CSV row for a single entry.  All fields are double-quoted.
 * @param {RequestEntry} entry
 * @returns {string}
 */
function entryToCsvRow(entry) {
  const r = entry.result;
  const cols = [
    entry.time,
    entry.url || "",
    entry.isBatchSub ? "yes" : "no",
    entry.batchName || "",
    entry.method,
    entry.host,
    entry.pathname,
    entry.normPath,
    entry.apiVersion || "",
    r.status,
    r.reason || "",
    r.provider_namespace || "",
    r.matched_route_key || "",
    (r.matched_versions && r.matched_versions.join("; ")) || "",
    r.shard_name || "",
    r.error || "",
  ];
  return cols.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(",");
}

/** Copy all currently visible rows as tab-separated text. */
function copyAllVisible() {
  const headerCols = [
    "Time", "URL", "Batch Sub", "Batch Name", "Method", "Host", "Path",
    "Normalised Path", "api-version", "Status", "Reason",
    "Provider Namespace", "Matched Route", "Available Versions", "Shard", "Load Error",
  ];
  const visible = state.requests.filter((e) => passesFilter(e));
  const rows = [headerCols.join("\t")];
  visible.forEach((e) => {
    const r = e.result;
    rows.push([
      e.time,
      e.url || "",
      e.isBatchSub ? "yes" : "no",
      e.batchName || "",
      e.method,
      e.host,
      e.pathname,
      e.normPath,
      e.apiVersion || "",
      r.status,
      r.reason || "",
      r.provider_namespace || "",
      r.matched_route_key || "",
      (r.matched_versions && r.matched_versions.join("; ")) || "",
      r.shard_name || "",
      r.error || "",
    ].join("\t"));
  });
  copyToClipboard(rows.join("\n"));
}

/** Copy the selected entry's detail as plain text. */
function copyEntryDetail(entry) {
  const r = entry.result;
  const lines = [
    "URL: "                + (entry.url || ""),
    "Time: "               + entry.time,
    "Method: "             + entry.method,
    "Host: "               + entry.host,
    "Path: "               + entry.pathname,
    "Normalised Path: "    + entry.normPath,
    "api-version: "        + (entry.apiVersion || ""),
    "Status: "             + (r.label || r.status),
    "Reason: "             + (r.reason || ""),
    "Provider Namespace: " + (r.provider_namespace || ""),
    "Matched Route: "      + (r.matched_route_key || ""),
    "Available Versions: " + ((r.matched_versions && r.matched_versions.join(", ")) || ""),
    "Shard: "              + (r.shard_name || ""),
  ];
  if (entry.isBatchSub) {
    lines.splice(2, 0, "Batch Sub-Request: " + (entry.batchName != null ? "#" + entry.batchName : "yes"));
  }
  if (r.error) {
    lines.push("Load Error: " + r.error);
  }
  copyToClipboard(lines.join("\n"));
}

/** Trigger a CSV download of all requests. */
function saveCSV() {
  if (state.requests.length === 0) return;
  const lines = [CSV_HEADER];
  state.requests.forEach((e) => lines.push(entryToCsvRow(e)));
  const csv = lines.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  const ts   = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  a.href     = url;
  a.download = "apispy-" + ts + ".csv";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Draggable detail panel resize ────────────────────────────────────────────

function attachDetailResizer() {
  detailResizer.addEventListener("mousedown", (e) => {
    const startY = e.clientY;
    const startH = state.detailHeight;

    detailResizer.classList.add("dragging");
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";

    function onMouseMove(ev) {
      const delta = startY - ev.clientY; // drag up = taller
      const minH = 80;
      const maxH = Math.floor(window.innerHeight * 0.8);
      state.detailHeight = Math.min(maxH, Math.max(minH, startH + delta));
      detailPanel.style.height = state.detailHeight + "px";
      updateTbodyHeight();
    }

    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      detailResizer.classList.remove("dragging");
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    e.preventDefault();
  });
}

// ── Pack settings dialog ──────────────────────────────────────────────────────

/** Temporary selection while the dialog is open. */
let _packDialogSelection = null;

/**
 * Open the pack settings dialog and populate it with the bundled packs.
 */
async function openPackDialog() {
  let packs;
  try {
    packs = await Loader.listBundledPacks();
  } catch (err) {
    flashStatus("Failed to load pack list: " + err.message, 4000);
    return;
  }

  const enabledIds = Loader.getEnabledPackIds();
  // Build a working copy of the enabled set so we can revert on Cancel.
  _packDialogSelection = enabledIds
    ? new Set(enabledIds)
    : new Set(packs.map((p) => p.pack_id));

  packList.innerHTML = "";
  for (const pack of packs) {
    const checked = _packDialogSelection.has(pack.pack_id);
    const meta    = pack.source_metadata || {};
    const stamp   = meta.generated_at
      ? new Date(meta.generated_at).toLocaleDateString() : "";
    const metaStr = [
      pack.platform ? pack.platform.toUpperCase() : "",
      pack.total_bundled_shards + " providers",
      stamp ? "exported " + stamp : "",
    ].filter(Boolean).join(" · ");

    const item = document.createElement("label");
    item.className = "pack-item";
    item.innerHTML = `
      <input type="checkbox" class="pack-item-checkbox" data-pack="${escHtml(pack.pack_id)}"${checked ? " checked" : ""}>
      <span class="pack-item-name">${escHtml(pack.display_name || pack.pack_id)}</span>
      <span class="pack-item-meta">${escHtml(metaStr)}</span>
      <span class="pack-item-desc">${escHtml(pack.description || "")}</span>
    `;
    packList.appendChild(item);
  }

  packDialog.classList.remove("hidden");
}

function closePackDialog() {
  packDialog.classList.add("hidden");
  _packDialogSelection = null;
}

/**
 * Apply the pack selection from the dialog: persist to localStorage,
 * reset the loader cache, clear existing results, and update the status bar.
 */
async function applyPackSelection() {
  if (!_packDialogSelection) { closePackDialog(); return; }

  // Read checkbox state from the rendered list.
  const checkboxes = packList.querySelectorAll(".pack-item-checkbox[data-pack]");
  const selected = [];
  checkboxes.forEach((cb) => {
    if (cb.checked) selected.push(cb.dataset.pack);
  });

  // Persist selection; null means "all packs" — only save when it differs
  // from the full set.
  let allPacks;
  try { allPacks = (await Loader.listBundledPacks()).map((p) => p.pack_id); } catch (_) { allPacks = []; }
  const isAll = allPacks.length > 0 && allPacks.every((id) => selected.includes(id));
  Loader.setEnabledPackIds(isAll ? null : selected);

  // Reset the shard cache so subsequent requests use the new pack selection.
  Loader.resetCache();

  // Clear captured requests — they may have been classified against the
  // previous pack selection, so they could be stale.
  state.requests = [];
  state.selectedIdx = null;
  tbody.innerHTML = "";
  closeDetail();
  closeColumnFilter();
  updateCountBadge();
  toggleEmptyState();
  localStorage.removeItem("apispy_requests");

  closePackDialog();

  // Refresh the status bar.
  try {
    const packs     = await Loader.listBundledPacks();
    const providers = await Loader.listBundledProviders();
    if (packs.length === 1) {
      const meta  = packs[0].source_metadata || {};
      const stamp = meta.generated_at ? new Date(meta.generated_at).toLocaleDateString() : "unknown";
      setStatus(providers.length + " providers bundled (export " + stamp + ")");
    } else {
      const enabledIds = Loader.getEnabledPackIds();
      const enabledCount = enabledIds ? packs.filter((p) => enabledIds.has(p.pack_id)).length : packs.length;
      setStatus(providers.length + " providers from " + enabledCount + "/" + packs.length + " packs");
    }
  } catch (_) {}
}

// ── UI event listeners ────────────────────────────────────────────────────────

function attachUIListeners() {
  // Multi-select filter toggle buttons
  filterGroup.addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-btn[data-status]");
    if (!btn) return;
    const status = btn.dataset.status;

    if (status === "all") {
      // Reset: activate all individual status filters
      ALL_STATUSES.forEach((s) => state.activeFilters.add(s));
      filterGroup.querySelectorAll(".filter-btn[data-status]").forEach((b) => b.classList.add("active"));
    } else {
      // Toggle the clicked status
      if (state.activeFilters.has(status)) {
        state.activeFilters.delete(status);
        btn.classList.remove("active");
      } else {
        state.activeFilters.add(status);
        btn.classList.add("active");
      }
      // Keep the "All" button highlighted only when every status is active
      const allBtn = filterGroup.querySelector(".filter-btn[data-status='all']");
      if (allBtn) {
        allBtn.classList.toggle("active", state.activeFilters.size === ALL_STATUSES.length);
      }
    }
    rerender();
  });

  // Autoscroll toggle
  btnAutoscroll.addEventListener("click", () => {
    state.autoscroll = !state.autoscroll;
    btnAutoscroll.classList.toggle("active", state.autoscroll);
  });

  // Pack settings dialog
  btnPacks.addEventListener("click", openPackDialog);
  packDialogClose.addEventListener("click", closePackDialog);
  packCancel.addEventListener("click", closePackDialog);
  packApply.addEventListener("click", applyPackSelection);
  // Close dialog on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !packDialog.classList.contains("hidden")) {
      closePackDialog();
    }
  });

  // Copy all visible rows
  btnCopyAll.addEventListener("click", copyAllVisible);

  // Save CSV
  btnCsv.addEventListener("click", saveCSV);

  // Clear
  btnClear.addEventListener("click", () => {
    state.requests = [];
    state.selectedIdx = null;
    tbody.innerHTML = "";
    closeDetail();
    closeColumnFilter();
    updateCountBadge();
    toggleEmptyState();
    localStorage.removeItem("apispy_requests");
  });

  // Detail panel buttons
  detailClose.addEventListener("click", closeDetail);
  detailCopy.addEventListener("click", () => {
    if (state.selectedIdx != null && state.requests[state.selectedIdx]) {
      copyEntryDetail(state.requests[state.selectedIdx]);
    }
  });
  detailNetwork.addEventListener("click", () => {
    if (state.selectedIdx != null && state.requests[state.selectedIdx]) {
      const url = state.requests[state.selectedIdx].url;
      if (url) {
        copyToClipboard(url);
        flashStatus(
          "URL copied \u2014 open the Network panel, press Ctrl/Cmd+F and paste to locate this entry",
          4000
        );
      }
    }
  });

  // Column filter buttons (delegated from thead)
  document.querySelector(".request-table thead").addEventListener("click", (e) => {
    const btn = e.target.closest(".col-filter-btn[data-col]");
    if (!btn) return;
    e.stopPropagation();
    openColumnFilter(btn.dataset.col, btn);
  });

  // Column filter dropdown — "Select All" checkbox
  colFilterSelectAll.addEventListener("change", onColFilterSelectAllChange);

  // Close column filter dropdown when clicking outside
  document.addEventListener("click", (e) => {
    if (colFilterDropdown.classList.contains("hidden")) return;
    if (!colFilterDropdown.contains(e.target) && !e.target.closest(".col-filter-btn")) {
      closeColumnFilter();
    }
  });

  // Close column filter dropdown on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !colFilterDropdown.classList.contains("hidden")) {
      closeColumnFilter();
    }
  });

  // Draggable resize handle
  attachDetailResizer();

  // Keep layout correct when the DevTools window is resized
  window.addEventListener("resize", updateTbodyHeight);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

init();
