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
import concurrent.futures
import json
import re
import sys
import threading
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

# ARM batch endpoint API version and request-count limit.
# https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/batch-requests
BATCH_API_VERSION = "2015-11-01"
BATCH_SIZE        = 20   # maximum sub-requests per ARM batch POST

# Thread pool size for concurrent batch calls, pagination follow-ups, and
# API-version retries.  Tune down if you hit ARM request-throttling (429).
MAX_WORKERS = 10

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


def _arm_post(url: str, token: str, body: dict[str, Any]) -> dict[str, Any]:
    """POST a JSON body to an ARM endpoint and return the JSON response body.

    Uses a 120-second timeout to accommodate batch requests that may bundle
    up to ``BATCH_SIZE`` sub-requests processed server-side.
    """
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type":  "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        snippet = ""
        try:
            snippet = exc.read().decode()[:300]
        except Exception:
            pass
        raise RuntimeError(f"HTTP {exc.code} from {url}: {snippet}") from exc


# Regex to extract an HTTP status code from the RuntimeError strings produced
# by _arm_get / _arm_post (format: "HTTP <code> from <url>: ...").
_HTTP_CODE_RE = re.compile(r"HTTP (\d{3}) from ")


def _extract_http_status(error_str: str) -> int | None:
    """Return the HTTP status code embedded in a ``RuntimeError`` message, or ``None``."""
    m = _HTTP_CODE_RE.search(error_str)
    return int(m.group(1)) if m else None


def _arm_batch_get(
    batch_requests: list[dict[str, str]],
    credential: object,
) -> list[dict[str, Any]]:
    """Submit up to ``BATCH_SIZE`` ARM GET requests via the ARM batch endpoint.

    Each element of ``batch_requests`` must be a dict with:
        ``name``  — arbitrary per-request identifier echoed in the response
        ``url``   — full ARM URL to GET (including ``api-version`` query param)

    Returns a list of response dicts, each containing:
        ``name``           — echoed from the request
        ``httpStatusCode`` — HTTP status code for that individual sub-request
        ``content``        — parsed JSON response body, or ``None``

    If the batch POST itself fails (network error, batch API unavailable, etc.),
    the caller receives synthetic ``{"httpStatusCode": 0}`` entries for every
    request in the chunk so that Phase 3 can fall back to individual retries.
    """
    token = credential.get_token(MANAGEMENT_SCOPE).token  # type: ignore[union-attr]
    batch_url  = f"{MANAGEMENT_BASE}/batch?api-version={BATCH_API_VERSION}"
    batch_body = {
        "requests": [
            {"httpMethod": "GET", "url": r["url"], "name": r["name"]}
            for r in batch_requests
        ]
    }
    result = _arm_post(batch_url, token, batch_body)
    return result.get("responses", [])


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

# Regex to extract the list of supported API versions from an ARM error body.
# ARM error messages follow the pattern (with single or double quotes):
#   "The supported api-versions are '2014-02-26,2014-04-01-preview'."
_SUPPORTED_VERSIONS_RE = re.compile(
    r"supported api-versions are ['\"]([^'\"]+)['\"]",
    re.IGNORECASE,
)


def _parse_supported_versions_from_error(error_body: str) -> list[str]:
    """Extract supported API versions from an ARM ``InvalidResourceType`` error body.

    ARM includes the list of accepted versions in the error message text when
    the requested version is unsupported, for example::

        "The resource type 'operations' could not be found in the namespace
        'microsoft.visualstudio' for api version '2021-04-01'.
        The supported api-versions are '2014-02-26,2014-04-01-preview'."

    Returns a list of version strings sorted newest-first, or an empty list
    if the pattern is not present in the error body.
    """
    m = _SUPPORTED_VERSIONS_RE.search(error_body)
    if not m:
        return []
    # Versions are comma-separated inside the quotes.
    versions = [v.strip() for v in m.group(1).split(",") if v.strip()]
    # Lexicographic reverse-sort produces newest-first for YYYY-MM-DD dates
    # and correctly places GA versions before preview variants of the same date.
    return sorted(versions, reverse=True)


def _collect_provider_api_hints(providers: list[dict]) -> dict[str, list[str]]:
    """Extract per-namespace API version hints from provider registration data.

    When the providers endpoint is called with ``$expand=resourceTypes``, each
    provider entry includes a ``resourceTypes`` array.  Each resource type has
    an ``apiVersions`` list.  While these versions apply to individual resource
    type CRUD calls (not directly to the ``/operations`` endpoint), ARM often
    accepts the same or an overlapping version range for both, making them
    useful fallbacks when the default ``OPERATIONS_API_VERSION`` is rejected.

    Returns a mapping of namespace (lowercased for case-insensitive lookup)
    → sorted list of API versions (newest-first, deduplicated across all
    resource types for that namespace).
    """
    hints: dict[str, list[str]] = {}
    for prov in providers:
        ns = prov.get("namespace", "").strip()
        if not ns:
            continue
        ns_key = ns.lower()  # normalise for case-insensitive lookup in sweep()
        versions: set[str] = set()
        for rt in prov.get("resourceTypes", []):
            for v in rt.get("apiVersions", []):
                if v and v.strip():
                    versions.add(v.strip())
        if versions:
            existing = set(hints.get(ns_key, []))
            existing.update(versions)
            hints[ns_key] = sorted(existing, reverse=True)
    return hints


def _build_error_record(
    namespace: str,
    versions_attempted: list[str],
    last_error: str,
) -> dict[str, Any]:
    """Build a structured error record for a namespace that could not be fetched.

    Parses the ``RuntimeError`` string produced by ``_arm_get`` / ``_arm_post``
    to extract the HTTP status code and, when available, the ARM error code and
    message from the embedded JSON snippet.

    The returned dict is suitable for inclusion in the errors output file.
    """
    http_status = _extract_http_status(last_error)

    error_code:    str | None = None
    error_message: str | None = None

    # The error string format is "HTTP <code> from <url>: <json_body>".
    # Using rfind(": {") correctly locates the separator before the JSON body,
    # even when the URL itself contains colons (e.g. "https://").
    json_sep = last_error.rfind(": {")
    if json_sep != -1:
        try:
            snippet_json = json.loads(last_error[json_sep + 2:])
            # Standard ARM error: {"error": {"code": "...", "message": "..."}}
            if "error" in snippet_json:
                error_code    = snippet_json["error"].get("code")
                error_message = snippet_json["error"].get("message")
            # OData error: {"odata.error": {"code": "...", "message": {"lang": ..., "value": ...}}}
            elif "odata.error" in snippet_json:
                odata = snippet_json["odata.error"]
                error_code = odata.get("code")
                msg_val    = odata.get("message")
                if isinstance(msg_val, dict):
                    error_message = msg_val.get("value")
                elif isinstance(msg_val, str):
                    error_message = msg_val
        except (json.JSONDecodeError, ValueError):
            pass

    return {
        "provider":          namespace,
        "versionsAttempted": versions_attempted,
        "lastError":         last_error,
        "httpStatusCode":    http_status,
        "errorCode":         error_code,
        "errorMessage":      error_message,
    }


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


def list_provider_operations(
    credential: object,
    namespace: str,
    api_version_hints: list[str] | None = None,
) -> tuple[list[dict], dict[str, Any] | None]:
    """Return all operations defined by a resource provider namespace.

    Tries ``OPERATIONS_API_VERSION`` first.  When ARM returns a 404 with an
    ``InvalidResourceType`` error — which happens when a provider's operations
    endpoint does not recognise the requested API version — the function
    automatically extracts the list of supported versions from the error body
    and retries with the newest one.  Any additional versions supplied via
    ``api_version_hints`` (typically derived from the provider's registered
    resource-type versions) are also tried as fallbacks in newest-first order.

    Returns a pair ``(operations, error_record)`` where:

    * ``operations``   — list of raw operation dicts (empty when all attempts fail)
    * ``error_record`` — a structured dict describing the failure, or ``None`` on success
    """
    # Build an ordered, deduplicated list of API versions to try.
    # ``OPERATIONS_API_VERSION`` is always first; hints follow newest-first.
    seen_versions: set[str] = set()
    candidates:    list[str] = []
    versions_attempted: list[str] = []  # every version actually sent to ARM

    def _add_candidate(v: str) -> None:
        """Append v to candidates only if not already queued."""
        if v and v not in seen_versions:
            seen_versions.add(v)
            candidates.append(v)

    _add_candidate(OPERATIONS_API_VERSION)
    for v in (api_version_hints or []):
        _add_candidate(v)

    last_error: str = ""
    extracted_from_error: bool = False  # only parse error body once per namespace

    # Iterate over candidates; the list may grow during iteration when
    # supported versions are extracted from an error response.
    idx = 0
    while idx < len(candidates):
        api_version = candidates[idx]
        idx += 1
        versions_attempted.append(api_version)
        url = (
            f"{MANAGEMENT_BASE}/providers/{namespace}/operations"
            f"?api-version={api_version}"
        )
        try:
            return _paginate(url, credential), None
        except Exception as exc:
            error_str = str(exc)
            last_error = error_str

            # When ARM reports InvalidResourceType it includes the list of
            # supported versions in the error body — parse and enqueue them
            # (but only once, to avoid duplicating work on subsequent retries).
            # Note: _arm_get wraps urllib.error.HTTPError into RuntimeError, so
            # the error body (including the error code and supported versions)
            # is always present in str(exc).
            if not extracted_from_error and "InvalidResourceType" in error_str:
                extracted_from_error = True
                extracted = _parse_supported_versions_from_error(error_str)
                added = [v for v in extracted if v not in seen_versions]
                for v in added:
                    _add_candidate(v)
                if added:
                    print(
                        f"    → retrying {namespace} with versions from error: "
                        f"{added[:3]}{'…' if len(added) > 3 else ''}",
                        file=sys.stderr,
                    )

    error_record = _build_error_record(namespace, versions_attempted, last_error)
    print(
        f"  WARNING: Could not fetch operations for {namespace}: {last_error}",
        file=sys.stderr,
    )
    return [], error_record


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


def _fetch_all_operations(
    credential: object,
    namespaces: list[str],
    ns_api_hints: dict[str, list[str]],
) -> tuple[dict[str, list[dict]], list[dict]]:
    """Fetch raw operations for all provider namespaces using batch + threading.

    Uses the ARM batch API to bundle up to ``BATCH_SIZE`` GET requests into a
    single HTTP POST, dramatically reducing connection overhead when there are
    hundreds of namespaces.  Multiple batch calls are dispatched concurrently
    via a ``ThreadPoolExecutor``.

    After the initial batch wave, any namespaces that need pagination follow-up
    (``nextLink`` in the response) or API-version retries (``InvalidResourceType``
    404) are handled with individual concurrent requests.

    Returns:
        ops_by_ns     — dict mapping each namespace to its list of raw operation dicts
        error_records — list of structured error dicts for permanently failed namespaces
    """
    ops_by_ns:        dict[str, list[dict]] = {}
    error_records:    list[dict]            = []
    needs_retry:      list[str]             = []     # batch-failed, retry individually
    pagination_queue: list[tuple[str, str]] = []     # (namespace, nextLink url)

    total     = len(namespaces)
    completed = 0
    counter_lock = threading.Lock()

    def _log_completion(ns: str) -> None:
        """Print a thread-safe progress line to stderr."""
        nonlocal completed
        with counter_lock:
            completed += 1
            print(f"  [{completed}/{total}] {ns}", file=sys.stderr)

    # ── Phase 1: initial batch wave ───────────────────────────────────────────
    # Split namespaces into chunks of BATCH_SIZE and POST each chunk concurrently.
    chunks = [
        namespaces[i : i + BATCH_SIZE]
        for i in range(0, len(namespaces), BATCH_SIZE)
    ]

    def _send_batch(chunk: list[str]) -> list[dict[str, Any]]:
        """Submit one batch of initial GET requests; returns ARM response list."""
        requests_payload = [
            {
                "name": ns,
                "url": (
                    f"{MANAGEMENT_BASE}/providers/{ns}/operations"
                    f"?api-version={OPERATIONS_API_VERSION}"
                ),
            }
            for ns in chunk
        ]
        try:
            return _arm_batch_get(requests_payload, credential)
        except Exception as exc:
            # Batch call itself failed (network error, batch API unavailable,
            # etc.).  Return synthetic 0-status entries so Phase 3 retries them.
            print(
                f"  WARNING: Batch request failed ({exc}); "
                f"will retry {len(chunk)} namespace(s) individually.",
                file=sys.stderr,
            )
            return [
                {"name": ns, "httpStatusCode": 0, "content": None}
                for ns in chunk
            ]

    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        batch_futures = [executor.submit(_send_batch, chunk) for chunk in chunks]
        for future in concurrent.futures.as_completed(batch_futures):
            for resp in future.result():
                ns      = resp.get("name", "")
                status  = resp.get("httpStatusCode", 0)
                content: dict[str, Any] | None = resp.get("content")

                if status == 200 and content is not None:
                    ops_by_ns[ns] = content.get("value", [])
                    next_link     = content.get("nextLink")
                    if next_link:
                        pagination_queue.append((ns, next_link))
                    _log_completion(ns)
                else:
                    # Any non-200 (incl. synthetic 0 from batch failure):
                    # fall through to Phase 3 which uses the full version-fallback logic.
                    needs_retry.append(ns)

    # ── Phase 2: concurrent pagination follow-up ──────────────────────────────
    # Some providers return very large operation lists that span multiple pages.
    # Follow each nextLink concurrently; errors here are non-fatal (we keep
    # whatever pages we already collected).
    if pagination_queue:
        def _follow_pages(ns: str, next_url: str) -> tuple[str, list[dict]]:
            """Walk remaining pages for a namespace and return the extra items."""
            extra: list[dict] = []
            current: str | None = next_url
            try:
                while current:
                    token   = credential.get_token(MANAGEMENT_SCOPE).token  # type: ignore[union-attr]
                    data    = _arm_get(current, token)
                    extra.extend(data.get("value", []))
                    current = data.get("nextLink")
            except Exception as exc:
                print(
                    f"  WARNING: Pagination failed for {ns}: {exc}",
                    file=sys.stderr,
                )
            return ns, extra

        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            pag_futures = [
                executor.submit(_follow_pages, ns, url)
                for ns, url in pagination_queue
            ]
            for future in concurrent.futures.as_completed(pag_futures):
                ns, extra_ops = future.result()
                # ops_by_ns[ns] is always set in Phase 1 for pagination-queue entries
                # (only 200 responses with nextLink reach this queue).
                ops_by_ns[ns].extend(extra_ops)

    # ── Phase 3: individual retries for batch-failed namespaces ──────────────
    # Uses the full list_provider_operations() logic which handles API-version
    # fallback (registration hints + error-body extraction).
    if needs_retry:
        def _retry_one(ns: str) -> tuple[str, list[dict], dict[str, Any] | None]:
            """Retry a single namespace with full version-fallback logic."""
            hints     = ns_api_hints.get(ns.lower(), [])
            ops, err  = list_provider_operations(credential, ns, hints)
            _log_completion(ns)
            return ns, ops, err

        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            retry_futures = [executor.submit(_retry_one, ns) for ns in needs_retry]
            for future in concurrent.futures.as_completed(retry_futures):
                ns, ops, err = future.result()
                ops_by_ns[ns] = ops
                if err is not None:
                    error_records.append(err)

    return ops_by_ns, error_records


def sweep(
    credential: object,
    risk_threshold: int = HIGH_RISK_THRESHOLD,
) -> tuple[list[dict], list[dict], list[dict]]:
    """Enumerate all providers and their operations.

    Returns a triple ``(detail_records, summary_records, error_records)`` where:

    * ``detail_records``  — one dict per (provider, resourceType, operationName).
    * ``summary_records`` — one dict per provider namespace.
    * ``error_records``   — one dict per namespace that could not be fetched.
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
    seen_namespaces: set[str]    = set()
    all_namespaces:  list[str]   = []
    all_provider_data: list[dict] = []  # accumulate all provider objects for hint extraction

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
        all_provider_data.extend(providers)
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

    # Build a per-namespace map of API version hints extracted from the
    # resourceTypes registration data.  These are used as fallbacks when the
    # default OPERATIONS_API_VERSION is rejected by a provider's operations
    # endpoint.  Keys are lowercased for case-insensitive lookup.
    ns_api_hints = _collect_provider_api_hints(all_provider_data)

    # ── Step 3: enumerate operations per provider (batch + concurrent) ────────
    print(
        f"Enumerating provider operations "
        f"(batch={BATCH_SIZE}, workers={MAX_WORKERS})…",
        file=sys.stderr,
    )
    ops_by_ns, error_records = _fetch_all_operations(
        credential, all_namespaces, ns_api_hints
    )

    # ── Step 4: classify operations and build detail / summary records ────────
    detail_records:  list[dict] = []
    summary_records: list[dict] = []

    for ns in all_namespaces:
        raw_ops    = ops_by_ns.get(ns, [])
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
    if error_records:
        print(
            f"  ⚠ {len(error_records)} provider(s) could not be fetched "
            f"(see errors output file).",
            file=sys.stderr,
        )
    return detail_records, summary_records, error_records


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
    detail_records, summary_records, error_records = sweep(
        credential, risk_threshold=args.risk_threshold
    )

    # ── Phase 3: write output files ───────────────────────────────────────────
    ts           = time.strftime("%Y-%m-%dT%H-%M-%S")
    detail_path  = args.output_dir / f"azure-provider-operations-{ts}.json"
    summary_path = args.output_dir / f"azure-provider-summary-{ts}.json"
    errors_path  = args.output_dir / f"azure-provider-errors-{ts}.json"

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
    _write_json(
        errors_path,
        _wrap_with_metadata(
            error_records,
            ts,
            extra_meta={"totalErrors": len(error_records)},
            risk_threshold=args.risk_threshold,
        ),
        indent=indent,
    )

    output_paths = [detail_path, summary_path, errors_path]

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
