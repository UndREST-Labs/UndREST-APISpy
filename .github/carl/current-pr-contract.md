<!-- version: 1.1.0 -->
# Current PR Contract

This contract constrains implementation scope for the active PR. Update
it when scope is explicitly amended. If a requested action falls outside
approved scope, stop and escalate before proceeding.

## Goal

Add a repo-level JavaScript test runner and CI workflow for APISpy's
existing plain-Node tests.

## Contract status

active

## Non-goals

- No extension behaviour changes.
- No product code refactors outside the repo-level test runner setup.
- No shard data regeneration or modification of `extension/data/shards/`.
- No modification of `extension/data/manifest.json`.
- No npm dependencies.
- No changes to existing workflows (`update-shards.yml`, `update-screenshots.yml`).

## Carry-forward rules

The following are already durable invariants and remain unchanged:
- Do not hand-edit generated shard files or `extension/data/manifest.json`.
- JS tests must pass with plain `node` — no browser, no Azure auth.
- The extension must remain offline-capable with no runtime network dependencies.
- `SPEQL_READ_TOKEN` must never be logged, echoed, or committed.
- cARL artefacts in `.github/carl/` are the canonical governance authority.

## Approved scope

- Add a minimal repo-root `package.json` with an `npm test` script that runs:
  - `node tests/test_filters.js`
  - `node tests/test_loader.js`
  - `node tests/test_normalizer.js`
  - `node tests/test_matcher.js`
- Add a GitHub Actions workflow that runs the same test command on pull requests
  and pushes to `main`.
- Update cARL/docs if test commands or validation expectations change.
- Run `npm test` and confirm no generated shard or manifest churn.

## Intentional amendments

- Supersedes the initial cARL installation contract for this task-specific PR.
- Approves a new GitHub Actions workflow and repo-root `package.json` despite the
  previous contract's governance-only scope.

## Forbidden scope

- Modifying `extension/` source files or extension runtime behaviour.
- Modifying `extension/data/shards/` or `extension/data/manifest.json`.
- Adding npm or Python dependencies.
- Changing existing workflow logic outside the new test workflow.
- Running scripts that require Azure auth.

## Architectural constraints

- Keep the existing plain-Node tests unchanged; `npm test` must be a thin wrapper.
- The workflow must run the same repo-level test command as local validation.
- The extension remains dependency-free at runtime.
- The pack manifest and shard data remain generated artefacts and must not be edited.

## Security constraints

- No secrets, credentials, or tokens committed.
- The test workflow must not require repository secrets.
- `GITHUB_TOKEN` permissions must stay least-privilege.

## Files expected to change

- `.github/carl/current-pr-contract.md`
- `.github/carl/memory.md`
- `.github/workflows/node-tests.yml`
- `package.json`
- `CONTRIBUTING.md`

## Tests / validation

```bash
# Repo-level JavaScript tests
npm test

# Confirm no shard churn
git diff --stat HEAD -- extension/data/shards/
git diff --stat HEAD -- extension/data/manifest.json
```

## Stop conditions

- If `npm test` fails, stop and investigate before proceeding.
- If shard data or `extension/data/manifest.json` changes unexpectedly, stop and explain.
- If the workflow requires secrets or dependencies beyond scope, stop and report.

## Escalation triggers

- Any need to change extension code or generated data to make the tests pass.
- Any need to add dependencies or broaden CI permissions.
- Any unexpected workflow interaction with existing automation.

## Context reset notes

This PR adds repo-level test orchestration only; it does not change extension
behaviour. Once merged, future tasks should treat `npm test` and the CI workflow
as the default validation entry points for the existing plain-Node tests.
