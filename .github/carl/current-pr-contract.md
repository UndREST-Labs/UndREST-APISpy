<!-- version: 1.1.0 -->
# Current PR Contract

This contract constrains implementation scope for the active PR. Update
it when scope is explicitly amended. If a requested action falls outside
approved scope, stop and escalate before proceeding.

## Goal

Harden generated artefact boundaries so shard data, pack manifest, provider-op
enrichment data, and demo screenshots are clearly pipeline-owned and not
hand-edited.

## Contract status

active

## Non-goals

- No extension runtime behaviour changes.
- No shard data regeneration.
- No modification of generated shard contents.
- No workflow logic changes.
- No dependency changes.

## Carry-forward rules

The following durable invariants remain unchanged:
- Generated shard files and `extension/data/manifest.json` are pipeline-owned and must not be hand-edited.
- JS tests must pass with plain `node` — no browser, no Azure auth.
- The extension must remain offline-capable with no runtime network dependencies.
- `SPEQL_READ_TOKEN` must never be logged, echoed, or committed.
- cARL artefacts in `.github/carl/` remain the canonical governance authority.

## Approved scope

- Review and update `.gitignore` to cover local/transient generated artefacts where appropriate.
- Clarify generated-but-committed ownership for:
  - `extension/data/shards/`
  - `extension/data/manifest.json`
  - `extension/data/azure-provider-ops.json`
  - `demos/apispy-*.png`
- Update `CONTRIBUTING.md` only as needed to reinforce "do not hand-edit generated data".
- Update `README.md` if needed to clarify generated artefact ownership boundaries.
- Update `.github/carl/memory.md` only if durable ownership or validation expectations change.
- Run `npm test` and verify no shard/manifest/demo churn.

## Intentional amendments

- Supersedes the previous contract focused on introducing repo-level `npm test` CI wiring.
- Restricts this task to artefact-boundary hardening in docs/governance/ignore rules only.

## Forbidden scope

- Modifying extension runtime/source logic (except documentation comments if explicitly justified).
- Modifying `extension/data/shards/`, `extension/data/manifest.json`, or regenerating shard data.
- Modifying existing workflows.
- Adding npm or Python dependencies.
- Running scripts that require Azure auth or mutate generated data.

## Architectural constraints

- Preserve extension runtime behaviour and offline operation.
- Treat shard data, manifest, enrichment dataset, and demos as generated artefacts with explicit ownership boundaries.
- Keep updates focused on docs/governance/ignore behaviour.

## Security constraints

- No secrets, credentials, or tokens committed.
- Do not relax existing security boundaries or governance controls.

## Files expected to change

- `.github/carl/current-pr-contract.md`
- `.gitignore`
- `CONTRIBUTING.md`
- `README.md` (if clarification needed)
- `.github/carl/memory.md` (only if durable truth changes)

## Tests / validation

```bash
npm test
git diff --stat HEAD -- extension/data/shards/
git diff --stat HEAD -- extension/data/manifest.json
git diff --stat HEAD -- demos/apispy-*.png
git status --short
```

## Stop conditions

- If `npm test` fails, stop and investigate before proceeding.
- If shard, manifest, enrichment data, or demos change unexpectedly, stop and explain.
- If requested changes require runtime code/workflow/dependency changes, stop and escalate.

## Escalation triggers

- Any need to change extension runtime code or generated artefact contents.
- Any need to add dependencies or modify workflows.
- Any ambiguity about generated-but-committed ownership policy.

## Context reset notes

This task hardens artefact ownership boundaries only. It must not alter runtime
behaviour or generated data contents.
