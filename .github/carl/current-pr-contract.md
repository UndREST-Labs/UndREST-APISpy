<!-- version: 2.2.0 -->
# Current PR Contract

This contract constrains implementation scope for the active PR. Update it when
scope is explicitly amended. If a requested action falls outside approved scope,
stop and escalate before proceeding.

## Goal

Prepare bounded Microsoft Graph request capture and normalisation for a future
authoritative SpecQL pack without fabricating Graph routes or modifying generated
pack data.

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

- Register a built-in Microsoft Graph normaliser through
  `Normalizer.registerPackNormaliser`.
- Match only explicitly supported Graph hosts and schemes.
- Preserve `/v1.0` and `/beta` in normalised paths while exposing the path
  version through the existing `apiVersion` field.
- Template only conservative identifier shapes; preserve query parameter names
  and the existing normalised-request object shape.
- Keep Azure ARM normalisation and matching behaviour unchanged.
- Add a small generic loader fallback that selects a shard by exact request host
  only when exactly one enabled shard advertises that host.
- Capture supported Graph requests safely as no-spec matches while no Graph shard
  is bundled.
- Add focused plain-Node tests and update pack/readiness documentation.

## Intentional amendments

- Supersedes the completed phase-three session-correlation contract for this
  bounded Microsoft Graph pack-readiness phase.
- The only supported Graph host in this phase is the global endpoint
  `graph.microsoft.com`; sovereign hosts require separately verified coverage.
- A host-only shard fallback is deliberately fail-closed when zero or multiple
  enabled shards advertise the same host.

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
- `extension/lib/normalizer.js`
- `extension/lib/filters.js`
- `extension/lib/loader.js`
- `extension/lib/request-pipeline.js`
- `extension/panel.js`
- `extension/devtools.js`
- `extension/panel.html`
- `extension/devtools.html`
- `tests/test_normalizer.js`
- `tests/test_filters.js`
- `tests/test_loader.js`
- `tests/test_matcher.js`
- `tests/test_capture_pipeline.js`
- `package.json`
- `docs/ADDING_A_PACK.md`
- `README.md`
- `extension/README.md`

## Tests / validation

```bash
npm test
node --check extension/lib/matcher.js
node --check extension/lib/normalizer.js
node --check extension/lib/filters.js
node --check extension/lib/loader.js
node --check extension/lib/request-pipeline.js
node --check extension/panel.js
node --check extension/devtools.js
git diff --check
git diff --stat HEAD -- extension/data/ demos/
git status --short
carl doctor
```

Focused tests must cover Graph `v1.0` and `beta`, exact supported-host matching,
lookalike-host rejection, conservative identifier templating, scheme bounds,
unchanged Azure behaviour, generic future-pack host lookup, ambiguity rejection,
and safe no-shard classification.

## Stop conditions

- Existing classification tests regress.
- The implementation requires generated-data, workflow, or dependency changes.
- Graph matching admits non-HTTPS traffic or non-allowlisted hosts.
- Graph route metadata must be invented to complete the phase.

## Escalation triggers

- A sovereign Graph hostname is requested without an authoritative repository
  source or separately verified documentation.
- A future Graph export requires ambiguous multi-shard host routing not expressed
  by the current manifest.

## Context reset notes

This contract covers request-side Graph readiness only. The repository still
contains no authoritative Graph pack, performs no runtime fetch, and must report
Graph requests as unclassified until generated SpecQL data is bundled.
