# Microsoft Graph Pack Integration Plan

## Status

Active — user-approved implementation.

## Source

- Producer: UndREST-SpecQL commit `fc38c89b4922758b4198f62c244bbc490905c539`
- Metadata repository: `microsoftgraph/msgraph-metadata`
- Metadata revision: `b8cbef92f6959dca8150bf3edcc650863765e529`
- Candidate shard: `Microsoft.Graph.min.json`
- Host: `graph.microsoft.com`
- Routes: 47,451 (`v1.0`: 17,870; `beta`: 29,581)

## Implementation

1. Amend the APISpy contract before generated-data changes.
2. Use `scripts/prepare_data.py --source-dir ... --merge` to add a
   `microsoft-graph` pack; never hand-edit the generated shard or manifest entry.
3. Preserve the existing Azure pack and store Graph under
   `extension/data/shards/microsoft-graph/`.
4. Use the existing exact-host fallback and lazy loader; add no runtime fetches or
   Graph-specific normaliser branches.
5. Make repository-dispatch Azure refreshes use merge mode so replacing the Azure
   pack cannot remove the checked-in Graph pack.
6. Add focused tests for pack metadata, host selection, stable/preview matching,
   and OData operation metadata, and run generated-pack validation in CI.
7. Update user-facing pack documentation and durable cARL memory.

## Validation

- Full `npm test` and focused Python prepare-data tests.
- JavaScript syntax checks.
- Verify pinned source metadata, one Graph shard, exact host, route/version counts,
  v1.0 stable classification, beta preview classification, and `$select` metadata.
- Confirm Azure generated data and demos are unchanged except for the manifest's
  additive Graph pack entry.
- `git diff --check`, clean status after commit, and `carl doctor`.

## Stop conditions

- Source provenance differs from the approved pinned commit.
- Existing Azure pack or route classification regresses.
- Integration requires remote runtime updates or fabricated route metadata.
