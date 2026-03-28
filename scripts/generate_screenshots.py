#!/usr/bin/env python3
"""Generate screenshots of the APISpy extension panel in various states.

Uses Playwright to load panel.html with mocked Chrome extension APIs,
injects representative mock request entries, and captures PNG screenshots.

Output (written to demos/):
  apispy-empty.png     – initial state, no requests observed
  apispy-requests.png  – populated table with mixed request statuses
  apispy-filter.png    – column-filter dropdown open on the Status column
  apispy-detail.png    – table with a row selected and the detail panel open

Usage (from the repository root):
  python3 apispy/scripts/generate_screenshots.py

Dependencies:
  pip install playwright
  python3 -m playwright install chromium
"""

import http.server
import os
import sys
import threading
from pathlib import Path

# ── Paths ─────────────────────────────────────────────────────────────────────

REPO_ROOT      = Path(__file__).resolve().parent.parent.parent
EXTENSION_DIR  = REPO_ROOT / "apispy" / "extension"
DEMOS_DIR      = REPO_ROOT / "demos"

# ── Local HTTP server ─────────────────────────────────────────────────────────


class _SilentHandler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler with logging suppressed."""

    def log_message(self, fmt, *args):  # noqa: ARG002
        pass


def _start_server(directory: Path) -> int:
    """Bind to a free port, start a background HTTP server, and return the port."""
    import socket

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    def _make_handler(*args, **kwargs):
        return _SilentHandler(*args, directory=str(directory), **kwargs)

    server = http.server.HTTPServer(("127.0.0.1", port), _make_handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return port


# ── JavaScript injected before any page script runs ──────────────────────────

_CHROME_MOCK_JS = """
(function () {
  // Minimal chrome extension API stub so panel.js initialises without errors.
  // chrome.runtime.getURL redirects extension resource paths to the local
  // HTTP server URL set by the screenshot harness.
  window.chrome = {
    runtime: {
      getURL: function (path) {
        return window.__extensionBaseUrl + '/' + path;
      }
    },
    devtools: {
      network: {
        onRequestFinished: { addListener: function () {} }
      }
    }
  };
}());
"""

# ── Mock request entries injected after page initialisation ──────────────────

_INJECT_ENTRIES_JS = """
(function injectMockEntries() {
  var BASE = "https://management.azure.com";
  var SUB  = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

  var entries = [
    // 1 — Exact match: list storage accounts
    {
      idx: 0,
      time: "10:23:11",
      url:  BASE + "/subscriptions/" + SUB
              + "/resourceGroups/rg-production/providers/Microsoft.Storage"
              + "/storageAccounts?api-version=2023-05-01",
      method:     "GET",
      host:       "management.azure.com",
      pathname:   "/subscriptions/{guid}/resourceGroups/rg-production"
                + "/providers/Microsoft.Storage/storageAccounts",
      normPath:   "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}"
                + "/providers/Microsoft.Storage/storageAccounts",
      apiVersion: "2023-05-01",
      norm: { ok: true },
      result: {
        status:            "exact_match",
        label:             "\u2705 Exact match",
        provider_namespace: "Microsoft.Storage",
        reason:            "exact",
        matched_route_key: "GET /subscriptions/{subscriptionId}/resourceGroups"
                         + "/{resourceGroupName}/providers/Microsoft.Storage/storageAccounts",
        matched_versions:  ["2023-05-01", "2022-09-01", "2021-09-01"],
        shard_name:        "Microsoft.Storage",
        error:             null
      },
      raw: {}
    },

    // 2 — Version mismatch: PUT Key Vault key with an unknown api-version
    {
      idx: 1,
      time: "10:23:14",
      url:  BASE + "/subscriptions/" + SUB
              + "/resourceGroups/rg-production/providers/Microsoft.KeyVault"
              + "/vaults/kv-prod/keys/signing-key?api-version=2024-11-01",
      method:     "PUT",
      host:       "management.azure.com",
      pathname:   "/subscriptions/{guid}/resourceGroups/rg-production"
                + "/providers/Microsoft.KeyVault/vaults/kv-prod/keys/signing-key",
      normPath:   "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}"
                + "/providers/Microsoft.KeyVault/vaults/{vaultName}/keys/{keyName}",
      apiVersion: "2024-11-01",
      norm: { ok: true },
      result: {
        status:            "route_match_version_mismatch",
        label:             "\u26a0\ufe0f Version mismatch",
        provider_namespace: "Microsoft.KeyVault",
        reason:            "version_not_found",
        matched_route_key: "PUT /subscriptions/{subscriptionId}/resourceGroups"
                         + "/{resourceGroupName}/providers/Microsoft.KeyVault"
                         + "/vaults/{vaultName}/keys/{keyName}",
        matched_versions:  ["2023-07-01", "2022-07-01", "2021-10-01"],
        shard_name:        "Microsoft.KeyVault",
        error:             null
      },
      raw: {}
    },

    // 3 — Unknown route: Compute VM extension not in spec
    {
      idx: 2,
      time: "10:23:17",
      url:  BASE + "/subscriptions/" + SUB
              + "/resourceGroups/rg-production/providers/Microsoft.Compute"
              + "/virtualMachines/vm-workload-01/customScriptExtension"
              + "?api-version=2024-07-01",
      method:     "GET",
      host:       "management.azure.com",
      pathname:   "/subscriptions/{guid}/resourceGroups/rg-production"
                + "/providers/Microsoft.Compute/virtualMachines/vm-workload-01"
                + "/customScriptExtension",
      normPath:   "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}"
                + "/providers/Microsoft.Compute/virtualMachines/{vmName}"
                + "/customScriptExtension",
      apiVersion: "2024-07-01",
      norm: { ok: true },
      result: {
        status:            "provider_known_route_unknown",
        label:             "\uD83D\uDD36 Unknown route",
        provider_namespace: "Microsoft.Compute",
        reason:            "route_not_found",
        matched_route_key: null,
        matched_versions:  null,
        shard_name:        "Microsoft.Compute",
        error:             null
      },
      raw: {}
    },

    // 4 — Exact match: list virtual networks
    {
      idx: 3,
      time: "10:23:19",
      url:  BASE + "/subscriptions/" + SUB
              + "/resourceGroups/rg-networking/providers/Microsoft.Network"
              + "/virtualNetworks?api-version=2024-05-01",
      method:     "GET",
      host:       "management.azure.com",
      pathname:   "/subscriptions/{guid}/resourceGroups/rg-networking"
                + "/providers/Microsoft.Network/virtualNetworks",
      normPath:   "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}"
                + "/providers/Microsoft.Network/virtualNetworks",
      apiVersion: "2024-05-01",
      norm: { ok: true },
      result: {
        status:            "exact_match",
        label:             "\u2705 Exact match",
        provider_namespace: "Microsoft.Network",
        reason:            "exact",
        matched_route_key: "GET /subscriptions/{subscriptionId}/resourceGroups"
                         + "/{resourceGroupName}/providers/Microsoft.Network/virtualNetworks",
        matched_versions:  ["2024-05-01", "2024-03-01", "2023-11-01"],
        shard_name:        "Microsoft.Network",
        error:             null
      },
      raw: {}
    },

    // 5 — Exact match: POST batch sub-request (Web app)
    {
      idx: 4,
      time: "10:23:22",
      url:  BASE + "/subscriptions/" + SUB
              + "/resourceGroups/rg-apps/providers/Microsoft.Web"
              + "/sites/webapp-frontend?api-version=2023-12-01",
      method:     "GET",
      host:       "management.azure.com",
      pathname:   "/subscriptions/{guid}/resourceGroups/rg-apps"
                + "/providers/Microsoft.Web/sites/webapp-frontend",
      normPath:   "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}"
                + "/providers/Microsoft.Web/sites/{name}",
      apiVersion: "2023-12-01",
      isBatchSub: true,
      batchName:  "0",
      norm: { ok: true },
      result: {
        status:            "exact_match",
        label:             "\u2705 Exact match",
        provider_namespace: "Microsoft.Web",
        reason:            "exact",
        matched_route_key: "GET /subscriptions/{subscriptionId}/resourceGroups"
                         + "/{resourceGroupName}/providers/Microsoft.Web/sites/{name}",
        matched_versions:  ["2023-12-01", "2022-09-01"],
        shard_name:        "Microsoft.Web",
        error:             null
      },
      raw: {}
    },

    // 6 — Version mismatch: DELETE App Service plan
    {
      idx: 5,
      time: "10:23:28",
      url:  BASE + "/subscriptions/" + SUB
              + "/resourceGroups/rg-apps/providers/Microsoft.Web"
              + "/serverfarms/asp-free?api-version=2025-01-01",
      method:     "DELETE",
      host:       "management.azure.com",
      pathname:   "/subscriptions/{guid}/resourceGroups/rg-apps"
                + "/providers/Microsoft.Web/serverfarms/asp-free",
      normPath:   "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}"
                + "/providers/Microsoft.Web/serverfarms/{name}",
      apiVersion: "2025-01-01",
      norm: { ok: true },
      result: {
        status:            "route_match_version_mismatch",
        label:             "\u26a0\ufe0f Version mismatch",
        provider_namespace: "Microsoft.Web",
        reason:            "version_not_found",
        matched_route_key: "DELETE /subscriptions/{subscriptionId}/resourceGroups"
                         + "/{resourceGroupName}/providers/Microsoft.Web/serverfarms/{name}",
        matched_versions:  ["2023-12-01", "2022-09-01", "2021-02-01"],
        shard_name:        "Microsoft.Web",
        error:             null
      },
      raw: {}
    },

    // 7 — ARM root route: list subscriptions
    {
      idx: 6,
      time: "10:23:33",
      url:  BASE + "/subscriptions?api-version=2022-12-01",
      method:     "GET",
      host:       "management.azure.com",
      pathname:   "/subscriptions",
      normPath:   "/subscriptions",
      apiVersion: "2022-12-01",
      norm: { ok: true },
      result: {
        status:            "arm_root_route",
        label:             "\u2139\ufe0f ARM root route",
        provider_namespace: null,
        reason:            "arm_root_no_provider",
        matched_route_key: null,
        matched_versions:  null,
        shard_name:        null,
        error:             null
      },
      raw: {}
    }
  ];

  entries.forEach(function (entry) {
    state.requests.push(entry);
    renderRow(entry, state.requests.length - 1);
  });

  updateCountBadge();
  setStatus("302 providers bundled (export 3/21/2026)");
}());
"""

# ── Screenshot capture ────────────────────────────────────────────────────────


def _generate(port: int) -> None:
    from playwright.sync_api import sync_playwright

    base_url = f"http://127.0.0.1:{port}"
    DEMOS_DIR.mkdir(exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 720})

        # Inject the chrome stub before any extension script runs.
        context.add_init_script(
            f"window.__extensionBaseUrl = '{base_url}';\n{_CHROME_MOCK_JS}"
        )

        page = context.new_page()

        # ── Load the panel ──────────────────────────────────────────────────
        page.goto(f"{base_url}/panel.html", wait_until="networkidle")

        # Wait for init() to finish loading the data manifest.
        page.wait_for_function(
            "document.getElementById('status-text').textContent"
            ".includes('providers bundled')",
            timeout=10_000,
        )

        # ── Screenshot 1: empty state ───────────────────────────────────────
        out = str(DEMOS_DIR / "apispy-empty.png")
        page.screenshot(path=out)
        print(f"  \u2713 {out}")

        # ── Inject mock entries ─────────────────────────────────────────────
        page.evaluate(_INJECT_ENTRIES_JS)
        page.wait_for_timeout(400)

        # ── Screenshot 2: populated table ───────────────────────────────────
        out = str(DEMOS_DIR / "apispy-requests.png")
        page.screenshot(path=out)
        print(f"  \u2713 {out}")

        # ── Screenshot 3: column-filter dropdown ────────────────────────────
        # Open the Status column filter, then uncheck "exact_match" so that
        # exact-match rows are filtered out.  This demonstrates both the
        # dropdown UI and the live filtering effect (row count drops).
        status_btn = page.query_selector('.col-filter-btn[data-col="status"]')
        if status_btn:
            status_btn.click()
            page.wait_for_timeout(300)
            # Uncheck the exact_match checkbox so those rows disappear.
            exact_cb = page.query_selector(
                '#col-filter-list input[type="checkbox"][value="exact_match"]'
            )
            if exact_cb:
                exact_cb.click()
                page.wait_for_timeout(300)

        out = str(DEMOS_DIR / "apispy-filter.png")
        page.screenshot(path=out)
        print(f"  \u2713 {out}")

        # Re-enable exact_match before closing so the detail screenshot has all rows.
        exact_cb = page.query_selector(
            '#col-filter-list input[type="checkbox"][value="exact_match"]'
        )
        if exact_cb:
            exact_cb.click()
            page.wait_for_timeout(200)

        # Close the dropdown before selecting a row.
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)

        # ── Screenshot 4: detail panel open ────────────────────────────────
        # Use a taller detail panel so all fields are visible without scrolling.
        page.evaluate("state.detailHeight = 400")

        # Click the second row (index 1 — the version-mismatch entry).
        rows = page.query_selector_all("#request-tbody tr")
        if rows and len(rows) > 1:
            rows[1].click()
            page.wait_for_timeout(300)

        out = str(DEMOS_DIR / "apispy-detail.png")
        page.screenshot(path=out)
        print(f"  \u2713 {out}")

        browser.close()


# ── Entry point ───────────────────────────────────────────────────────────────


def main() -> None:
    print("APISpy screenshot generator")
    print(f"  Extension dir : {EXTENSION_DIR}")
    print(f"  Output dir    : {DEMOS_DIR}")

    if not EXTENSION_DIR.is_dir():
        print(f"ERROR: Extension directory not found: {EXTENSION_DIR}", file=sys.stderr)
        sys.exit(1)

    print("Starting local HTTP server...")
    port = _start_server(EXTENSION_DIR)
    print(f"  Serving at http://127.0.0.1:{port}/")

    print("Generating screenshots...")
    _generate(port)

    print("Done.")


if __name__ == "__main__":
    main()
