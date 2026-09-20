<!-- version: 2.2.0 -->
# Current PR Contract

This contract constrains implementation scope for the active PR. Update it when
scope is explicitly amended. If a requested action falls outside approved scope,
stop and escalate before proceeding.

## Goal

Display the freshness of enabled bundled API-pack exports in the DevTools panel,
including explicit stale, partial, future-dated, and unknown states, without
modifying generated pack data.

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

- Derive a conservative freshness summary from `source_metadata.generated_at`
  across enabled packs.
- Treat the oldest enabled-pack export as the bundle freshness timestamp.
- Mark exports stale after seven days, reflecting the documented nightly update
  cadence while allowing for transient workflow delays.
- Distinguish complete, partial, unknown, and future-dated timestamp metadata.
- Show freshness in a dedicated, accessible panel status badge that survives
  transient request-status messages and refreshes after pack selection changes.
- Add focused plain-Node tests and update user-facing documentation.

## Intentional amendments

- Supersedes the completed Microsoft Graph pack-readiness contract for this
  bounded export-freshness phase.
- Microsoft Graph readiness remains unchanged and no authoritative Graph pack is
  introduced.
- Seven days is the explicit stale threshold; timestamps more than one day ahead
  of the browser clock are reported as future-dated rather than fresh.

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
- `extension/lib/loader.js`
- `extension/panel.js`
- `extension/panel.html`
- `extension/panel.css`
- `tests/test_loader.js`
- `README.md`
- `extension/README.md`

## Tests / validation

```bash
npm test
node --check extension/lib/loader.js
node --check extension/panel.js
git diff --check
git diff --stat HEAD -- extension/data/ demos/
git status --short
carl doctor
```

Focused tests must cover fresh, stale, partial, unknown, and future-dated
metadata; oldest-enabled-pack selection; disabled-pack exclusion; and stable
handling of invalid timestamps.

## Stop conditions

- Existing loader or classification tests regress.
- The implementation requires generated-data, workflow, or dependency changes.
- Freshness calculation requires a runtime network request.
- Missing or malformed timestamps are presented as current.

## Escalation triggers

- Changing the shard update cadence or workflow is required.
- A product requirement calls for remote artifact fetching or automatic updates.

## Context reset notes

This contract covers display-only export freshness. It does not update pack
artifacts, alter pack selection, fetch remote metadata, or change request
classification.
