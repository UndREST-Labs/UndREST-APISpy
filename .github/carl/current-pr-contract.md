<!-- version: 1.1.0 -->
# Current PR Contract

This contract constrains implementation scope for the active PR. Update
it when scope is explicitly amended. If a requested action falls outside
approved scope, stop and escalate before proceeding.

## Goal

Install the cARL governance runtime into UndREST-APISpy and populate
durable agent governance artefacts so that future sessions start with
full architectural context without re-prompting.

## Contract status

active

## Non-goals

- No product code changes.
- No extension behaviour changes.
- No shard data regeneration or modification of `extension/data/shards/`.
- No changes to `extension/data/manifest.json` beyond what cARL requires.
- No new GitHub Actions workflows beyond what cARL installs.
- No changes to existing workflows (`update-shards.yml`, `update-screenshots.yml`).

## Carry-forward rules

The following are **durable invariants** promoted from this PR into `memory.md`:
- Do not hand-edit generated shard files or `extension/data/manifest.json`.
- JS tests must pass with plain `node` — no browser, no Azure auth.
- The extension must remain offline-capable with no runtime network dependencies.
- `SPEQL_READ_TOKEN` must never be logged, echoed, or committed.
- cARL artefacts in `.github/carl/` are the canonical governance authority.

## Approved scope

- Install cARL CLI (v0.4.2) and run `carl init` to write the runtime artefacts.
- Populate `.github/carl/memory.md` with APISpy-specific architecture, workflows,
  test commands, generated artefacts, and security assumptions.
- Create `.github/carl/current-pr-contract.md` (this file) for the installation PR.
- Update `CONTRIBUTING.md` to document cARL usage for future contributors and agents.
- Run and confirm existing JS unit tests pass.
- Run `carl version` and `carl doctor` to confirm runtime health.

## Intentional amendments

None. This is the initial cARL installation; there are no prior PR constraints to amend.

## Forbidden scope

- Modifying `extension/` source files (JS, HTML, CSS, manifest).
- Modifying `extension/data/shards/` or `extension/data/manifest.json`.
- Adding or removing npm/Python dependencies.
- Changing any GitHub Actions workflow logic.
- Refactoring any product code.
- Running Azure Portal sweep, provider ops sweep, or any script requiring Azure auth.

## Architectural constraints

- cARL artefacts are installed under `.github/carl/` and `.github/instructions/` — these paths are standard and must not be relocated.
- `memory.md` is protected; `carl repair` does not overwrite it.
- The pack manifest and shard data are generated artefacts; governance documentation must reflect this.

## Security constraints

- No secrets, credentials, or tokens committed.
- No Azure subscription IDs or tenant IDs in any committed file.
- `SPEQL_READ_TOKEN` referenced only by name in workflow YAML — never its value.

## Files expected to change

- `.github/copilot-instructions.md` — created by `carl init`
- `.github/carl/runtime.json` — created by `carl init`
- `.github/carl/memory.md` — populated with APISpy-specific facts
- `.github/carl/current-pr-contract.md` — this file (created)
- `.github/carl/invariants.yml` — created by `carl init`
- `.github/carl/trust-boundaries.md` — created by `carl init`
- `.github/carl/tool-policy.yml` — created by `carl init`
- `.github/carl/plans/README.md` — created by `carl init`
- `.github/carl/plans/plan-template.md` — created by `carl init`
- `.github/carl/repo-map.example.json` — created by `carl init`
- `.github/carl/current-pr-contract.template.md` — created by `carl init`
- `.github/instructions/core/*.instructions.md` — created by `carl init` (9 files)
- `.github/instructions/languages/*.instructions.md` — created by `carl init` (7 files)
- `.github/instructions/platform/*.instructions.md` — created by `carl init` (3 files)
- `.github/instructions/cloud/*.instructions.md` — created by `carl init` (5 files)
- `CONTRIBUTING.md` — updated to document cARL usage

## Tests / validation

```bash
# cARL runtime health
carl version   # CLI 0.4.2, Runtime 1.0.0, Status: Healthy
carl doctor    # INFO: runtime is healthy

# JavaScript unit tests (all must pass with plain node, no auth)
# Counts verified at installation date 2026-06-30; counts may grow as tests are added
node tests/test_filters.js    # 22 passed at install date
node tests/test_loader.js     # 43 passed at install date
node tests/test_normalizer.js # 95 passed at install date
node tests/test_matcher.js    # 167 passed at install date

# Confirm no shard churn
git diff --stat HEAD -- extension/data/shards/   # must show no changes
git diff --stat HEAD -- extension/data/manifest.json  # must show no changes
```

## Stop conditions

- If `carl init` fails or produces unexpected output, stop and report.
- If any JS test fails, stop and investigate before proceeding.
- If shard data changes unexpectedly, stop and explain before proceeding.
- If any script requires Azure credentials that are unavailable, document and do not fake success.

## Escalation triggers

- Unexpected modification of `extension/data/` by any cARL command.
- `carl doctor` reporting anything other than healthy after `carl init`.
- JS test failures introduced by this change.

## Context reset notes

This PR installs cARL governance; no product behaviour changes. Once merged,
close this contract. Future tasks should open a new `current-pr-contract.md`
with their own goal and scope. The durable invariants captured in `memory.md`
carry forward automatically.
