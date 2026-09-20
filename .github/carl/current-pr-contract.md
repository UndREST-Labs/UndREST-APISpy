<!-- version: 2.0.0 -->
# Current PR Contract

This contract constrains implementation scope for the active PR. Update it when
scope is explicitly amended. If a requested action falls outside approved scope,
stop and escalate before proceeding.

## Goal

Consume additive SpecQL 3.1.0 research metadata while preserving compatibility with existing 3.0.0 shards, and use documented parameter/schema summaries for deterministic observed-versus-documented findings.

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

- Additively expose optional SpecQL 3.1.0 auth, parameter-name, and schema-summary fields through matcher results.
- Carry bounded documented metadata into research events and model context.
- Add deterministic findings for undocumented query parameters and request/response schema differences.
- Preserve all existing behavior when consuming SpecQL 3.0.0 shards where the fields are absent.
- Add focused plain-Node tests and update directly related architecture/cARL documentation.

## Intentional amendments

- Supersedes the completed first research vertical slice after the user requested continuation.
- Preserves all prior generated-artefact ownership, sanitisation, advisory-only AI, and offline-operation invariants.

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
- `.github/carl/memory.md`
- `extension/lib/matcher.js`
- `extension/lib/research.js`
- `tests/test_matcher.js`
- `tests/test_research.js` and/or `tests/test_research_safety.js`
- `docs/RESEARCH_ARCHITECTURE.md`

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

This contract covers optional consumption of the additive SpecQL 3.1.0 research metadata. Real model providers and any executor remain later phases.
