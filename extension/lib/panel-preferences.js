// lib/panel-preferences.js — validated local panel-view preferences

"use strict";

(function (exports) {

  const STORAGE_KEY = "apispy_panel_preferences_v1";
  const SCHEMA_VERSION = 1;
  const SORT_MODES = Object.freeze(["chronological", "interesting", "risk"]);

  function defaults(allowedStatuses) {
    return {
      activeStatuses: Array.isArray(allowedStatuses) ? allowedStatuses.slice() : [],
      autoscroll: true,
      sortMode: "chronological",
      quickFilterInteresting: false,
      quickFilterHighRisk: false,
      quickFilterProviderKnown: false,
    };
  }

  function normaliseStatuses(value, allowedStatuses) {
    const allowed = Array.isArray(allowedStatuses) ? allowedStatuses : [];
    if (!Array.isArray(value)) return allowed.slice();
    if (value.length === 0) return [];
    const requested = new Set(value.filter((item) => typeof item === "string"));
    const recognised = allowed.filter((status) => requested.has(status));
    return recognised.length > 0 ? recognised : allowed.slice();
  }

  function normaliseStored(value, allowedStatuses) {
    const fallback = defaults(allowedStatuses);
    if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== SCHEMA_VERSION) {
      return fallback;
    }

    const quick = value.quick_filters && typeof value.quick_filters === "object"
      ? value.quick_filters
      : {};
    return {
      activeStatuses: normaliseStatuses(value.active_statuses, allowedStatuses),
      autoscroll: typeof value.autoscroll === "boolean" ? value.autoscroll : fallback.autoscroll,
      sortMode: SORT_MODES.includes(value.sort_mode) ? value.sort_mode : fallback.sortMode,
      quickFilterInteresting: typeof quick.interesting === "boolean"
        ? quick.interesting
        : fallback.quickFilterInteresting,
      quickFilterHighRisk: typeof quick.high_risk === "boolean"
        ? quick.high_risk
        : fallback.quickFilterHighRisk,
      quickFilterProviderKnown: typeof quick.provider_known === "boolean"
        ? quick.provider_known
        : fallback.quickFilterProviderKnown,
    };
  }

  function resolveStorage(storage) {
    if (storage) return storage;
    return typeof localStorage !== "undefined" ? localStorage : null;
  }

  function load(allowedStatuses, storage) {
    const target = resolveStorage(storage);
    if (!target) return defaults(allowedStatuses);
    try {
      const raw = target.getItem(STORAGE_KEY);
      if (!raw) return defaults(allowedStatuses);
      return normaliseStored(JSON.parse(raw), allowedStatuses);
    } catch (_) {
      return defaults(allowedStatuses);
    }
  }

  function save(preferences, allowedStatuses, storage) {
    const target = resolveStorage(storage);
    if (!target) return false;
    const value = preferences && typeof preferences === "object" ? preferences : {};
    const safe = {
      schema_version: SCHEMA_VERSION,
      active_statuses: normaliseStatuses(value.activeStatuses, allowedStatuses),
      autoscroll: typeof value.autoscroll === "boolean" ? value.autoscroll : true,
      sort_mode: SORT_MODES.includes(value.sortMode) ? value.sortMode : "chronological",
      quick_filters: {
        interesting: value.quickFilterInteresting === true,
        high_risk: value.quickFilterHighRisk === true,
        provider_known: value.quickFilterProviderKnown === true,
      },
    };
    try {
      target.setItem(STORAGE_KEY, JSON.stringify(safe));
      return true;
    } catch (_) {
      return false;
    }
  }

  exports.PanelPreferences = {
    STORAGE_KEY,
    defaults,
    load,
    save,
    normaliseStored,
  };

}(typeof window !== "undefined" ? window : exports));
