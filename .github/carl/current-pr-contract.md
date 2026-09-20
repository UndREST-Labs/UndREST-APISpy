<!-- version: 2.1.0 -->
# Current PR Contract

This contract constrains implementation scope for the active PR. Update it when
scope is explicitly amended. If a requested action falls outside approved scope,
stop and escalate before proceeding.

## Goal

Consume additive SpecQL 3.2.0 grouped/sharded route-correlation metadata while
preserving compatibility with SpecQL 3.1.0 and 3.0.0 shards, and derive bounded
deterministic session correlation across observed APISpy research events.

## Contract status

active

## Non-goals

- Do not add an autonomous request or exploitation engine.
- Do not allow model output to trigger browser or network actions.
- Do not add a real external model provider or runtime network dependency.
- Do not regenerate or hand-edit shards, manifests, provider-op data, or demos.
- Do not redesign the existing matcher, loader, normaliser, or pack architecture.
- Do not add npm or Python dependencies.
- Do not add ARM special-casing beyond existing pack and normaliser hooks.

## Carry-forward rules

- Generated data remains pipeline-owned and must not be hand-edited.
- JavaScript tests remain runnable with plain Node and no browser or Azure auth.
- The extension remains offline-capable with no runtime network dependency.
- Existing request classification and filtering continue to work with research/AI disabled.
- APISpy observes traffic but never authenticates or issues API requests.
- cARL artefacts remain canonical governance authority.
- Sanitisation occurs before persistence, export, or provider submission.

## Approved scope

- Additively expose optional SpecQL 3.2.0 `api_family` and `version_lineage`
  metadata through matcher operation metadata.
- Carry bounded resource-family, resource-hierarchy, and version-lineage metadata
  into research events, model context, and portable JSON export.
- Add deterministic session correlation for resource families, parent/child
  hierarchy, sibling operations on a resource, observed verbs, API versions and
  preview/stable lineage, hosts, documented auth requirements, and
  management-plane/data-plane relationships.
- Add evidence-based deterministic findings from session correlation, including
  cross-plane resource observation, preview use when stable versions exist,
  inconsistent sibling-family auth requirements, undocumented observed verbs,
  and same resource across multiple hosts.
- Preserve graceful behaviour for SpecQL 3.1.0/3.0.0 shards where the new fields
  are absent.
- Add focused plain-Node tests and update directly related architecture/cARL
  documentation.

## Intentional amendments

- Supersedes the completed SpecQL 3.1.0 metadata slice after the user requested
  phase-three session correlation.
- Bumps research event/session/model-context schema additively from 1.1.0 to
  1.2.0.
- Existing 1.1.0 sessions/exports must remain readable as missing optional
  correlation metadata.

## Forbidden scope

- Modifying generated content under `extension/data/` or `demos/`.
- Modifying workflows or adding dependencies.
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
- New research schemas are versioned separately from existing pack/shard schemas.
- Future Microsoft API packs use existing pack and normaliser extension points.

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
- `extension/lib/matcher.js`
- `extension/lib/research.js`
- `extension/panel.js`
- `extension/devtools.js` if compact sweep persistence needs a field mirror
- `tests/test_matcher.js`
- `tests/test_research.js`
- `tests/test_research_safety.js`
- `docs/RESEARCH_ARCHITECTURE.md`
- `README.md` and/or `extension/README.md`

## Tests / validation

```bash
npm test
node --check extension/lib/matcher.js
node --check extension/lib/research.js
node --check extension/panel.js
node --check extension/devtools.js
git diff --check
git diff --stat HEAD -- extension/data/ demos/
git status --short
carl doctor
```

Focused tests must cover SpecQL 3.2.0 metadata consumption, compatibility with
3.1.0/3.0.0 shards lacking the fields, each correlation dimension, each new
finding, bounds/truncation, schema 1.2.0 export/model-context compatibility, and
redaction of new fields.

## Stop conditions

- Any raw credential reaches provider input, persistence, or research export.
- Existing classification tests regress.
- The implementation requires generated-data, workflow, or dependency changes.
- Model output can trigger a network action.
- Correlation output is unbounded or omits truncation state.

## Escalation triggers

- A real external model integration is requested.
- A future executor or active test runner is requested.
- SpecQL export schema changes beyond additive 3.2.0 route metadata become required.

## Context reset notes

This contract covers optional consumption of additive SpecQL 3.2.0 route-family
and version-lineage metadata plus bounded deterministic session correlation.
Real model providers and any executor remain later phases.
