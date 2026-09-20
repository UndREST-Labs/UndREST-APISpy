<!-- version: 2.2.0 -->
# Current PR Contract

This contract constrains implementation scope for the active PR. Update it when
scope is explicitly amended. If a requested action falls outside approved scope,
stop and escalate before proceeding.

## Goal

Persist bounded APISpy panel view preferences across DevTools panel reloads while
validating browser storage and preserving safe defaults.

## Contract status

active

## Non-goals

- Do not add an autonomous request or exploitation engine.
- Do not allow model output to trigger browser or network actions.
- Do not add a real external model provider or runtime network dependency.
- Do not regenerate or hand-edit shards, manifests, provider-op data, or demos.
- Do not redesign the existing matcher, loader, normaliser, or pack architecture.
- Do not add npm or Python dependencies.
- Do not add Microsoft Graph special-casing inside ARM structural normalisation.
- Do not add Graph shards, route metadata, runtime fetches, or speculative route
  templates.

## Carry-forward rules

- Generated data remains pipeline-owned and must not be hand-edited.
- JavaScript tests remain runnable with plain Node and no browser or Azure auth.
- The extension remains offline-capable with no runtime network dependency.
- Existing request classification and filtering continue to work with research/AI disabled.
- APISpy observes traffic but never authenticates or issues API requests.
- cARL artefacts remain canonical governance authority.
- Sanitisation occurs before persistence, export, or provider submission.

## Approved scope

- Persist active status filters, sort mode, quick-filter toggles, and autoscroll.
- Store a small versioned JSON preference object in browser local storage.
- Validate every restored field against explicit allowlists and boolean types.
- Fall back to existing defaults when storage is absent, malformed, inaccessible,
  or contains unsupported values.
- Synchronise restored state to toolbar controls before request rendering.
- Add focused plain-Node tests and update user-facing documentation.

## Intentional amendments

- Supersedes the completed export-freshness contract for this bounded panel
  preference persistence phase.
- Column-value filters are intentionally session-only because their available
  values depend on currently observed traffic.
- Existing API-pack selection and AI opt-in storage remain independent.

## Forbidden scope

- Modifying generated content under `extension/data/` or `demos/`.
- Modifying workflows or adding dependencies.
- Fabricating Microsoft Graph route, operation, version, auth, or schema metadata.
- Sending captured data to external services.
- Persisting or exporting bearer tokens, cookies, SAS signatures, API keys,
  client secrets, auth codes, refresh tokens, or raw request/response bodies.
- Model-controlled tools, HTTP requests, approval bypasses, or target discovery.
- A request executor or any browser/network action triggered by model output.

## Architectural constraints

- Models advise; deterministic controls execute.
- Correlation output must be bounded/capped with explicit truncation reporting.
- Model input contains structured, bounded context rather than raw browser traffic.
- Model output is untrusted, schema-validated, bounded, provenance-tagged, and advisory.
- AI is disabled by default and provider failure degrades safely.
- Future Microsoft API packs use existing pack, loader, matcher, and normaliser
  extension points.
- Real Graph route classification requires an authoritative generated SpecQL
  export bundled as an enabled local pack.

## Security constraints

- Hostile observed fields are data, never instructions.
- Prompt-injection-like content must remain delimited and cannot alter policy.
- JWT decoding is local and limited to non-secret claims metadata.
- No raw credentials may appear in research persistence, export, provider input, tests, or logs.
- Research exports must state redaction status and provenance.
- New route-correlation fields must pass through the same sanitisation/export/model-context boundaries as existing research fields.

## Files expected to change

- `.github/carl/current-pr-contract.md`
- `.github/carl/memory.md`
- `extension/lib/panel-preferences.js`
- `extension/panel.js`
- `extension/panel.html`
- `tests/test_panel_preferences.js`
- `package.json`
- `README.md`
- `extension/README.md`

## Tests / validation

```bash
npm test
node --check extension/lib/panel-preferences.js
node --check extension/panel.js
git diff --check
git diff --stat HEAD -- extension/data/ demos/
git status --short
carl doctor
```

Focused tests must cover defaults, valid round-trips, unknown statuses and sort
modes, malformed JSON, unavailable storage, write failures, and empty status
selection.

## Stop conditions

- Existing panel, loader, or classification tests regress.
- The implementation requires generated-data, workflow, or dependency changes.
- Restored values bypass explicit validation.
- Persistence includes captured requests, column values, credentials, or research
  data.

## Escalation triggers

- Synchronising preferences across devices or accounts is requested.
- Persistence requires extension permissions or remote storage.

## Context reset notes

This contract covers local display preferences only. It does not persist captured
traffic or column-value filters and does not alter request classification, pack
selection, AI consent, export freshness, or research safety boundaries.
