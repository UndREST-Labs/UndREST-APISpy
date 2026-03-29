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
5. Parse and classify each operation (suffixKind, actionName, riskTags, …).
6. Write two JSON output files:

   azure-provider-operations-<timestamp>.json
       One record per (provider, resourceType, operationName) triple.

   azure-provider-summary-<timestamp>.json
       One record per provider namespace, with aggregate counts and a list of
       notable resource types (those involved in at least one high-risk action).

Prerequisites
-------------
    pip install azure-identity

Usage
-----
    # From the repository root:
    python scripts/provider_ops_sweep.py

    # With options:
    python scripts/provider_ops_sweep.py --output-dir ./results
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# ── Constants ─────────────────────────────────────────────────────────────────

AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
MANAGEMENT_SCOPE    = "https://management.azure.com/.default"
MANAGEMENT_BASE     = "https://management.azure.com"

SUBSCRIPTIONS_API_VERSION = "2022-12-01"
PROVIDERS_API_VERSION     = "2021-04-01"
OPERATIONS_API_VERSION    = "2021-04-01"

# ── Risk classification ───────────────────────────────────────────────────────

# Each entry is (keyword_fragment, [tags_to_add]).
# Evaluated against the lowercased action segment of the operation name
# (all path parts after provider/resourceType joined with "/").
_RISK_KEYWORD_TAGS: list[tuple[str, list[str]]] = [
    ("invoke",      ["invoke", "execution"]),
    ("execute",     ["execution"]),
    ("bypass",      ["bypass"]),
    ("escalat",     ["privilege-escalation"]),
    ("impersonat",  ["impersonation"]),
    ("assignrole",  ["privilege-escalation"]),
    ("roleassign",  ["privilege-escalation"]),
    ("token",       ["credential-proxy"]),
    ("credential",  ["credential-proxy"]),
    ("password",    ["credential-proxy"]),
    ("listkey",     ["key-access"]),
    ("secret",      ["secret-access"]),
    ("export",      ["data-exfiltration"]),
    ("download",    ["data-exfiltration"]),
    ("admin",       ["admin"]),
    ("run",         ["execution"]),
    ("deploy",      ["deployment"]),
]

# Tags that mark an action as "high risk" for the summary counters.
_HIGH_RISK_TAGS: frozenset[str] = frozenset([
    "invoke",
    "execution",
    "bypass",
    "privilege-escalation",
    "impersonation",
    "credential-proxy",
    "key-access",
    "secret-access",
    "data-exfiltration",
])

# ── HTTP method mapping ───────────────────────────────────────────────────────

_SUFFIX_TO_METHOD: dict[str, str] = {
    "action": "POST",
    "read":   "GET",
    "write":  "PUT",
    "delete": "DELETE",
}

# ── Service family mapping ────────────────────────────────────────────────────
# Used as a fallback when the ARM operations API does not supply a display
# provider name for the namespace.

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

# ── Authentication ────────────────────────────────────────────────────────────


def authenticate_device_code() -> object:
    """Authenticate via device code flow (same logic as portal_sweep.py).

    Returns a ``DeviceCodeCredential`` that can be passed to ``get_token()``
    to obtain (and auto-refresh) bearer tokens for the Management API.
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
    enumerations transparently handle token refresh.
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


# ── Parsing & classification ──────────────────────────────────────────────────


def _compute_risk_tags(action_segment: str) -> list[str]:
    """Return an ordered, deduplicated list of risk tags for an action segment.

    ``action_segment`` is all path parts of the operation name after the
    provider namespace and primary resource type, joined with ``/`` and
    lowercased before matching.
    """
    lower = action_segment.lower()
    tags: list[str] = []
    seen: set[str] = set()
    for keyword, new_tags in _RISK_KEYWORD_TAGS:
        if keyword in lower:
            for tag in new_tags:
                if tag not in seen:
                    tags.append(tag)
                    seen.add(tag)
    return tags


def _is_high_risk(risk_tags: list[str]) -> bool:
    """Return True if any of the supplied tags is in the high-risk set."""
    return any(tag in _HIGH_RISK_TAGS for tag in risk_tags)


def parse_operation(raw_op: dict) -> dict[str, Any] | None:
    """Parse a raw ARM operation entry into the per-operation detail record.

    Returns ``None`` for operations whose name cannot be parsed (fewer than
    two path segments).

    Operation name anatomy:
        ``{Provider}/{PrimaryResourceType}[/{SubType}]/{Suffix}``

    Examples:
        ``Microsoft.Web/connections/read``
            → resourceType=connections, suffixKind=read, actionName=read

        ``Microsoft.Web/connections/dynamicInvoke/action``
            → resourceType=connections, suffixKind=action, actionName=dynamicInvoke

        ``Microsoft.Compute/virtualMachines/extensions/write``
            → resourceType=virtualMachines, suffixKind=write, actionName=write
    """
    name: str = raw_op.get("name", "")
    if not name:
        return None

    parts = name.split("/")
    if len(parts) < 2:
        return None

    provider      = parts[0]
    resource_type = parts[1]
    suffix_kind   = parts[-1]

    # For explicit "action" verbs the segment immediately before the suffix is
    # the human-readable action name; for read/write/delete there is no
    # separate action verb so we use the suffix itself.
    # Works correctly for deeply nested resource types such as
    # ``Provider/resource/sub1/sub2/myAction/action`` — parts[-2] is always
    # the action verb regardless of how many sub-type segments precede it.
    if suffix_kind == "action" and len(parts) >= 4:
        action_name = parts[-2]
    else:
        action_name = suffix_kind

    # The "action segment" covers everything after provider and resourceType;
    # this is what the risk-tag keywords are matched against.
    action_segment = "/".join(parts[2:]) if len(parts) > 2 else suffix_kind

    # Prefer the API's display provider name as serviceFamily when available.
    display          = raw_op.get("display") or {}
    api_display_name = display.get("provider", "").strip()
    service_family   = api_display_name or _SERVICE_FAMILY.get(provider, provider)

    risk_tags = _compute_risk_tags(action_segment)
    # Defensively lowercase suffix_kind before lookup — the ARM API typically
    # returns lowercase suffixes (read/write/delete/action) but this guards
    # against any future casing variation.
    candidate_method = _SUFFIX_TO_METHOD.get(suffix_kind.lower(), "POST")

    return {
        "provider":        provider,
        "resourceType":    resource_type,
        "operationName":   name,
        "suffixKind":      suffix_kind,
        "actionName":      action_name,
        "serviceFamily":   service_family,
        "riskTags":        risk_tags,
        "candidateMethod": candidate_method,
    }


def build_provider_summary(
    provider: str, operations: list[dict]
) -> dict[str, Any]:
    """Build the per-provider summary record from its parsed operations."""
    resource_types = sorted({op["resourceType"] for op in operations})
    action_ops     = [op for op in operations if op["suffixKind"] == "action"]
    high_risk_ops  = [op for op in operations if _is_high_risk(op["riskTags"])]

    # Notable resource types are those that appear in at least one high-risk op.
    notable_resource_types = sorted(
        {op["resourceType"] for op in high_risk_ops}
    )

    return {
        "provider":             provider,
        "resourceTypes":        len(resource_types),
        "totalOperations":      len(operations),
        "actionOperations":     len(action_ops),
        "highRiskActions":      len(high_risk_ops),
        "notableResourceTypes": notable_resource_types,
    }


# ── Main sweep ────────────────────────────────────────────────────────────────


def sweep(
    credential: object,
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

    # ── Step 3: enumerate operations per provider ─────────────────────────────
    print("Enumerating provider operations…", file=sys.stderr)
    detail_records:  list[dict] = []
    summary_records: list[dict] = []
    total            = len(all_namespaces)

    for idx, ns in enumerate(all_namespaces, start=1):
        print(f"  [{idx}/{total}] {ns}", file=sys.stderr)
        raw_ops    = list_provider_operations(credential, ns)
        parsed_ops = [
            record
            for op in raw_ops
            if (record := parse_operation(op)) is not None
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


# ── CLI ───────────────────────────────────────────────────────────────────────


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Enumerate all Azure provider operations across all accessible "
            "subscriptions and export two JSON files: a per-operation detail "
            "file and a per-provider summary file."
        )
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path.cwd(),
        help=(
            "Directory to save the two JSON output files "
            "(default: current directory)."
        ),
    )
    return parser.parse_args()


# ── Entry point ───────────────────────────────────────────────────────────────


def main() -> None:
    args = _parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    print("Azure Provider Operations Sweep", file=sys.stderr)
    print(f"  Output dir: {args.output_dir}", file=sys.stderr)
    print("", file=sys.stderr)

    # ── Phase 1: authenticate ─────────────────────────────────────────────────
    credential = authenticate_device_code()

    # ── Phase 2: sweep ────────────────────────────────────────────────────────
    detail_records, summary_records = sweep(credential)

    # ── Phase 3: write output files ───────────────────────────────────────────
    ts           = time.strftime("%Y-%m-%dT%H-%M-%S")
    detail_path  = args.output_dir / f"azure-provider-operations-{ts}.json"
    summary_path = args.output_dir / f"azure-provider-summary-{ts}.json"

    detail_path.write_text(
        json.dumps(detail_records, indent=2), encoding="utf-8"
    )
    summary_path.write_text(
        json.dumps(summary_records, indent=2), encoding="utf-8"
    )

    print("", file=sys.stderr)
    print("Done.", file=sys.stderr)
    print(f"  Operations detail : {detail_path}")
    print(f"  Provider summary  : {summary_path}")


if __name__ == "__main__":
    main()
