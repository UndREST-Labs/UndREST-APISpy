// tests/test_panel_preferences.js — validated panel preference persistence

"use strict";

const { PanelPreferences } = require("../extension/lib/panel-preferences.js");

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

function memoryStorage(initial) {
  const values = { ...(initial || {}) };
  return {
    getItem: (key) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null,
    setItem: (key, value) => { values[key] = value; },
    removeItem: (key) => { delete values[key]; },
    values,
  };
}

const STATUSES = ["exact_match", "provider_known", "no_spec_match"];

console.log("\n=== Panel preferences: defaults and round-trip ===");

const emptyStorage = memoryStorage();
const defaults = PanelPreferences.load(STATUSES, emptyStorage);
assert(defaults.activeStatuses.join(",") === STATUSES.join(","), "missing storage enables every status");
assert(defaults.autoscroll === true, "missing storage enables autoscroll");
assert(defaults.sortMode === "chronological", "missing storage uses chronological sort");
assert(defaults.quickFilterInteresting === false, "missing storage disables quick filters");

const saved = PanelPreferences.save({
  activeStatuses: ["no_spec_match", "exact_match"],
  autoscroll: false,
  sortMode: "risk",
  quickFilterInteresting: true,
  quickFilterHighRisk: true,
  quickFilterProviderKnown: false,
}, STATUSES, emptyStorage);
assert(saved === true, "valid preferences are saved");

const restored = PanelPreferences.load(STATUSES, emptyStorage);
assert(restored.activeStatuses.join(",") === "exact_match,no_spec_match", "status selection round-trips in canonical order");
assert(restored.autoscroll === false, "autoscroll preference round-trips");
assert(restored.sortMode === "risk", "sort preference round-trips");
assert(restored.quickFilterInteresting && restored.quickFilterHighRisk && !restored.quickFilterProviderKnown,
  "quick-filter preferences round-trip");

console.log("\n=== Panel preferences: validation ===");

const mixed = PanelPreferences.normaliseStored({
  schema_version: 1,
  active_statuses: ["unknown", "provider_known"],
  autoscroll: "false",
  sort_mode: "unsupported",
  quick_filters: { interesting: true, high_risk: "yes", provider_known: false },
}, STATUSES);
assert(mixed.activeStatuses.join(",") === "provider_known", "unknown statuses are discarded");
assert(mixed.autoscroll === true, "non-boolean autoscroll falls back safely");
assert(mixed.sortMode === "chronological", "unknown sort mode falls back safely");
assert(mixed.quickFilterInteresting === true && mixed.quickFilterHighRisk === false,
  "quick filters accept only booleans");

const allUnknown = PanelPreferences.normaliseStored({
  schema_version: 1,
  active_statuses: ["not-a-real-status"],
}, STATUSES);
assert(allUnknown.activeStatuses.length === STATUSES.length, "all-unknown status list falls back to defaults");

const noneSelected = PanelPreferences.normaliseStored({
  schema_version: 1,
  active_statuses: [],
}, STATUSES);
assert(noneSelected.activeStatuses.length === 0, "explicit empty status selection is preserved");

const wrongSchema = PanelPreferences.normaliseStored({
  schema_version: 99,
  active_statuses: [],
}, STATUSES);
assert(wrongSchema.activeStatuses.length === STATUSES.length, "unsupported schema falls back to defaults");

const malformedStorage = memoryStorage({
  [PanelPreferences.STORAGE_KEY]: "{not json",
});
assert(PanelPreferences.load(STATUSES, malformedStorage).sortMode === "chronological",
  "malformed JSON falls back to defaults");

const unavailableStorage = {
  getItem: () => { throw new Error("storage unavailable"); },
  setItem: () => { throw new Error("storage unavailable"); },
};
assert(PanelPreferences.load(STATUSES, unavailableStorage).autoscroll === true,
  "storage read failure falls back to defaults");
assert(PanelPreferences.save({}, STATUSES, unavailableStorage) === false,
  "storage write failure is reported without throwing");
assert(PanelPreferences.save({}, STATUSES, null) === false,
  "missing storage is handled without throwing");

console.log(`\nPanel preferences: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
