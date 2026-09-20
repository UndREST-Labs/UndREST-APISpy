<!-- version: 2.0.0 -->
# Current PR Contract

This contract constrains implementation scope for the active PR. Update it when
scope is explicitly amended. If a requested action falls outside approved scope,
stop and escalate before proceeding.

## Goal

Add the first reviewable AI-assisted research vertical slice to APISpy while
preserving existing classification, pack, sweep, and offline behaviour:

```text
capture -> sanitise -> enrich -> deterministic finding -> advisory hypothesis -> export
```

## Contract status

active

## Non-goals

- Do not add an autonomous request or exploitation engine.
- Do not allow model output to trigger browser or network actions.
- Do not add a real external model provider or runtime network dependency.
- Do not regenerate or hand-edit shards, manifests, provider-op data, or demos.
- Do not redesign the existing matcher, loader, normaliser, or pack architecture.
- Do not add npm or Python dependencies.

## Carry-forward rules

- Generated data remains pipeline-owned and must not be hand-edited.
- JavaScript tests remain runnable with plain Node and no browser or Azure auth.
- The extension remains offline-capable with no runtime network dependency.
- Existing request classification and filtering continue to work with research/AI disabled.
- APISpy observes traffic but never authenticates or issues API requests.
- cARL artefacts remain canonical governance authority.

## Approved scope

- Add browser-compatible modules for research events, sanitisation, JWT metadata extraction, deterministic differential findings, bounded test plans, and provider-neutral hypothesis generation.
- Add a deterministic mock/local hypothesis provider and strict output validation.
- Integrate sanitised research events into interactive capture and portal-sweep capture.
- Add explicit opt-in AI controls and JSON research-session export without changing existing CSV semantics.
- Add a non-noisy Research section to request details.
- Add focused plain-Node tests and directly related architecture/trust-boundary documentation.
- Add optional matcher result metadata sourced from existing shard fields without changing route identity or generated shard schemas.

## Intentional amendments

- Supersedes the previous generated-artefact-boundary task after the user explicitly requested and approved implementation of the research vertical slice.
- Preserves all prior generated-artefact ownership and offline-operation invariants.

## Forbidden scope

- Modifying generated content under `extension/data/` or `demos/`.
- Modifying workflows or adding dependencies.
- Sending captured data to external services.
- Persisting or exporting bearer tokens, cookies, SAS signatures, API keys, client secrets, auth codes, refresh tokens, or raw request/response bodies.
- Model-controlled tools, HTTP requests, approval bypasses, or target discovery.

## Architectural constraints

- Models advise; deterministic controls execute.
- Sanitisation occurs before persistence, export, or provider submission.
- Model input contains structured, bounded context rather than raw browser traffic.
- Model output is untrusted, schema-validated, bounded, provenance-tagged, and advisory.
- AI is disabled by default and provider failure degrades safely.
- New research schemas are versioned separately from existing pack/shard schemas.
- Future Microsoft API packs use existing pack and normaliser extension points.

## Security constraints

- Hostile observed fields are data, never instructions.
- Prompt-injection-like content must remain delimited and cannot alter policy.
- JWT decoding is local and limited to non-secret claims metadata.
- No raw credentials may appear in research persistence, export, provider input, tests, or logs.
- Research exports must state redaction status and provenance.

## Files expected to change

- `.github/carl/current-pr-contract.md`
- `extension/lib/research.js`
- `extension/lib/matcher.js` (optional additive metadata only)
- `extension/panel.html`, `extension/panel.js`, `extension/devtools.html`, `extension/devtools.js`
- `extension/panel.css` only if minimal controls require styling
- `tests/test_research.js`, `package.json`
- `extension/README.md` and/or `docs/RESEARCH_ARCHITECTURE.md`

## Tests / validation

```bash
npm test
git diff --check
git diff --stat HEAD -- extension/data/ demos/
git status --short
```

Focused tests must cover redaction, JWT metadata, event construction, deterministic findings, test plans, injection-like content, malformed/provider-failure responses, AI-disabled behaviour, and export credential absence.

## Stop conditions

- Any raw credential reaches provider input, persistence, or research export.
- Existing classification tests regress.
- The implementation requires generated-data, workflow, or dependency changes.
- Model output can trigger a network action.

## Escalation triggers

- A real external model integration is requested.
- SpecQL export schema changes become required for the first slice.
- A future executor or active test runner is requested.

## Context reset notes

This contract covers only the first APISpy research vertical slice. SpecQL
schema enrichment and real model providers remain later phases.
