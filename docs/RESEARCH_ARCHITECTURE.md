# Research architecture

APISpy's research layer extends the existing observation and classification pipeline without making models responsible for network activity:

```text
DevTools observation
  -> existing scope filter / normaliser / shard matcher
  -> optional provider-operation enrichment
  -> sanitised research event
  -> deterministic differential findings
  -> optional advisory hypothesis provider
  -> bounded, non-executable test plans
  -> sanitised JSON session export
```

The governing principle is **models advise; deterministic controls execute**. This phase does not include an executor.

## Component ownership

### UndREST-SpecQL

SpecQL owns static API knowledge and generated inventory. Existing schema 3.0.0 shards provide route identity, provider namespace, API versions, operation IDs, source files, source kinds, and management/data-plane classification. Additive schema 3.1.0 shards optionally add documented auth requirements, parameter names, and bounded request/response schema summaries with structural fingerprints.

APISpy treats every 3.1.0 field as optional and remains compatible with 3.0.0 shards. Future additions should preserve that compatibility model. Resource hierarchy, richer version lineage, capability tags, and sensitivity annotations remain candidates for later versions.

### UndREST-APISpy

APISpy owns observed traffic, local sanitisation, deterministic correlation, findings, hypothesis-provider integration, user controls, and research-session export. Pack and normaliser extension points remain the route to future Microsoft Graph, Entra, portal/internal, M365, and service-specific API coverage.

## Trust boundaries

Observed requests, response metadata, documentation fields, enrichment records, resource names, and provider output are untrusted data.

Before persistence, export, or hypothesis-provider submission, APISpy:

- removes URL credentials and redacts sensitive query values;
- allowlists request headers and redacts authorization/cookie/key-like headers;
- decodes JWTs locally and retains only issuer, audience, tenant, client/app ID, scopes, roles, signing-key ID, and inferred context;
- stores request-body structure only as a deterministic JSON-shape fingerprint;
- omits raw request and response bodies;
- separates fixed provider instructions from an `untrusted_data` envelope;
- validates and bounds provider output.

AI is disabled by default. The bundled provider is local and deterministic. Provider failures or malformed output produce no hypotheses and cannot affect classification.

## Research event schema

Research events use schema version `1.1.0`. Important fields include:

- event/timestamp/correlation/source metadata;
- method, host, original and normalised paths, redacted query parameters, and API version;
- response status/content type where available;
- request/response schema fingerprints where available;
- deterministic classification state and reason;
- SpecQL route, versions, operation IDs, spec files, source kinds, pack/source, and plane;
- optional documented auth requirements, parameter names, and request/response schema summaries from SpecQL 3.1.0;
- provider enrichment capability/risk tags where available;
- non-secret JWT metadata;
- deterministic findings;
- optional validated hypotheses and bounded test plans;
- explicit redaction and trust status.

## Differential findings

The first slice emits structured findings for:

- documented routes observed with an unavailable API version;
- provider-known routes absent from the current shard;
- completely unmapped routes;
- known resource paths observed with undocumented HTTP methods;
- suspicious or capability-like query parameters;
- query parameters absent from SpecQL 3.1.0 operation metadata;
- observed request/response top-level fields absent from documented schema summaries;
- equivalent normalised operations observed through multiple hosts.

A finding records category, confidence, evidence, affected operations, why the discrepancy is interesting, relevant metadata, and the next investigative question. Findings do not claim vulnerabilities.

## Hypotheses and test plans

Provider output must be a machine-readable object containing a bounded `hypotheses` array. Every hypothesis requires manual approval. APISpy rejects malformed envelopes, invalid confidence values, missing evidence, or attempts to omit the approval gate.

Generated test plans describe but never execute an experiment. They include target host, method, path template, API version, authentication context, mutation type, safe expected outcome, hypothesis, evidence, scope requirements, read-only status, and explicit approval. Their `execution` field is always `not_supported`.

Any future executor must be a separate deterministic component with host/tenant/resource allowlists, method restrictions, rate limits, credential isolation, audit logging, and explicit approval gates.

## Persistence and export

The **Save Research** action writes portable JSON containing only sanitised research events, deterministic findings, optional hypotheses, provenance, and redaction status. AI state and provider provenance are explicit.

Existing sweep persistence is bounded and stores compact entries rather than raw HAR objects. Secret-bearing query values are redacted before URL persistence. Existing CSV and clipboard exports redact sensitive URL query values.

Generated inventory, pack manifests, provider-operation datasets, and demo screenshots remain owned by their existing generation pipelines and are not modified by the research layer.

## Phased evolution

1. **Completed vertical slice:** sanitised APISpy events, deterministic findings, local hypothesis adapter, manual test plans, detail UI, and JSON export.
2. **Completed additive metadata slice:** optional SpecQL 3.1.0 auth requirements, parameter names, and schema fingerprints/field summaries, consumed compatibly by APISpy research schema 1.1.0.
3. **Session correlation:** richer sibling, parent/child, version, host, permission, and control/data-plane comparisons across events and packs; future SpecQL metadata may add resource hierarchy, version lineage, capability tags, and sensitivity annotations.
4. **Additional Microsoft packs:** Graph, Entra/internal identity, portal/internal, M365 workloads, and service-specific APIs through existing pack/normaliser hooks.
5. **External providers, if approved:** adapters may submit only the same bounded model context used by the local adapter. Credential handling and provider configuration remain outside captured data.
6. **Separate future executor, if ever approved:** deterministic allowlists, tenant/resource boundaries, method restrictions, rate limits, audit logs, and per-plan human approval. It must not be part of the model adapter.

## Coupling risks

- Do not put live traffic or research sessions into SpecQL-generated shards.
- Do not make generic pack loading depend on Azure provider-operation enrichment.
- Do not couple provider interfaces to a single vendor SDK or response format.
- Do not change route-key or placeholder semantics to carry research metadata.
- Do not reuse portal-sweep authentication as model or test-execution credentials.
- Keep research schemas independent from generated inventory schemas so either project can evolve additively.
