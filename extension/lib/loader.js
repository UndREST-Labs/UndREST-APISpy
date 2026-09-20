// lib/loader.js — lazy shard loader for APISpy
// Loads the top-level data manifest once, then fetches individual provider
// shards on demand.  Everything is static and local — no remote fetching.
//
// Pack concept
// ────────────
// A "pack" is a named set of shards describing one platform's API surface
// (e.g. Azure REST API Specs, AWS API, Google Cloud API).  The manifest
// (schema v2.0.0) groups shards by pack, allowing the extension to enable or
// disable packs independently.  v1.0.0 manifests are automatically wrapped in
// a default azure pack for backward compatibility.
//
// Pack selection is persisted in localStorage under the key
// "apispy_enabled_packs" as a JSON array of pack_id strings.  When the key is
// absent every pack is considered enabled (the common case).

"use strict";

(function (exports) {

  const DATA_MANIFEST_URL = chrome.runtime.getURL("data/manifest.json");
  const ENABLED_PACKS_KEY = "apispy_enabled_packs";

  // Built-in Azure pack id — used when upgrading a v1.0.0 manifest.
  const DEFAULT_PACK_ID = "azure-rest-api-specs";

  /** Cached normalised manifest (loaded once). */
  let _manifestPromise = null;
  /** Map of shard filename → loaded shard data (or Promise). */
  const _shardCache = new Map();

  // ── Manifest loading & normalisation ────────────────────────────────────────

  /**
   * Normalise a raw manifest into a consistent internal structure.
   * v1.0.0 manifests (flat shards list) are wrapped in a default azure pack.
   * v2.0.0 manifests (packs array) are returned as-is.
   *
   * @param {object} raw  Parsed manifest JSON.
   * @returns {object}    Normalised manifest with a `packs` array.
   * @private
   */
  function _normaliseManifest(raw) {
    if (raw.schema_version === "2.0.0" && Array.isArray(raw.packs)) {
      return raw;
    }
    // v1.0.0 compat — wrap flat shards list in a single azure pack.
    return {
      schema_version: "2.0.0",
      description: raw.description || "APISpy bundled pack manifest",
      packs: [
        {
          pack_id:              DEFAULT_PACK_ID,
          display_name:         "Azure REST API Specs",
          platform:             "azure",
          description:          "Azure Resource Manager API specifications sourced from Azure/azure-rest-api-specs via UndREST-SpecQL.",
          source_label:         raw.source_zip || "",
          source_metadata:      raw.source_metadata || {},
          total_bundled_shards: raw.total_bundled_shards || 0,
          total_skipped_shards: raw.total_skipped_shards || 0,
          shards:               raw.shards || [],
          skipped_shards:       raw.skipped_shards || [],
        },
      ],
    };
  }

  /**
   * Load and cache the top-level data manifest.
   * @returns {Promise<object>}  The normalised manifest object.
   */
  function loadManifest() {
    if (!_manifestPromise) {
      _manifestPromise = fetch(DATA_MANIFEST_URL)
        .then((r) => {
          if (!r.ok) throw new Error("Failed to load data/manifest.json: " + r.status);
          return r.json();
        })
        .then(_normaliseManifest)
        .catch((err) => {
          _manifestPromise = null; // allow retry
          throw err;
        });
    }
    return _manifestPromise;
  }

  // ── Pack selection ───────────────────────────────────────────────────────────

  /**
   * Return the set of pack IDs the user has enabled.
   * Returns null when no preference has been saved, meaning "all packs enabled".
   *
   * @returns {Set<string>|null}
   */
  function getEnabledPackIds() {
    try {
      const raw = localStorage.getItem(ENABLED_PACKS_KEY);
      if (!raw) return null;
      const ids = JSON.parse(raw);
      if (!Array.isArray(ids)) return null;
      return new Set(ids);
    } catch (_) {
      return null;
    }
  }

  /**
   * Persist the user's pack selection.
   * Pass null to clear the preference (re-enables all packs).
   *
   * @param {string[]|null} packIds
   */
  function setEnabledPackIds(packIds) {
    try {
      if (packIds == null) {
        localStorage.removeItem(ENABLED_PACKS_KEY);
      } else {
        localStorage.setItem(ENABLED_PACKS_KEY, JSON.stringify(packIds));
      }
    } catch (_) {
      // Private-browsing or quota — silently ignore.
    }
  }

  /**
   * Return only the packs from the manifest that the user has enabled.
   * If no selection has been saved every pack is returned.
   *
   * @param {object} manifest  Normalised manifest.
   * @returns {Array<object>}  Enabled pack objects.
   * @private
   */
  function _enabledPacks(manifest) {
    const enabled = getEnabledPackIds();
    if (!enabled) return manifest.packs || []; // all packs
    return (manifest.packs || []).filter((p) => enabled.has(p.pack_id));
  }

  // ── Shard lookup ─────────────────────────────────────────────────────────────

  /**
   * Given the normalised manifest and a provider namespace, find the first
   * matching shard entry across all enabled packs.
   * Prefers an exact-case match; falls back to case-insensitive.
   *
   * @param {object} manifest          Normalised manifest object.
   * @param {string} providerNamespace
   * @returns {{ entry: object, pack: object }|null}
   */
  function findShardEntry(manifest, providerNamespace) {
    const lower = providerNamespace.toLowerCase();
    let caseInsensitive = null;

    for (const pack of _enabledPacks(manifest)) {
      const shards = pack.shards || [];
      const exact = shards.find((s) => s.provider_namespace === providerNamespace);
      if (exact) return { entry: exact, pack };
      if (!caseInsensitive) {
        const ci = shards.find((s) => s.provider_namespace.toLowerCase() === lower);
        if (ci) caseInsensitive = { entry: ci, pack };
      }
    }

    return caseInsensitive;
  }

  /**
   * Find a shard for a normalised request without assuming ARM URL structure.
   * Provider namespace remains the preferred key. When it is unavailable, an
   * exact host fallback is used only if exactly one enabled shard advertises
   * that host; ambiguous host mappings fail closed.
   *
   * @param {object} manifest
   * @param {string|null} providerNamespace
   * @param {string} host
   * @returns {{ entry: object, pack: object }|null}
   */
  function findShardEntryForRequest(manifest, providerNamespace, host) {
    if (providerNamespace) {
      return findShardEntry(manifest, providerNamespace);
    }

    const lowerHost = (host || "").toLowerCase();
    if (!lowerHost) return null;

    const matches = [];
    for (const pack of _enabledPacks(manifest)) {
      for (const entry of pack.shards || []) {
        const hosts = Array.isArray(entry.hosts) ? entry.hosts : [];
        if (hosts.some((candidate) => String(candidate).toLowerCase() === lowerHost)) {
          matches.push({ entry, pack });
        }
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }

  function loadShardEntry(entry) {
    if (!entry || !entry.filename) return Promise.resolve(null);
    const cacheKey = "file:" + entry.filename;
    if (_shardCache.has(cacheKey)) {
      return _shardCache.get(cacheKey);
    }

    const promise = fetch(chrome.runtime.getURL("data/shards/" + entry.filename))
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load shard " + entry.filename + ": " + r.status);
        return r.json();
      })
      .catch((err) => {
        _shardCache.delete(cacheKey);
        throw err;
      });

    _shardCache.set(cacheKey, promise);
    return promise;
  }

  /**
   * Load (and cache) the shard for the given provider namespace.
   * Returns null if the shard is not in any enabled pack.
   *
   * @param {string} providerNamespace  e.g. "Microsoft.Storage"
   * @returns {Promise<object|null>}  Parsed shard JSON or null.
   */
  async function loadShard(providerNamespace) {
    const cacheKey = providerNamespace.toLowerCase();

    if (_shardCache.has(cacheKey)) {
      return _shardCache.get(cacheKey);
    }

    const manifest = await loadManifest();
    const match = findShardEntry(manifest, providerNamespace);

    if (!match) {
      _shardCache.set(cacheKey, null);
      return null;
    }

    const promise = loadShardEntry(match.entry).catch((err) => {
      _shardCache.delete(cacheKey);
      throw err;
    });
    _shardCache.set(cacheKey, promise);
    return promise;
  }

  // ── Manifest queries ─────────────────────────────────────────────────────────

  /**
   * Return metadata for every pack in the manifest (enabled or not).
   * Each entry has pack_id, display_name, platform, description, source_metadata,
   * total_bundled_shards, and total_skipped_shards — but NOT the full shards list.
   *
   * @returns {Promise<Array<object>>}
   */
  async function listBundledPacks() {
    const manifest = await loadManifest();
    return (manifest.packs || []).map((p) => ({
      pack_id:              p.pack_id,
      display_name:         p.display_name,
      platform:             p.platform,
      description:          p.description,
      source_label:         p.source_label,
      source_metadata:      p.source_metadata || {},
      total_bundled_shards: p.total_bundled_shards || (p.shards || []).length,
      total_skipped_shards: p.total_skipped_shards || 0,
    }));
  }

  /**
   * Return the list of provider namespaces that are bundled in enabled packs.
   * @returns {Promise<string[]>}
   */
  async function listBundledProviders() {
    const manifest = await loadManifest();
    const providers = [];
    for (const pack of _enabledPacks(manifest)) {
      for (const shard of pack.shards || []) {
        providers.push(shard.provider_namespace);
      }
    }
    return providers;
  }

  const EXPORT_STALE_AFTER_DAYS = 7;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  /**
   * Summarise export freshness across a set of packs.
   * The oldest valid enabled-pack timestamp represents the bundle because every
   * enabled pack must be current for the combined index to be current.
   *
   * @param {Array<object>} packs
   * @param {number|Date|string} [referenceTime]
   * @param {number} [staleAfterDays]
   * @returns {object}
   */
  function summariseExportFreshness(packs, referenceTime, staleAfterDays) {
    const packList = Array.isArray(packs) ? packs : [];
    const parsedReference = referenceTime instanceof Date
      ? referenceTime.getTime()
      : (referenceTime == null ? Date.now() : new Date(referenceTime).getTime());
    const now = Number.isFinite(parsedReference) ? parsedReference : Date.now();
    const thresholdDays = Number.isFinite(staleAfterDays) && staleAfterDays >= 0
      ? staleAfterDays
      : EXPORT_STALE_AFTER_DAYS;
    const valid = [];
    let missingOrInvalidCount = 0;
    let futureCount = 0;

    for (const pack of packList) {
      const raw = pack && pack.source_metadata && pack.source_metadata.generated_at;
      const timestamp = typeof raw === "string" ? Date.parse(raw) : NaN;
      if (!Number.isFinite(timestamp)) {
        missingOrInvalidCount++;
      } else if (timestamp - now > MS_PER_DAY) {
        futureCount++;
      } else {
        valid.push({ generated_at: raw, timestamp });
      }
    }

    const oldest = valid.reduce(
      (candidate, item) => !candidate || item.timestamp < candidate.timestamp ? item : candidate,
      null
    );
    const ageDays = oldest ? Math.max(0, Math.floor((now - oldest.timestamp) / MS_PER_DAY)) : null;
    const isStale = oldest ? now - oldest.timestamp > thresholdDays * MS_PER_DAY : null;
    let state = "unknown";
    if (futureCount > 0) state = "future";
    else if (oldest && missingOrInvalidCount > 0) state = "partial";
    else if (oldest) state = isStale ? "stale" : "fresh";

    return {
      state,
      generated_at: oldest ? oldest.generated_at : null,
      age_days: ageDays,
      is_stale: isStale,
      stale_after_days: thresholdDays,
      enabled_pack_count: packList.length,
      valid_timestamp_count: valid.length,
      missing_or_invalid_count: missingOrInvalidCount,
      future_timestamp_count: futureCount,
    };
  }

  /**
   * Return freshness metadata for enabled packs.
   * @param {number|Date|string} [referenceTime]
   * @returns {Promise<object>}
   */
  async function getExportFreshness(referenceTime) {
    const manifest = await loadManifest();
    return summariseExportFreshness(_enabledPacks(manifest), referenceTime);
  }

  /**
   * Return the source metadata from the first enabled pack (or an empty
   * object).  Kept for backward compatibility.
   * @returns {Promise<object>}
   */
  async function getSourceMetadata() {
    const manifest = await loadManifest();
    const packs = _enabledPacks(manifest);
    if (packs.length === 0) return {};
    return packs[0].source_metadata || {};
  }

  /**
   * Invalidate the in-memory manifest and shard caches.
   * Call this after changing the enabled-pack selection so that subsequent
   * shard loads respect the new selection.
   */
  function resetCache() {
    _manifestPromise = null;
    _shardCache.clear();
  }

  // Export
  exports.Loader = {
    loadManifest,
    loadShard,
    listBundledPacks,
    listBundledProviders,
    getSourceMetadata,
    getExportFreshness,
    summariseExportFreshness,
    findShardEntry,
    findShardEntryForRequest,
    loadShardEntry,
    getEnabledPackIds,
    setEnabledPackIds,
    resetCache,
  };

}(typeof window !== "undefined" ? window : exports));
