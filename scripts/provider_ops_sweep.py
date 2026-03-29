#!/usr/bin/env python3
"""Enumerate Azure provider operations across all accessible subscriptions.

Workflow
--------
1. Authenticate to Azure via device code flow (same Azure CLI first-party app
   as portal_sweep.py — client ID 04b07795-…).
2. List all subscriptions accessible to the authenticated identity.
3. List all registered resource providers in each subscription, deduplicating
   by namespace so each provider is queried only once.
4. For every unique provider namespace, retrieve all defined operations from the
   ARM operations endpoint.
5. Classify each operation through a multi-stage pipeline:
   a. Parse the operation name into structured parts.
   b. Derive base tags from the suffix kind (read/write/delete/action).
   c. Match explicit classification rules against the action segment.
   d. Compute an explainable risk score with per-reason attribution.
6. Write output files (all timestamped):

   azure-provider-operations-<timestamp>.json
       One record per (provider, resourceType, operationName) triple.
       Includes capability, sensitivity, risk, and confidence tags plus a
       numeric riskScore and isHighRisk flag.

   azure-provider-summary-<timestamp>.json
       One record per provider namespace with aggregate counts, densities,
       and tag-family breakdowns.

   azure-top-risky-operations-<timestamp>.json  (optional, see --top-risky-count)
       The N operations with the highest riskScore.

Prerequisites
-------------
    pip install azure-identity

Usage
-----
    # From the repository root:
    python scripts/provider_ops_sweep.py

    # With options:
    python scripts/provider_ops_sweep.py \\
        --output-dir ./results \\
        --risk-threshold 6 \\
        --top-risky-count 100 \\
        --compact
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# ── Constants ─────────────────────────────────────────────────────────────────

AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
MANAGEMENT_SCOPE    = "https://management.azure.com/.default"
MANAGEMENT_BASE     = "https://management.azure.com"

SUBSCRIPTIONS_API_VERSION = "2022-12-01"
PROVIDERS_API_VERSION     = "2021-04-01"
OPERATIONS_API_VERSION    = "2021-04-01"

# ── Tunable threshold ─────────────────────────────────────────────────────────
# Operations with riskScore >= HIGH_RISK_THRESHOLD are flagged as isHighRisk.
# Pass --risk-threshold on the CLI to override at runtime.
HIGH_RISK_THRESHOLD: int = 6

# Decimal places used when rounding actionDensity and highRiskDensity.
DENSITY_PRECISION: int = 4

# Maximum number of risk tags included in the per-provider topRiskTags map.
TOP_RISK_TAGS_LIMIT: int = 10

# ── HTTP method mapping ───────────────────────────────────────────────────────

# Maps the terminal operation suffix to its most natural HTTP verb.
# Defensively lowercase-keyed so mixed-case responses from ARM are handled.
_SUFFIX_TO_METHOD: dict[str, str] = {
    "action": "POST",
    "read":   "GET",
    "write":  "PUT",
    "delete": "DELETE",
}

# ── Service family fallback mapping ───────────────────────────────────────────
# Used when the ARM operations endpoint does not supply a display.provider name.

_SERVICE_FAMILY: dict[str, str] = {
    "Microsoft.ApiManagement":          "API Management",
    "Microsoft.AppConfiguration":       "App Configuration",
    "Microsoft.Automation":             "Automation",
    "Microsoft.Authorization":          "Identity & Access",
    "Microsoft.Batch":                  "Batch",
    "Microsoft.Cache":                  "Azure Cache for Redis",
    "Microsoft.CognitiveServices":      "Cognitive Services / AI",
    "Microsoft.Compute":                "Compute / Virtual Machines",
    "Microsoft.ContainerRegistry":      "Container Registry",
    "Microsoft.ContainerService":       "Container Service (AKS)",
    "Microsoft.DataFactory":            "Data Factory",
    "Microsoft.DataLakeAnalytics":      "Data Lake Analytics",
    "Microsoft.DataLakeStore":          "Data Lake Storage",
    "Microsoft.Databricks":             "Azure Databricks",
    "Microsoft.DBforMySQL":             "Azure Database for MySQL",
    "Microsoft.DBforPostgreSQL":        "Azure Database for PostgreSQL",
    "Microsoft.Devices":                "IoT Hub",
    "Microsoft.DocumentDB":             "Cosmos DB",
    "Microsoft.EventGrid":              "Event Grid",
    "Microsoft.EventHub":               "Event Hubs",
    "Microsoft.HDInsight":              "HDInsight",
    "Microsoft.Insights":               "Azure Monitor",
    "Microsoft.KeyVault":               "Key Vault",
    "Microsoft.Logic":                  "Logic Apps",
    "Microsoft.MachineLearningServices":"Azure Machine Learning",
    "Microsoft.ManagedIdentity":        "Managed Identity",
    "Microsoft.Media":                  "Media Services",
    "Microsoft.Network":                "Networking",
    "Microsoft.NotificationHubs":       "Notification Hubs",
    "Microsoft.OperationalInsights":    "Log Analytics",
    "Microsoft.RecoveryServices":       "Recovery Services / Backup",
    "Microsoft.Resources":              "Resource Management",
    "Microsoft.Search":                 "Azure AI Search",
    "Microsoft.Security":               "Microsoft Defender for Cloud",
    "Microsoft.SecurityInsights":       "Microsoft Sentinel",
    "Microsoft.ServiceBus":             "Service Bus",
    "Microsoft.ServiceFabric":          "Service Fabric",
    "Microsoft.SignalRService":         "Azure SignalR Service",
    "Microsoft.Sql":                    "Azure SQL",
    "Microsoft.Storage":                "Storage",
    "Microsoft.StreamAnalytics":        "Stream Analytics",
    "Microsoft.Synapse":                "Azure Synapse Analytics",
    "Microsoft.Web":                    "App Service",
}

# ── Classification rules ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class ClassificationRule:
    """A single matching rule for operation classification.

    Rules are evaluated against the lowercased *action segment* of the
    operation name (everything after provider namespace and primary resource
    type, joined with "/").  This avoids false positives from keywords that
    appear in provider namespaces or primary resource type names.

    All matching rules accumulate their tags and score contributions.  More
    specific keywords (e.g. "listkey") carry a higher score than broad ones
    (e.g. "key") so the total reflects specificity.

    Attributes
    ----------
    keywords:
        Substrings; the rule fires when *any* keyword is found in the
        lowercased action segment.  Order is irrelevant — all keywords are
        checked independently.
    capability_tags:
        What the operation *does*.
    sensitivity_tags:
        The kind of sensitive boundary or asset touched.
    risk_tags:
        Why defenders should care.
    confidence_tags:
        How the inference was made (always includes "keyword-match" for rules).
    score:
        Score contribution added to riskScore when this rule fires.
    reason:
        Human-readable string written to riskReasons when this rule fires.
    """

    keywords: tuple[str, ...]
    capability_tags: tuple[str, ...]  = ()
    sensitivity_tags: tuple[str, ...] = ()
    risk_tags: tuple[str, ...]        = ()
    confidence_tags: tuple[str, ...]  = ("keyword-match",)
    score: int                        = 0
    reason: str                       = ""


# Ordered list of classification rules.  Rules are not mutually exclusive;
# every rule whose keywords appear in the action segment fires, and their
# contributions accumulate.  List order only matters for riskReasons output
# readability, not for correctness.
#
# Tag vocabulary:
#   capability  — read, write, delete, execution, invocation, deployment,
#                 configuration, linking, identity-management, network-control,
#                 data-access, data-movement, export, import
#   sensitivity — secret-material, key-material, credential-material,
#                 token-material, identity-boundary, role-boundary,
#                 network-boundary, public-exposure, cross-resource-trust,
#                 data-egress, destructive-surface
#   risk        — remote-execution, control-plane-to-data-plane, credential-proxy,
#                 secret-extraction, key-extraction, data-exfiltration,
#                 privilege-escalation, identity-impersonation,
#                 trust-boundary-crossing, bypass-pattern, persistence,
#                 lateral-movement, destructive-action, exposure-change,
#                 topology-change
#   confidence  — suffix-derived, keyword-match, resource-path-heuristic,
#                 provider-heuristic

_CLASSIFICATION_RULES: list[ClassificationRule] = [

    # ── A. Execution / invocation ─────────────────────────────────────────────

    ClassificationRule(
        keywords=("dynamicinvoke",),
        capability_tags=("execution", "invocation"),
        risk_tags=("remote-execution", "control-plane-to-data-plane"),
        score=5,
        reason="matched keyword 'dynamicInvoke'",
    ),
    ClassificationRule(
        keywords=("invoke",),
        capability_tags=("execution", "invocation"),
        risk_tags=("remote-execution", "control-plane-to-data-plane"),
        score=4,
        reason="matched keyword 'invoke'",
    ),
    ClassificationRule(
        keywords=("runcommand",),
        capability_tags=("execution",),
        risk_tags=("remote-execution", "control-plane-to-data-plane"),
        score=4,
        reason="matched keyword 'runCommand'",
    ),
    ClassificationRule(
        keywords=("execute", "script", "command"),
        capability_tags=("execution",),
        risk_tags=("remote-execution", "control-plane-to-data-plane"),
        score=4,
        reason="matched keyword 'execute'/'script'/'command'",
    ),
    # NOTE: bare "run" is intentionally excluded here — it is far too common
    # in non-execution contexts (e.g. "analysisRuns", "pipelineRuns").
    # Only explicit execution keywords above qualify as remote-execution.
    ClassificationRule(
        keywords=("trigger", "sync"),
        capability_tags=("execution", "invocation"),
        score=1,
        reason="matched lifecycle keyword 'trigger'/'sync'",
    ),
    ClassificationRule(
        keywords=("start", "restart", "stop", "resume", "suspend"),
        capability_tags=("execution",),
        score=1,
        reason="matched lifecycle control keyword",
    ),

    # ── B. Secrets / keys / credentials / tokens ──────────────────────────────
    # More specific rules carry a higher score to outweigh broader ones when
    # both fire (e.g. "listkeys" also contains "key", so both rules match).

    ClassificationRule(
        keywords=("listkeys", "listkey"),
        capability_tags=("data-access",),
        sensitivity_tags=("key-material",),
        risk_tags=("key-extraction",),
        score=4,
        reason="matched keyword 'listKeys'/'listKey'",
    ),
    ClassificationRule(
        keywords=("regeneratekey",),
        capability_tags=("data-access",),
        sensitivity_tags=("key-material",),
        risk_tags=("key-extraction",),
        score=4,
        reason="matched keyword 'regenerateKey'",
    ),
    ClassificationRule(
        keywords=("connectionstring",),
        capability_tags=("data-access",),
        sensitivity_tags=("credential-material",),
        risk_tags=("credential-proxy",),
        score=3,
        reason="matched keyword 'connectionString'",
    ),
    ClassificationRule(
        keywords=("secret", "secrets"),
        capability_tags=("data-access",),
        sensitivity_tags=("secret-material",),
        risk_tags=("secret-extraction",),
        score=4,
        reason="matched keyword 'secret'",
    ),
    ClassificationRule(
        keywords=("credential",),
        capability_tags=("identity-management",),
        sensitivity_tags=("credential-material",),
        risk_tags=("credential-proxy",),
        score=4,
        reason="matched keyword 'credential'",
    ),
    ClassificationRule(
        keywords=("password",),
        capability_tags=("identity-management",),
        sensitivity_tags=("credential-material",),
        risk_tags=("credential-proxy",),
        score=4,
        reason="matched keyword 'password'",
    ),
    ClassificationRule(
        keywords=("token",),
        capability_tags=("identity-management",),
        sensitivity_tags=("token-material",),
        risk_tags=("credential-proxy",),
        score=3,
        reason="matched keyword 'token'",
    ),
    ClassificationRule(
        keywords=("certificate", "cert"),
        capability_tags=("identity-management",),
        sensitivity_tags=("credential-material",),
        risk_tags=("credential-proxy",),
        score=3,
        reason="matched keyword 'certificate'/'cert'",
    ),
    ClassificationRule(
        keywords=("key", "keys"),
        capability_tags=("data-access",),
        sensitivity_tags=("key-material",),
        risk_tags=("key-extraction",),
        score=2,
        reason="matched keyword 'key'/'keys'",
    ),

    # ── C. Identity / privilege / federation ──────────────────────────────────

    ClassificationRule(
        keywords=("roleassign", "assignrole"),
        capability_tags=("identity-management",),
        sensitivity_tags=("identity-boundary", "role-boundary"),
        risk_tags=("privilege-escalation",),
        score=5,
        reason="matched keyword 'roleAssign'/'assignRole'",
    ),
    ClassificationRule(
        keywords=("escalate", "escalat"),
        capability_tags=("identity-management",),
        sensitivity_tags=("identity-boundary", "role-boundary"),
        risk_tags=("privilege-escalation",),
        score=5,
        reason="matched keyword 'escalate'",
    ),
    ClassificationRule(
        keywords=("impersonat",),
        capability_tags=("identity-management",),
        sensitivity_tags=("identity-boundary",),
        risk_tags=("identity-impersonation",),
        score=5,
        reason="matched keyword 'impersonat'",
    ),
    ClassificationRule(
        keywords=("federat",),
        capability_tags=("identity-management",),
        sensitivity_tags=("identity-boundary", "cross-resource-trust"),
        risk_tags=("trust-boundary-crossing",),
        score=4,
        reason="matched keyword 'federat'",
    ),
    ClassificationRule(
        keywords=("trust",),
        capability_tags=("identity-management",),
        sensitivity_tags=("cross-resource-trust",),
        risk_tags=("trust-boundary-crossing",),
        score=3,
        reason="matched keyword 'trust'",
    ),
    ClassificationRule(
        keywords=("assertion", "issuer"),
        capability_tags=("identity-management",),
        sensitivity_tags=("identity-boundary",),
        risk_tags=("trust-boundary-crossing",),
        score=3,
        reason="matched keyword 'assertion'/'issuer'",
    ),
    ClassificationRule(
        keywords=("role",),
        capability_tags=("identity-management",),
        sensitivity_tags=("role-boundary",),
        risk_tags=("privilege-escalation",),
        score=2,
        reason="matched keyword 'role'",
    ),
    ClassificationRule(
        keywords=("assign", "grant", "elevate"),
        capability_tags=("identity-management",),
        sensitivity_tags=("role-boundary",),
        risk_tags=("privilege-escalation",),
        score=2,
        reason="matched keyword 'assign'/'grant'/'elevate'",
    ),
    ClassificationRule(
        keywords=("owner", "principal"),
        capability_tags=("identity-management",),
        sensitivity_tags=("identity-boundary",),
        score=1,
        reason="matched keyword 'owner'/'principal'",
    ),
    ClassificationRule(
        keywords=("identity",),
        capability_tags=("identity-management",),
        sensitivity_tags=("identity-boundary",),
        score=1,
        reason="matched keyword 'identity'",
    ),

    # ── D. Networking / exposure ──────────────────────────────────────────────

    ClassificationRule(
        keywords=("public",),
        capability_tags=("network-control",),
        sensitivity_tags=("network-boundary", "public-exposure"),
        risk_tags=("exposure-change",),
        score=3,
        reason="matched keyword 'public'",
    ),
    ClassificationRule(
        keywords=("firewall",),
        capability_tags=("network-control",),
        sensitivity_tags=("network-boundary",),
        risk_tags=("exposure-change",),
        score=3,
        reason="matched keyword 'firewall'",
    ),
    ClassificationRule(
        keywords=("privateendpoint",),
        capability_tags=("network-control",),
        sensitivity_tags=("network-boundary",),
        risk_tags=("exposure-change",),
        score=2,
        reason="matched keyword 'privateEndpoint'",
    ),
    ClassificationRule(
        keywords=("ingress", "egress", "allow"),
        capability_tags=("network-control",),
        sensitivity_tags=("network-boundary",),
        risk_tags=("exposure-change",),
        score=2,
        reason="matched network access keyword",
    ),
    ClassificationRule(
        keywords=("endpoint", "ip", "peering", "dns", "route"),
        capability_tags=("network-control",),
        sensitivity_tags=("network-boundary",),
        score=1,
        reason="matched network keyword",
    ),

    # ── E. Linking / join / association ───────────────────────────────────────

    ClassificationRule(
        keywords=("join",),
        capability_tags=("linking",),
        sensitivity_tags=("cross-resource-trust",),
        risk_tags=("trust-boundary-crossing", "lateral-movement"),
        score=3,
        reason="matched keyword 'join'",
    ),
    ClassificationRule(
        keywords=("link", "associate", "attach"),
        capability_tags=("linking",),
        sensitivity_tags=("cross-resource-trust",),
        risk_tags=("trust-boundary-crossing",),
        score=2,
        reason="matched keyword 'link'/'associate'/'attach'",
    ),
    ClassificationRule(
        keywords=("connect",),
        capability_tags=("linking",),
        sensitivity_tags=("cross-resource-trust",),
        risk_tags=("trust-boundary-crossing",),
        score=2,
        reason="matched keyword 'connect'",
    ),
    ClassificationRule(
        keywords=("register", "approve", "accept"),
        capability_tags=("linking",),
        score=1,
        reason="matched linking keyword",
    ),
    ClassificationRule(
        keywords=("detach", "mount"),
        capability_tags=("linking",),
        score=1,
        reason="matched keyword 'detach'/'mount'",
    ),

    # ── F. Data movement / export / restore ───────────────────────────────────

    ClassificationRule(
        keywords=("export",),
        capability_tags=("data-movement", "export"),
        sensitivity_tags=("data-egress",),
        risk_tags=("data-exfiltration",),
        score=4,
        reason="matched keyword 'export'",
    ),
    ClassificationRule(
        keywords=("download",),
        capability_tags=("data-movement", "export"),
        sensitivity_tags=("data-egress",),
        risk_tags=("data-exfiltration",),
        score=4,
        reason="matched keyword 'download'",
    ),
    ClassificationRule(
        keywords=("copy", "replicate"),
        capability_tags=("data-movement",),
        sensitivity_tags=("data-egress",),
        risk_tags=("data-exfiltration",),
        score=2,
        reason="matched keyword 'copy'/'replicate'",
    ),
    ClassificationRule(
        keywords=("restore",),
        capability_tags=("data-movement", "import"),
        risk_tags=("destructive-action",),
        score=2,
        reason="matched keyword 'restore'",
    ),
    ClassificationRule(
        keywords=("import",),
        capability_tags=("data-movement", "import"),
        score=2,
        reason="matched keyword 'import'",
    ),
    ClassificationRule(
        keywords=("move", "migrate", "reassign"),
        capability_tags=("data-movement",),
        risk_tags=("topology-change",),
        score=2,
        reason="matched keyword 'move'/'migrate'/'reassign'",
    ),
    ClassificationRule(
        keywords=("backup",),
        capability_tags=("data-movement",),
        score=1,
        reason="matched keyword 'backup'",
    ),
    ClassificationRule(
        keywords=("upload",),
        capability_tags=("data-movement",),
        score=1,
        reason="matched keyword 'upload'",
    ),

    # ── G. Persistence / automation / triggers ────────────────────────────────

    ClassificationRule(
        keywords=("extension",),
        capability_tags=("configuration",),
        risk_tags=("persistence",),
        score=2,
        reason="matched keyword 'extension'",
    ),
    ClassificationRule(
        keywords=("startup", "schedule", "task"),
        capability_tags=("configuration", "execution"),
        risk_tags=("persistence",),
        score=2,
        reason="matched persistence keyword",
    ),
    ClassificationRule(
        keywords=("webhook",),
        capability_tags=("configuration",),
        risk_tags=("persistence",),
        score=2,
        reason="matched keyword 'webhook'",
    ),
    ClassificationRule(
        keywords=("automation",),
        capability_tags=("configuration", "execution"),
        risk_tags=("persistence",),
        score=1,
        reason="matched keyword 'automation'",
    ),
    ClassificationRule(
        keywords=("rule", "policy"),
        capability_tags=("configuration",),
        # rule/policy operations define configuration constraints — not
        # persistence mechanisms — so no persistence risk tag here.
        score=1,
        reason="matched policy/rule keyword",
    ),

    # ── H. Bypass / explicit danger words ────────────────────────────────────

    ClassificationRule(
        keywords=("bypass",),
        risk_tags=("bypass-pattern",),
        score=5,
        reason="matched keyword 'bypass'",
    ),

    # ── Miscellaneous ─────────────────────────────────────────────────────────

    ClassificationRule(
        keywords=("deploy",),
        capability_tags=("deployment",),
        score=1,
        reason="matched keyword 'deploy'",
    ),
    ClassificationRule(
        keywords=("admin",),
        sensitivity_tags=("identity-boundary",),
        score=2,
        reason="matched keyword 'admin'",
    ),
]


# Additional score boosts applied per serious risk tag present in the
# *accumulated* risk tag set.  Each boost fires at most once per tag.
_RISK_TAG_BOOSTS: dict[str, int] = {
    "privilege-escalation":        3,
    "remote-execution":            3,
    "secret-extraction":           3,
    "key-extraction":              3,
    "credential-proxy":            3,
    "identity-impersonation":      3,
    "control-plane-to-data-plane": 2,
    "topology-change":             1,
}

# Base riskScore contribution from the suffix kind alone.
_SUFFIX_BASE_SCORES: dict[str, int] = {
    "read":   0,
    "write":  1,
    "delete": 2,
    "action": 2,
}

# ── Authentication ────────────────────────────────────────────────────────────


def authenticate_device_code() -> object:
    """Authenticate via device code flow (same logic as portal_sweep.py).

    Returns a ``DeviceCodeCredential`` that can be passed to ``get_token()``
    to obtain (and auto-refresh) bearer tokens for the Management API.
    Blocks until the user completes the device code flow.
    """
    try:
        from azure.identity import DeviceCodeCredential
    except ImportError:
        print(
            "ERROR: azure-identity is not installed.\n"
            "       Run: pip install azure-identity",
            file=sys.stderr,
        )
        sys.exit(1)

    print("Requesting device code for Azure authentication…", file=sys.stderr)

    credential = DeviceCodeCredential(
        client_id=AZURE_CLI_CLIENT_ID,
        timeout=900,
    )

    # Acquiring the token triggers the device-code prompt on stderr.
    token = credential.get_token(MANAGEMENT_SCOPE)
    print(
        f"✓ Authenticated (token expires at "
        f"{time.strftime('%H:%M:%S', time.localtime(token.expires_on))})",
        file=sys.stderr,
    )
    return credential


# ── ARM HTTP helpers ──────────────────────────────────────────────────────────


def _arm_get(url: str, token: str) -> dict[str, Any]:
    """Perform a single authenticated GET against ARM and return the JSON body."""
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type":  "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        snippet = ""
        try:
            snippet = exc.read().decode()[:300]
        except Exception:
            pass
        raise RuntimeError(f"HTTP {exc.code} from {url}: {snippet}") from exc


def _paginate(url: str, credential: object) -> list[dict]:
    """Walk a paged ARM list endpoint and return all items across all pages.

    Calls ``credential.get_token()`` before each page request so that long
    enumerations transparently handle token refresh without interruption.
    """
    items: list[dict] = []
    next_url: str | None = url
    while next_url:
        token = credential.get_token(MANAGEMENT_SCOPE).token  # type: ignore[union-attr]
        data  = _arm_get(next_url, token)
        items.extend(data.get("value", []))
        next_url = data.get("nextLink")
    return items


# ── Enumeration helpers ───────────────────────────────────────────────────────


def list_subscriptions(credential: object) -> list[dict]:
    """Return all subscriptions accessible to the authenticated identity."""
    url = (
        f"{MANAGEMENT_BASE}/subscriptions"
        f"?api-version={SUBSCRIPTIONS_API_VERSION}"
    )
    return _paginate(url, credential)


def list_providers_for_subscription(
    credential: object, subscription_id: str
) -> list[dict]:
    """Return all registered resource providers in a subscription."""
    url = (
        f"{MANAGEMENT_BASE}/subscriptions/{subscription_id}/providers"
        f"?api-version={PROVIDERS_API_VERSION}&$expand=resourceTypes"
    )
    return _paginate(url, credential)


def list_provider_operations(credential: object, namespace: str) -> list[dict]:
    """Return all operations defined by a resource provider namespace.

    Returns an empty list (with a warning) if the endpoint is unreachable or
    returns an error, so that one bad provider does not abort the sweep.
    """
    url = (
        f"{MANAGEMENT_BASE}/providers/{namespace}/operations"
        f"?api-version={OPERATIONS_API_VERSION}"
    )
    try:
        return _paginate(url, credential)
    except Exception as exc:
        print(
            f"  WARNING: Could not fetch operations for {namespace}: {exc}",
            file=sys.stderr,
        )
        return []


# ── Classification pipeline ───────────────────────────────────────────────────


def parse_operation_name(name: str) -> dict[str, str] | None:
    """Parse a raw ARM operation name into its structural components.

    ARM operation names follow the pattern:
        ``{Provider}/{PrimaryResourceType}[/{SubType}…]/{Suffix}``

    For ``action`` operations an explicit action verb immediately precedes the
    terminal ``/action`` segment:
        ``{Provider}/{PrimaryResourceType}[/{SubType}…]/{ActionVerb}/action``

    Returns a dict with keys:
        provider, primaryResourceType, resourcePath, suffixKind, actionName

    Returns ``None`` when the name has fewer than two path segments.

    Examples
    --------
    ``Microsoft.Web/connections/read``
        → primaryResourceType=connections, resourcePath=connections,
          suffixKind=read, actionName=read

    ``Microsoft.Compute/virtualMachines/extensions/write``
        → primaryResourceType=virtualMachines,
          resourcePath=virtualMachines/extensions,
          suffixKind=write, actionName=write

    ``Microsoft.Web/connections/dynamicInvoke/action``
        → primaryResourceType=connections, resourcePath=connections,
          suffixKind=action, actionName=dynamicInvoke

    ``Provider/type/subtype/myAction/action``
        → primaryResourceType=type, resourcePath=type/subtype,
          suffixKind=action, actionName=myAction
    """
    if not name:
        return None
    parts = name.split("/")
    if len(parts) < 2:
        return None

    provider              = parts[0]
    primary_resource_type = parts[1]
    suffix_kind           = parts[-1]

    # For explicit "/action" verbs, the segment immediately before "action" is
    # the human-readable action name.  This works correctly for deeply nested
    # types: parts[-2] is always the verb regardless of how many sub-type
    # segments exist (e.g. Provider/type/sub1/sub2/myAction/action → myAction).
    if suffix_kind == "action" and len(parts) >= 4:
        action_name   = parts[-2]
        resource_path = "/".join(parts[1:-2])   # between provider and action verb
    else:
        # CRUD ops (read/write/delete) and bare 3-part "/action" ops:
        action_name   = suffix_kind
        resource_path = "/".join(parts[1:-1])   # between provider and suffix

    return {
        "provider":            provider,
        "primaryResourceType": primary_resource_type,
        "resourcePath":        resource_path,
        "suffixKind":          suffix_kind,
        "actionName":          action_name,
    }


def derive_suffix_defaults(suffix_kind: str) -> dict[str, Any]:
    """Return default capability/sensitivity tags and base score from suffixKind.

    These defaults are applied before any keyword rules fire.  The suffix
    alone gives us a baseline capability signal and a small risk score.

    Returns a dict with:
        capability_tags, sensitivity_tags, confidence_tags, base_score, reason
    """
    suffix_lower = suffix_kind.lower()

    if suffix_lower == "read":
        return {
            "capability_tags":  ["read"],
            "sensitivity_tags": [],
            "confidence_tags":  ["suffix-derived"],
            "base_score":       _SUFFIX_BASE_SCORES.get("read", 0),
            "reason":           "suffixKind=read",
        }
    if suffix_lower == "write":
        return {
            "capability_tags":  ["write"],
            "sensitivity_tags": [],
            "confidence_tags":  ["suffix-derived"],
            "base_score":       _SUFFIX_BASE_SCORES.get("write", 1),
            "reason":           "suffixKind=write",
        }
    if suffix_lower == "delete":
        return {
            "capability_tags":  ["delete"],
            "sensitivity_tags": ["destructive-surface"],
            "confidence_tags":  ["suffix-derived"],
            "base_score":       _SUFFIX_BASE_SCORES.get("delete", 2),
            "reason":           "suffixKind=delete",
        }
    if suffix_lower == "action":
        return {
            "capability_tags":  ["invocation"],
            "sensitivity_tags": [],
            "confidence_tags":  ["suffix-derived"],
            "base_score":       _SUFFIX_BASE_SCORES.get("action", 2),
            "reason":           "suffixKind=action",
        }
    # Unknown suffix — treat as a generic invocation with no base score.
    return {
        "capability_tags":  [],
        "sensitivity_tags": [],
        "confidence_tags":  ["suffix-derived"],
        "base_score":       0,
        "reason":           f"suffixKind={suffix_kind}",
    }


def match_rules(action_segment_lower: str) -> list[ClassificationRule]:
    """Return all ClassificationRules that match the lowercased action segment.

    ``action_segment_lower`` is the portion of the operation name *after* the
    provider namespace and primary resource type, lowercased and joined with
    "/" (e.g. ``"extensions/write"``, ``"dynamicinvoke/action"``).

    Rules are matched via substring search.  A rule fires when *any* of its
    keywords appear anywhere in the action segment string.
    """
    matched: list[ClassificationRule] = []
    for rule in _CLASSIFICATION_RULES:
        if any(kw in action_segment_lower for kw in rule.keywords):
            matched.append(rule)
    return matched


def compute_risk_score(
    base_score: int,
    matched_rules: list[ClassificationRule],
    all_risk_tags: list[str],
    suffix_reason: str,
) -> tuple[int, list[str]]:
    """Compute the final riskScore and riskReasons list.

    Scoring is fully additive and explainable:
      1. Start with base_score from suffixKind.
      2. Add each matched rule's score contribution.
      3. Apply a one-time boost for each serious risk tag present in the
         accumulated risk tag set (see ``_RISK_TAG_BOOSTS``).

    Returns ``(riskScore, riskReasons)`` where riskReasons is a sorted list
    of human-readable explanation strings for transparency.
    """
    score   = base_score
    reasons: list[str] = [suffix_reason] if suffix_reason else []

    for rule in matched_rules:
        score += rule.score
        if rule.reason:
            reasons.append(rule.reason)

    # Apply per-tag boosts for serious risk tags (each boost fires at most once).
    risk_tag_set = set(all_risk_tags)
    for tag, boost in _RISK_TAG_BOOSTS.items():
        if tag in risk_tag_set:
            score += boost
            reasons.append(f"boosted for risk tag '{tag}'")

    return score, sorted(reasons)


def _merge_tags(*tag_sequences: tuple | list) -> list[str]:
    """Merge multiple tag sequences into a sorted, deduplicated list."""
    seen: set[str] = set()
    merged: list[str] = []
    for seq in tag_sequences:
        for tag in seq:
            if tag not in seen:
                merged.append(tag)
                seen.add(tag)
    return sorted(merged)


def _derive_is_control_plane_bridge(
    action_segment_lower: str,
    risk_tags: list[str],
) -> bool:
    """Return True when the operation acts as a control-plane-to-data-plane bridge.

    A bridge operation lets the control plane reach across into the data plane
    (or a third-party back-end) — the defining UndREST risk concept.

    Detection heuristics (any one is sufficient):
    - The action segment contains an explicit invocation keyword.
    - The accumulated risk tags already contain 'control-plane-to-data-plane'.
    """
    # Keywords that indicate direct data-plane invocation from the control plane.
    _BRIDGE_KEYWORDS = (
        "invoke", "dynamicinvoke", "execute", "runcommand",
        "script", "command", "connections", "pipeline",
    )
    return (
        any(kw in action_segment_lower for kw in _BRIDGE_KEYWORDS)
        or "control-plane-to-data-plane" in risk_tags
    )


# Graph edge types for the Azure Atlas model.  Each operation can contribute
# to one or more edge types depending on its classification.
_EDGE_TYPE_SIGNALS: dict[str, dict[str, tuple[str, ...]]] = {
    "execution": {
        "capability_tags": ("execution", "invocation"),
    },
    "identity": {
        "capability_tags": ("identity-management",),
        "sensitivity_tags": ("identity-boundary", "role-boundary"),
    },
    "data": {
        "capability_tags": ("data-access", "data-movement", "export", "import"),
    },
    "network": {
        "capability_tags": ("network-control",),
        "sensitivity_tags": ("network-boundary",),
    },
    "trust": {
        "sensitivity_tags": ("cross-resource-trust",),
        "risk_tags": ("trust-boundary-crossing", "lateral-movement"),
    },
}


def _derive_edge_types(
    capability_tags: list[str],
    sensitivity_tags: list[str],
    risk_tags: list[str],
) -> list[str]:
    """Return graph edge type labels for the Atlas graph model.

    Edge types indicate the *relationship kind* this operation creates or
    modifies.  An operation may contribute multiple edge types.

    Values: "execution", "identity", "data", "network", "trust"
    """
    edges: set[str] = set()
    for edge, signals in _EDGE_TYPE_SIGNALS.items():
        if any(t in capability_tags for t in signals.get("capability_tags", ())):
            edges.add(edge)
        if any(t in sensitivity_tags for t in signals.get("sensitivity_tags", ())):
            edges.add(edge)
        if any(t in risk_tags for t in signals.get("risk_tags", ())):
            edges.add(edge)
    return sorted(edges)


def _derive_impact(
    capability_tags: list[str],
    sensitivity_tags: list[str],
    risk_tags: list[str],
) -> list[str]:
    """Map operation tags to CIA triad impact categories.

    Values: "confidentiality", "integrity", "availability"

    This gives a first-pass approximation; human review is needed for
    high-scoring operations.
    """
    impact: set[str] = set()

    # Confidentiality — exposure of sensitive material or data egress
    _CONF_SENSITIVITY = (
        "key-material", "secret-material",
        "credential-material", "token-material", "data-egress",
    )
    _CONF_RISK = ("key-extraction", "secret-extraction", "credential-proxy", "data-exfiltration")
    if (
        any(t in sensitivity_tags for t in _CONF_SENSITIVITY)
        or any(t in risk_tags     for t in _CONF_RISK)
    ):
        impact.add("confidentiality")

    # Integrity — privilege or trust changes that alter the security posture
    _INTEG_SENSITIVITY = ("identity-boundary", "role-boundary", "cross-resource-trust")
    _INTEG_RISK = (
        "privilege-escalation", "identity-impersonation",
        "trust-boundary-crossing", "bypass-pattern", "exposure-change",
        "topology-change",
    )
    if (
        any(t in sensitivity_tags for t in _INTEG_SENSITIVITY)
        or any(t in risk_tags     for t in _INTEG_RISK)
    ):
        impact.add("integrity")

    # Availability — destructive or overwrite operations
    _AVAIL_SENSITIVITY = ("destructive-surface",)
    _AVAIL_RISK        = ("destructive-action",)
    if (
        "delete" in capability_tags
        or any(t in sensitivity_tags for t in _AVAIL_SENSITIVITY)
        or any(t in risk_tags        for t in _AVAIL_RISK)
    ):
        impact.add("availability")

    return sorted(impact)


def classify_operation(
    raw_op: dict,
    risk_threshold: int = HIGH_RISK_THRESHOLD,
) -> dict[str, Any] | None:
    """Full classification pipeline for a single raw ARM operation entry.

    Stages
    ------
    1. Parse the operation name into structural components.
    2. Derive baseline tags and score from the suffix kind.
    3. Match keyword classification rules against the action segment.
    4. Merge and deduplicate all tag sets.
    4b. Read-operation guard: strip change-implying risk tags (exposure-change,
        destructive-action, topology-change) that keyword rules may have added,
        because read operations cannot cause state changes.
    5. Compute the final risk score with explainable reasons.
    6. Derive service family and HTTP method.
    7. Derive semantic fields: isControlPlaneBridge, edgeTypes, impact.
    8. Assemble and return the complete detail record.

    Returns ``None`` for operations that cannot be parsed (name missing or
    fewer than two path segments).

    Note on action-segment scoping
    --------------------------------
    Keyword rules are matched against ``parts[2:]`` only (everything after
    the provider namespace and primary resource type).  This prevents resource
    type names like "roleAssignments" or "firewallPolicies" from triggering
    false positives on *all* operations of that resource.  The trade-off is
    that 3-part operations (``Provider/ResourceType/suffix``) whose semantics
    live entirely in the resource type name will have minimal keyword matches;
    they are classified primarily via their suffix defaults.
    """
    name: str = raw_op.get("name", "")
    parsed    = parse_operation_name(name)
    if parsed is None:
        return None

    provider              = parsed["provider"]
    primary_resource_type = parsed["primaryResourceType"]
    resource_path         = parsed["resourcePath"]
    suffix_kind           = parsed["suffixKind"]
    action_name           = parsed["actionName"]

    # ── Stage 2: suffix defaults ──────────────────────────────────────────────
    suffix_defaults = derive_suffix_defaults(suffix_kind)

    # ── Stage 3: keyword rule matching ───────────────────────────────────────
    # Match against the lowercased action segment (parts[2:]), which is
    # everything after provider namespace and primary resource type.  Limiting
    # scope to the action segment prevents provider namespace keywords (e.g.
    # "keyvault" in "Microsoft.KeyVault") from triggering false positives on
    # all operations of that provider.
    parts                = name.split("/")
    action_segment_lower = "/".join(parts[2:]).lower() if len(parts) > 2 else ""
    matched              = match_rules(action_segment_lower)

    # ── Stage 4: merge tags (sorted + deduplicated for determinism) ───────────
    capability_tags  = _merge_tags(
        suffix_defaults["capability_tags"],
        *(r.capability_tags for r in matched),
    )
    sensitivity_tags = _merge_tags(
        suffix_defaults["sensitivity_tags"],
        *(r.sensitivity_tags for r in matched),
    )
    risk_tags        = _merge_tags(
        *(r.risk_tags for r in matched),
    )
    confidence_tags  = _merge_tags(
        suffix_defaults["confidence_tags"],
        *(r.confidence_tags for r in matched),
    )

    # ── Stage 4b: read-operation false-positive guard ─────────────────────────
    # Read operations cannot cause state changes, so strip any change-implying
    # risk tags that keyword rules may have added.  Sensitivity tags are still
    # allowed (reading a secret is still sensitive); only action-implying risk
    # tags are removed.
    if suffix_kind.lower() == "read":
        _READ_STRIP = frozenset(("exposure-change", "destructive-action", "topology-change"))
        risk_tags = [t for t in risk_tags if t not in _READ_STRIP]

    # ── Stage 5: risk scoring ─────────────────────────────────────────────────
    risk_score, risk_reasons = compute_risk_score(
        base_score    = suffix_defaults["base_score"],
        matched_rules = matched,
        all_risk_tags = risk_tags,
        suffix_reason = suffix_defaults["reason"],
    )
    is_high_risk = risk_score >= risk_threshold

    # ── Stage 6: service family and HTTP method ───────────────────────────────
    display          = raw_op.get("display") or {}
    api_display_name = display.get("provider", "").strip()
    service_family   = api_display_name or _SERVICE_FAMILY.get(provider, provider)

    # Defensively lowercase suffix_kind before lookup — the ARM API typically
    # returns lowercase suffixes (read/write/delete/action) but this guards
    # against any future casing variation.
    candidate_method = _SUFFIX_TO_METHOD.get(suffix_kind.lower(), "POST")

    # ── Stage 7: derived semantic fields ─────────────────────────────────────
    is_control_plane_bridge = _derive_is_control_plane_bridge(
        action_segment_lower, risk_tags
    )
    edge_types = _derive_edge_types(capability_tags, sensitivity_tags, risk_tags)
    impact     = _derive_impact(capability_tags, sensitivity_tags, risk_tags)

    # reasonSummary: short human-readable string joining the top reasons.
    reason_summary = "; ".join(risk_reasons) if risk_reasons else "no matched rules"

    # ── Assemble record ───────────────────────────────────────────────────────
    return {
        # Core identity / parse fields
        "provider":            provider,
        "resourceType":        primary_resource_type,   # compat alias
        "primaryResourceType": primary_resource_type,
        "resourcePath":        resource_path,
        "operationName":       name,
        "operationNameLower":  name.lower(),
        "suffixKind":          suffix_kind,
        "actionName":          action_name,
        "actionNameLower":     action_name.lower(),
        "resourcePathLower":   resource_path.lower(),
        # Display / service context
        "serviceFamily":       service_family,
        "candidateMethod":     candidate_method,
        "display":             display,
        # Classification tags
        "capabilityTags":      capability_tags,
        "sensitivityTags":     sensitivity_tags,
        "riskTags":            risk_tags,
        "confidenceTags":      confidence_tags,
        # Risk scoring
        "riskScore":           risk_score,
        "riskReasons":         risk_reasons,
        "reasonSummary":       reason_summary,
        "isHighRisk":          is_high_risk,
        # Semantic / graph fields
        "isControlPlaneBridge": is_control_plane_bridge,
        "edgeTypes":            edge_types,
        "impact":               impact,
    }


def build_provider_summary(
    provider: str,
    operations: list[dict],
) -> dict[str, Any]:
    """Build the per-provider summary record from its classified operations.

    Preserves all original fields for backward compatibility and adds richer
    density metrics and tag-family breakdowns useful for Atlas / UI consumption.
    """
    total          = len(operations)
    resource_types = sorted({op["primaryResourceType"] for op in operations})

    action_ops    = [op for op in operations if op["suffixKind"] == "action"]
    high_risk_ops = [op for op in operations if op["isHighRisk"]]

    # ── Density metrics ───────────────────────────────────────────────────────
    action_density    = round(len(action_ops) / total, DENSITY_PRECISION) if total else 0.0
    high_risk_density = (
        round(len(high_risk_ops) / len(action_ops), DENSITY_PRECISION)
        if action_ops else 0.0
    )

    max_risk_score = max((op["riskScore"] for op in operations), default=0)

    # ── Tag-family operation counts ───────────────────────────────────────────
    execution_actions          = sum(
        1 for op in operations if "execution" in op["capabilityTags"]
    )
    identity_sensitive_actions = sum(
        1 for op in operations if "identity-boundary" in op["sensitivityTags"]
    )
    secret_sensitive_actions   = sum(
        1 for op in operations if "secret-material" in op["sensitivityTags"]
    )
    key_sensitive_actions      = sum(
        1 for op in operations if "key-material" in op["sensitivityTags"]
    )
    destructive_actions        = sum(
        1 for op in operations
        if (
            "destructive-surface" in op["sensitivityTags"]
            or "destructive-action" in op["riskTags"]
            or "topology-change"   in op["riskTags"]
        )
    )
    network_exposure_actions   = sum(
        1 for op in operations if "exposure-change" in op["riskTags"]
    )

    # ── Top risk tags (frequency map, top TOP_RISK_TAGS_LIMIT by count) ─────────
    all_risk_tags: list[str] = [
        tag for op in operations for tag in op["riskTags"]
    ]
    top_risk_tags = dict(Counter(all_risk_tags).most_common(TOP_RISK_TAGS_LIMIT))

    # ── Notable resource types (involved in ≥ 1 high-risk op) ─────────────────
    notable_resource_types = sorted(
        {op["primaryResourceType"] for op in high_risk_ops}
    )

    return {
        # Existing fields (backward compat)
        "provider":             provider,
        "resourceTypes":        len(resource_types),
        "totalOperations":      total,
        "actionOperations":     len(action_ops),
        "highRiskActions":      len(high_risk_ops),
        "notableResourceTypes": notable_resource_types,
        # New density / scoring fields
        "actionDensity":         action_density,
        "highRiskDensity":       high_risk_density,
        "maxOperationRiskScore": max_risk_score,
        # Tag-family operation counts
        "executionActions":         execution_actions,
        "identitySensitiveActions": identity_sensitive_actions,
        "secretSensitiveActions":   secret_sensitive_actions,
        "keySensitiveActions":      key_sensitive_actions,
        "destructiveActions":       destructive_actions,
        "networkExposureActions":   network_exposure_actions,
        # Risk tag frequency map (top 10 tags by occurrence count)
        "topRiskTags":          top_risk_tags,
    }


# ── Main sweep ────────────────────────────────────────────────────────────────


def sweep(
    credential: object,
    risk_threshold: int = HIGH_RISK_THRESHOLD,
) -> tuple[list[dict], list[dict]]:
    """Enumerate all providers and their operations.

    Returns a pair ``(detail_records, summary_records)`` where:

    * ``detail_records`` — one dict per (provider, resourceType, operationName).
    * ``summary_records`` — one dict per provider namespace.
    """
    # ── Step 1: list subscriptions ────────────────────────────────────────────
    print("Enumerating subscriptions…", file=sys.stderr)
    subscriptions = list_subscriptions(credential)
    if not subscriptions:
        print("ERROR: No subscriptions found or accessible.", file=sys.stderr)
        sys.exit(1)
    print(f"  ✓ {len(subscriptions)} subscription(s) found.", file=sys.stderr)

    # ── Step 2: collect unique provider namespaces ────────────────────────────
    print("Enumerating providers across subscriptions…", file=sys.stderr)
    seen_namespaces: set[str]  = set()
    all_namespaces:  list[str] = []

    for sub in subscriptions:
        sub_id   = sub["subscriptionId"]
        sub_name = sub.get("displayName", sub_id)
        print(f"  Subscription: {sub_name} ({sub_id})", file=sys.stderr)
        try:
            providers = list_providers_for_subscription(credential, sub_id)
        except Exception as exc:
            print(
                f"  WARNING: Could not list providers for {sub_id}: {exc}",
                file=sys.stderr,
            )
            continue
        for prov in providers:
            ns = prov.get("namespace", "").strip()
            if ns and ns not in seen_namespaces:
                seen_namespaces.add(ns)
                all_namespaces.append(ns)

    all_namespaces.sort()
    print(
        f"  ✓ {len(all_namespaces)} unique provider namespace(s).",
        file=sys.stderr,
    )

    # ── Step 3: enumerate and classify operations per provider ────────────────
    print("Enumerating provider operations…", file=sys.stderr)
    detail_records:  list[dict] = []
    summary_records: list[dict] = []
    total                       = len(all_namespaces)

    for idx, ns in enumerate(all_namespaces, start=1):
        print(f"  [{idx}/{total}] {ns}", file=sys.stderr)
        raw_ops    = list_provider_operations(credential, ns)
        parsed_ops = [
            record
            for op in raw_ops
            if (record := classify_operation(op, risk_threshold)) is not None
        ]
        detail_records.extend(parsed_ops)
        if parsed_ops:
            summary_records.append(build_provider_summary(ns, parsed_ops))

    print(
        f"  ✓ {len(detail_records)} operation record(s) across "
        f"{len(summary_records)} provider(s).",
        file=sys.stderr,
    )
    return detail_records, summary_records


# ── Output helpers ────────────────────────────────────────────────────────────


def _write_json(path: Path, data: Any, indent: int | None = 2) -> None:
    """Write JSON to a file with consistent UTF-8 encoding."""
    path.write_text(
        json.dumps(data, indent=indent, ensure_ascii=False),
        encoding="utf-8",
    )


def _wrap_with_metadata(
    records: list[dict],
    ts: str,
    extra_meta: dict | None = None,
    risk_threshold: int = HIGH_RISK_THRESHOLD,
) -> dict[str, Any]:
    """Wrap a records list in a top-level envelope with metadata."""
    meta: dict[str, Any] = {
        "generatedAt":      ts,
        "script":           "provider_ops_sweep.py",
        "totalRecords":     len(records),
        "highRiskThreshold": risk_threshold,
    }
    if extra_meta:
        meta.update(extra_meta)
    return {"metadata": meta, "records": records}


# ── CLI ───────────────────────────────────────────────────────────────────────


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Enumerate all Azure provider operations across all accessible "
            "subscriptions and export structured JSON output files."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path.cwd(),
        help="Directory to save the JSON output files.",
    )
    parser.add_argument(
        "--risk-threshold",
        type=int,
        default=HIGH_RISK_THRESHOLD,
        metavar="N",
        help=(
            f"Operations with riskScore >= N are flagged as isHighRisk "
            f"(default: {HIGH_RISK_THRESHOLD})."
        ),
    )
    parser.add_argument(
        "--top-risky-count",
        type=int,
        default=100,
        metavar="N",
        help=(
            "Write an additional file with the top N operations by riskScore. "
            "Set to 0 to disable."
        ),
    )
    parser.add_argument(
        "--compact",
        action="store_true",
        default=False,
        help="Write compact (no-indent) JSON instead of pretty-printed JSON.",
    )
    return parser.parse_args()


# ── Entry point ───────────────────────────────────────────────────────────────


def main() -> None:
    args = _parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    indent = None if args.compact else 2

    print("Azure Provider Operations Sweep", file=sys.stderr)
    print(f"  Output dir      : {args.output_dir}", file=sys.stderr)
    print(f"  Risk threshold  : {args.risk_threshold}", file=sys.stderr)
    print(f"  Top risky count : {args.top_risky_count}", file=sys.stderr)
    print(f"  Compact JSON    : {args.compact}", file=sys.stderr)
    print("", file=sys.stderr)

    # ── Phase 1: authenticate ─────────────────────────────────────────────────
    credential = authenticate_device_code()

    # ── Phase 2: sweep ────────────────────────────────────────────────────────
    detail_records, summary_records = sweep(
        credential, risk_threshold=args.risk_threshold
    )

    # ── Phase 3: write output files ───────────────────────────────────────────
    ts           = time.strftime("%Y-%m-%dT%H-%M-%S")
    detail_path  = args.output_dir / f"azure-provider-operations-{ts}.json"
    summary_path = args.output_dir / f"azure-provider-summary-{ts}.json"

    high_risk_count = sum(1 for op in detail_records if op["isHighRisk"])
    provider_count  = len(summary_records)

    _write_json(
        detail_path,
        _wrap_with_metadata(
            detail_records,
            ts,
            extra_meta={
                "totalProviders":     provider_count,
                "highRiskOperations": high_risk_count,
            },
            risk_threshold=args.risk_threshold,
        ),
        indent=indent,
    )
    _write_json(
        summary_path,
        _wrap_with_metadata(
            summary_records,
            ts,
            risk_threshold=args.risk_threshold,
        ),
        indent=indent,
    )

    output_paths = [detail_path, summary_path]

    # ── Optional: top risky operations file ───────────────────────────────────
    if args.top_risky_count > 0:
        top_risky = sorted(
            detail_records,
            key=lambda op: (-op["riskScore"], op["operationName"]),
        )[: args.top_risky_count]
        top_risky_path = args.output_dir / f"azure-top-risky-operations-{ts}.json"
        _write_json(
            top_risky_path,
            _wrap_with_metadata(
                top_risky,
                ts,
                extra_meta={"requestedCount": args.top_risky_count},
                risk_threshold=args.risk_threshold,
            ),
            indent=indent,
        )
        output_paths.append(top_risky_path)

    print("", file=sys.stderr)
    print("Done.", file=sys.stderr)
    for path in output_paths:
        print(f"  {path}")


if __name__ == "__main__":
    main()
