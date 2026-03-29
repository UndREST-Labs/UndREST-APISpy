#!/usr/bin/env python3
"""Walk every service on the Azure Portal "All Services" page with the APISpy
extension running, then export the collected API-call inventory as a CSV file.

Workflow
--------
1. Authenticate to Azure via device code flow (Azure CLI first-party app).
2. Launch a headed Chromium browser with the APISpy Chrome extension loaded.
3. Navigate to https://portal.azure.com/#allservices and harvest all service
   URLs *before* any navigation begins.
4. Visit each portal.azure.com service URL in turn, dwelling briefly so APISpy
   can capture the outgoing API requests.
5. Locate the APISpy DevTools panel page and trigger its "Save CSV" button;
   save the downloaded file to --output-dir (default: current directory).

Prerequisites
-------------
    pip install azure-identity playwright
    python -m playwright install chromium

Usage
-----
    # From the repository root:
    python scripts/azure_portal_sweep.py

    # With options:
    python scripts/azure_portal_sweep.py \\
        --output-dir ./results \\
        --dwell-ms 3000 \\
        --user-data-dir ~/.apispy-sweep-session
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

# ── Constants ─────────────────────────────────────────────────────────────────

AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
MANAGEMENT_SCOPE    = "https://management.azure.com/.default"

PORTAL_HOME         = "https://portal.azure.com/"
ALL_SERVICES_URL    = "https://portal.azure.com/#allservices/category/All"

PORTAL_HOST         = "portal.azure.com"

# Maximum dwell time enforced by the script regardless of --dwell-ms.
MAX_DWELL_MS = 10_000

# Timeout (seconds) to wait for the user to complete in-browser portal login.
PORTAL_AUTH_TIMEOUT_S = 180

# Default user data directory for persisting browser sessions between runs.
DEFAULT_USER_DATA_DIR = Path.home() / ".apispy-sweep-session"

REPO_ROOT      = Path(__file__).resolve().parent.parent
EXTENSION_DIR  = REPO_ROOT / "extension"

# ── Authentication ────────────────────────────────────────────────────────────


def authenticate_device_code() -> object:
    """Run the Azure device code flow and return a valid DeviceCodeCredential.

    Prints the device code URL and user code to stderr so the operator can
    authenticate while the script waits.  Returns the credential object after
    the token has been acquired (i.e., *blocks* until the user completes auth).
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


# ── Playwright helpers ────────────────────────────────────────────────────────


def _launch_context(user_data_dir: Path, record_video_dir: Path | None = None):
    """Launch a Playwright persistent Chromium context with APISpy loaded."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(
            "ERROR: playwright is not installed.\n"
            "       Run: pip install playwright && python -m playwright install chromium",
            file=sys.stderr,
        )
        sys.exit(1)

    if not EXTENSION_DIR.is_dir():
        print(
            f"ERROR: APISpy extension directory not found: {EXTENSION_DIR}",
            file=sys.stderr,
        )
        sys.exit(1)

    ext_path = str(EXTENSION_DIR)
    user_data_dir.mkdir(parents=True, exist_ok=True)

    video_kwargs = {}
    if record_video_dir is not None:
        record_video_dir.mkdir(parents=True, exist_ok=True)
        video_kwargs["record_video_dir"] = str(record_video_dir)
        video_kwargs["record_video_size"] = {"width": 1280, "height": 720}

    pw = sync_playwright().start()
    context = pw.chromium.launch_persistent_context(
        user_data_dir=str(user_data_dir),
        headless=False,  # Extensions require a visible (or "new-headless") context.
        args=[
            f"--load-extension={ext_path}",
            f"--disable-extensions-except={ext_path}",
            "--auto-open-devtools-for-tabs",  # Opens DevTools on every tab so
                                              # APISpy's onRequestFinished fires.
        ],
        **video_kwargs,
    )
    return pw, context


def _wait_for_portal_auth(page, timeout_s: int = PORTAL_AUTH_TIMEOUT_S) -> None:
    """Navigate to the portal home and wait until the user is signed in.

    If the session is already persisted in user_data_dir the wait is instant.
    Otherwise the browser window shows the Microsoft sign-in page and the user
    can authenticate manually (prints a prompt to stderr).
    """
    page.goto(PORTAL_HOME, wait_until="domcontentloaded", timeout=60_000)

    deadline = time.time() + timeout_s

    while time.time() < deadline:
        url = page.url
        parsed = urlparse(url)
        netloc = parsed.netloc.lower()
        # Authenticated once we land on portal.azure.com and are NOT on any
        # login / auth redirect host (login.microsoftonline.com, etc.).
        if "portal.azure.com" in netloc and not any(
            x in netloc for x in ("login.", "auth.", "account.", "sts.")
        ):
            print("✓ Portal authentication confirmed.", file=sys.stderr)
            return
        time.sleep(2)

    print(
        "ERROR: Timed out waiting for portal authentication.\n"
        "       Please sign in to the browser window that opened.",
        file=sys.stderr,
    )
    sys.exit(1)


# ── All-services harvesting ───────────────────────────────────────────────────


def _collect_service_urls(page) -> list[str]:
    """Navigate to #allservices/category/All and return all portal service URLs.

    Collects every portal.azure.com href with a non-trivial hash fragment,
    excluding only the all-services page itself and bare-anchor nav links.
    Scrolls until no new links appear to handle virtual / lazy-loaded lists.
    """
    # Hash fragments that are portal navigation, not service destinations.
    _NAV_FRAGMENTS = {"", "home", "dashboard", "marketplace"}

    print("Navigating to All Services…", file=sys.stderr)
    page.goto(ALL_SERVICES_URL, wait_until="domcontentloaded", timeout=60_000)

    # Give the SPA a moment to render the initial set of tiles.
    page.wait_for_timeout(2_000)

    def _count_links() -> int:
        return page.evaluate(
            "Array.from(document.querySelectorAll('a[href]'))"
            ".filter(a => {"
            "  try { const u = new URL(a.href);"
            "    return u.hostname === 'portal.azure.com' && u.hash.length > 1; }"
            "  catch(_) { return false; }"
            "}).length"
        )

    # Scroll until no new service links appear.
    # Uses both window scroll and explicit scrollTop on common portal containers.
    prev = 0
    for _ in range(40):
        page.evaluate(
            "["
            "  document.querySelector('.fxs-blade-content'),"
            "  document.querySelector('.msportalfx-scrollable'),"
            "  document.querySelector('[role=\"main\"]'),"
            "  document.body,"
            "].forEach(el => { if (el) el.scrollTop += 600; });"
            "window.scrollTo(0, document.body.scrollHeight);"
        )
        page.wait_for_timeout(250)
        cur = _count_links()
        if cur == prev:
            break
        prev = cur

    # Harvest all portal hrefs with a meaningful hash.
    raw_hrefs: list[str] = page.evaluate(
        """
        Array.from(document.querySelectorAll('a[href]'))
            .map(a => { try { return new URL(a.href).href; } catch(_) { return null; } })
            .filter(Boolean)
        """
    )

    seen: set[str] = set()
    service_urls: list[str] = []

    for href in raw_hrefs:
        if href in seen:
            continue
        seen.add(href)
        parsed = urlparse(href)
        frag = parsed.fragment.lstrip("/")
        # Keep only portal.azure.com URLs with a non-trivial fragment that
        # is not one of the known navigation-only hashes or the all-services page.
        if (
            parsed.netloc == PORTAL_HOST
            and parsed.fragment
            and frag not in _NAV_FRAGMENTS
            and not frag.startswith("allservices")
        ):
            service_urls.append(href)

    print(
        f"✓ Collected {len(service_urls)} service URLs from All Services.",
        file=sys.stderr,
    )
    return service_urls


# ── Service sweep ─────────────────────────────────────────────────────────────


def sweep_all_services(page, context, dwell_ms: int) -> None:
    """Visit every service URL once, dwelling for dwell_ms after each loads."""
    service_urls = _collect_service_urls(page)

    if not service_urls:
        print(
            "WARNING: No service URLs found — the portal may not have rendered "
            "the tiles correctly.  The CSV export will be empty.",
            file=sys.stderr,
        )
        return

    # Detect and immediately close any extra tabs opened by service tiles.
    def _close_extra_tab(new_page) -> None:
        try:
            new_page.wait_for_load_state("domcontentloaded", timeout=5_000)
        except Exception:
            pass
        print(
            f"  [skip] Closing new tab: {new_page.url}",
            file=sys.stderr,
        )
        new_page.close()

    context.on("page", _close_extra_tab)

    total = len(service_urls)
    for idx, url in enumerate(service_urls, start=1):
        print(f"  [{idx}/{total}] {url}", file=sys.stderr)
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            # Dwell so APISpy (via devtools.js) captures the blade's ARM calls.
            # networkidle is intentionally skipped — the Azure Portal is a chatty
            # SPA that continuously polls and never satisfies the networkidle
            # condition, causing a full 15 s timeout on every page.  devtools.js
            # captures requests in real-time so we only need enough time for the
            # blade to mount and fire its initial ARM calls (~1 s); dwell_ms
            # provides comfortable headroom.
            page.wait_for_timeout(dwell_ms)
        except Exception as exc:
            print(f"    WARNING: {exc}", file=sys.stderr)

    context.remove_listener("page", _close_extra_tab)
    print(f"✓ Visited {total} services.", file=sys.stderr)


# ── CSV export ────────────────────────────────────────────────────────────────


def _get_extension_id_from_prefs(user_data_dir: Path) -> str | None:
    """Read the APISpy extension ID from Chrome's Preferences file.

    Chrome writes extension metadata (including auto-assigned IDs for unpacked
    extensions) to ``{user_data_dir}/Default/Preferences`` on startup.  By the
    time portal auth has been confirmed the file is always present and readable
    on Linux even while Chrome holds it open.
    """
    prefs_path = user_data_dir / "Default" / "Preferences"
    if not prefs_path.exists():
        return None
    try:
        with open(prefs_path, encoding="utf-8") as fh:
            prefs = json.load(fh)
        ext_settings = prefs.get("extensions", {}).get("settings", {})
        for ext_id, data in ext_settings.items():
            manifest = data.get("manifest", {})
            name = manifest.get("name", "") + manifest.get("short_name", "")
            path = data.get("path", "")
            if (
                "APISpy" in name
                or "SpecRecon" in name
                or ("apispy" in path.lower() and "extension" in path.lower())
            ):
                return ext_id
    except Exception as exc:
        print(f"  Prefs read failed: {exc}", file=sys.stderr)
    return None


def _get_extension_id(context, user_data_dir: Path | None = None) -> str | None:
    """Return the APISpy extension ID using three progressively broader strategies.

    1. Scan ``context.pages`` for any ``chrome-extension://`` URL (fast path).
    2. Ask Chrome via CDP ``Target.getTargets`` — retried up to 3 times after
       first calling ``Target.setDiscoverTargets`` to ensure all targets are
       surfaced.
    3. Parse Chrome's ``Preferences`` JSON file from *user_data_dir* (most
       reliable: Chrome always writes this on startup).
    """
    # Strategy 1 — pages already tracked by Playwright.
    for pg in context.pages:
        if pg.url.startswith("chrome-extension://"):
            return pg.url.split("/")[2]

    # Strategy 2 — CDP Target enumeration with retries.
    for attempt in range(3):
        try:
            cdp = context.new_cdp_session(context.pages[0])
            cdp.send("Target.setDiscoverTargets", {"discover": True})
            time.sleep(0.5)
            result = cdp.send("Target.getTargets", {})
            cdp.detach()
            for target in result.get("targetInfos", []):
                url = target.get("url", "")
                if url.startswith("chrome-extension://"):
                    return url.split("/")[2]
        except Exception as exc:
            print(f"  CDP extension-ID lookup (attempt {attempt + 1}): {exc}", file=sys.stderr)
        if attempt < 2:
            time.sleep(1)

    # Strategy 3 — parse Chrome's Preferences file.
    if user_data_dir:
        ext_id = _get_extension_id_from_prefs(user_data_dir)
        if ext_id:
            return ext_id
        print(
            f"  Preferences lookup found nothing in {user_data_dir / 'Default' / 'Preferences'}",
            file=sys.stderr,
        )

    return None


def _set_sweep_mode(context, ext_id: str, enabled: bool) -> None:
    """Set or clear the apispy_sweep_mode localStorage flag on the extension origin.

    devtools.js processes ARM requests and persists compact entries to
    ``apispy_sweep_entries`` only when this flag is ``'1'``, so normal
    interactive extension use is unaffected.

    When enabling: also clears stale data from any previous run.
    When disabling: only removes the flag — the captured data in
    ``apispy_sweep_entries`` is left intact for ``save_csv()`` to read.
    Call ``_cleanup_sweep_data()`` after the CSV has been saved.
    """
    flag_page = context.new_page()
    try:
        flag_page.goto(
            f"chrome-extension://{ext_id}/panel.html",
            wait_until="domcontentloaded",
            timeout=20_000,
        )
        if enabled:
            flag_page.evaluate(
                "localStorage.setItem('apispy_sweep_mode', '1');"
                # Clear stale data from any previous sweep run.
                "localStorage.removeItem('apispy_sweep_entries');"
                "localStorage.removeItem('apispy_requests');"
            )
        else:
            # Only remove the sweep mode flag — do NOT touch apispy_sweep_entries.
            # The captured data must survive until save_csv() has read and exported it.
            flag_page.evaluate("localStorage.removeItem('apispy_sweep_mode');")
    finally:
        flag_page.close()


def _cleanup_sweep_data(context, ext_id: str) -> None:
    """Remove sweep localStorage keys after the CSV has been saved.

    Called at the end of save_csv() once the file is on disk.  Keeps the
    extension's localStorage clean for normal interactive use.
    """
    flag_page = context.new_page()
    try:
        flag_page.goto(
            f"chrome-extension://{ext_id}/panel.html",
            wait_until="domcontentloaded",
            timeout=20_000,
        )
        flag_page.evaluate(
            "localStorage.removeItem('apispy_sweep_entries');"
            "localStorage.removeItem('apispy_requests');"
            "localStorage.removeItem('apispy_standalone_mode');"
        )
    finally:
        flag_page.close()


def save_csv(context, output_dir: Path, ext_id: str) -> Path:
    """Export the APISpy CSV by opening panel.html in standalone mode.

    devtools.js processes each ARM request fully (Normalizer/Matcher/Loader) as
    it arrives during the sweep and stores the compact results to
    ``apispy_sweep_entries`` in localStorage.  When panel.html is opened as a
    regular page (not inside DevTools) it detects standalone mode, reads the
    pre-processed entries synchronously (no async shard loading), sets
    ``_restoreComplete = true``, and ``saveCSV()`` can then download the CSV.

    Sweep mode is disabled *before* opening panel.html so that devtools.js
    stops writing to localStorage while the restore is reading from it.
    """
    print("Exporting APISpy CSV…", file=sys.stderr)

    output_dir.mkdir(parents=True, exist_ok=True)

    # ── Stop capture first ────────────────────────────────────────────────────
    # Disabling sweep mode causes devtools.js to stop accepting new requests AND
    # clears apispy_sweep_mode from localStorage so the final flush is stable
    # before panel.html reads it.  This prevents concurrent reads/writes that
    # were causing the restore to time out.
    print("  Stopping capture (final flush)…", file=sys.stderr)
    _set_sweep_mode(context, ext_id, enabled=False)
    # Brief pause to allow any in-flight localStorage write to settle.
    time.sleep(0.5)

    # ── Open panel.html in standalone mode ────────────────────────────────────
    panel_url = f"chrome-extension://{ext_id}/panel.html"
    print(f"  Opening      : {panel_url}", file=sys.stderr)

    panel_page = context.new_page()

    # Capture JS console output — errors here tell us exactly why restore fails.
    js_errors: list[str] = []
    def _on_console(msg):
        if msg.type in ("error", "warning"):
            js_errors.append(f"[{msg.type}] {msg.text}")
    panel_page.on("console", _on_console)

    # Set the standalone-mode flag before any page scripts run so panel.js
    # knows not to treat this as a DevTools context and runs _restoreFromRawRequests().
    panel_page.add_init_script("localStorage.setItem('apispy_standalone_mode', '1');")

    panel_page.goto(panel_url, wait_until="domcontentloaded", timeout=30_000)

    raw_count = panel_page.evaluate(
        "JSON.parse(localStorage.getItem('apispy_sweep_entries') || '[]').length"
    )
    print(f"  Entries      : {raw_count} processed by devtools.js", file=sys.stderr)

    # ── Wait for synchronous restore ──────────────────────────────────────────
    # _restoreFromProcessedEntries() is synchronous — all Normalizer/Matcher/
    # shard work was done in devtools.js at capture time.  The only async work
    # remaining is Loader.getSourceMetadata() at the top of init().
    # 30 s is a generous safety margin; in practice this resolves in < 2 s.
    print("  Restoring    : loading pre-processed entries into panel…", file=sys.stderr)
    try:
        panel_page.wait_for_function(
            "typeof _restoreComplete !== 'undefined' && _restoreComplete === true",
            timeout=30_000,
        )
    except Exception:
        status_text = panel_page.evaluate(
            "document.getElementById('status-text') ? "
            "document.getElementById('status-text').textContent : 'N/A'"
        )
        print(
            "WARNING: Timed out waiting for restore to complete. "
            "Proceeding with partial results.",
            file=sys.stderr,
        )
        print(f"  Page status  : {status_text}", file=sys.stderr)
        if js_errors:
            print("  JS errors captured:", file=sys.stderr)
            for e in js_errors[-10:]:
                print(f"    {e}", file=sys.stderr)

    count = panel_page.evaluate(
        "typeof state !== 'undefined' ? state.requests.length : 0"
    )
    print(f"  Matched      : {count} ARM request(s) after filtering", file=sys.stderr)

    if count == 0:
        print(
            "WARNING: APISpy panel reports 0 matched requests.\n"
            "         Check that DevTools was open during the sweep\n"
            "         (--auto-open-devtools-for-tabs) and the extension loaded.",
            file=sys.stderr,
        )
        csv_header = panel_page.evaluate("typeof CSV_HEADER !== 'undefined' ? CSV_HEADER : ''")
        ts = time.strftime("%Y-%m-%dT%H-%M-%S")
        dest = output_dir / f"apispy-{ts}.csv"
        dest.write_text((csv_header + "\r\n") if csv_header else "")
        panel_page.close()
        _cleanup_sweep_data(context, ext_id)
        print(f"✓ Empty CSV saved to: {dest}", file=sys.stderr)
        return dest

    print("✓ Triggering CSV download…", file=sys.stderr)

    with panel_page.expect_download(timeout=15_000) as dl_info:
        panel_page.evaluate("saveCSV()")

    download = dl_info.value
    suggested_name = download.suggested_filename or "apispy-export.csv"
    dest = output_dir / suggested_name
    download.save_as(str(dest))

    panel_page.close()

    # Clean up sweep data from localStorage now that the CSV is safely on disk.
    _cleanup_sweep_data(context, ext_id)

    print(f"✓ CSV saved to: {dest}", file=sys.stderr)
    return dest


# ── Video recording helpers ───────────────────────────────────────────────────

_FFMPEG_FILTER = (
    "fps=8,scale=1280:-1:flags=lanczos,"
    "split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer"
)
_DEMO_GIF_TRIM_S = 90  # Trim browser GIF to first N seconds (keeps file size sane)


def _save_video_recording(video_tmp_dir: Path, output_dir: Path) -> None:
    """Move the Playwright .webm recording to output_dir and try to create a GIF.

    The .webm covers the full browser session (auth confirmation → sweep → CSV
    export).  The GIF is trimmed to the first _DEMO_GIF_TRIM_S seconds so the
    file stays a reasonable size while showing the sweep in action.

    If ffmpeg is not on PATH the .webm is saved and the user is shown the
    command to run manually.
    """
    webm_files = sorted(video_tmp_dir.glob("*.webm"))
    if not webm_files:
        print("  No browser recording found.", file=sys.stderr)
        return

    from datetime import datetime
    ts = datetime.now().strftime("%Y-%m-%d-%H-%M-%S")
    webm_dst = output_dir / f"apispy-sweep-{ts}.webm"
    shutil.move(str(webm_files[0]), str(webm_dst))
    print(f"  Browser recording : {webm_dst}", file=sys.stderr)

    gif_dst = output_dir / "apispy-portal-sweep-browser.gif"
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        cmd = [
            ffmpeg, "-y",
            "-t", str(_DEMO_GIF_TRIM_S),
            "-i", str(webm_dst),
            "-vf", _FFMPEG_FILTER,
            "-loop", "0",
            str(gif_dst),
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            print(f"  Browser GIF       : {gif_dst}", file=sys.stderr)
        except subprocess.CalledProcessError as exc:
            print(
                f"  WARNING: ffmpeg conversion failed: {exc.stderr.decode()[:200]}",
                file=sys.stderr,
            )
            print(f"  The raw .webm is at: {webm_dst}", file=sys.stderr)
    else:
        print(
            "  ffmpeg not found — to create a browser GIF, run:\n"
            f"    ffmpeg -y -t {_DEMO_GIF_TRIM_S} -i '{webm_dst}'"
            f" -vf \"{_FFMPEG_FILTER}\" -loop 0 '{gif_dst}'",
            file=sys.stderr,
        )


# ── CLI ───────────────────────────────────────────────────────────────────────


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Walk every Azure Portal service with the APISpy extension "
            "and export the captured API calls as a CSV file."
        )
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path.cwd(),
        help="Directory to save the exported CSV (default: current directory).",
    )
    parser.add_argument(
        "--dwell-ms",
        type=int,
        default=1_500,
        metavar="MS",
        help=(
            "Milliseconds to dwell on each service page after it loads "
            f"(default: 1500, max: {MAX_DWELL_MS}). "
            "Increase on slow connections; most blades fire their ARM calls "
            "within 1 s of domcontentloaded."
        ),
    )
    parser.add_argument(
        "--user-data-dir",
        type=Path,
        default=DEFAULT_USER_DATA_DIR,
        help=(
            "Chromium user-data directory for persisting the portal session "
            f"between runs (default: {DEFAULT_USER_DATA_DIR})."
        ),
    )
    parser.add_argument(
        "--record-video",
        action="store_true",
        default=False,
        help=(
            "Record the browser session as a .webm video during the sweep. "
            "If ffmpeg is on PATH, a trimmed browser GIF is also created at "
            "apispy-portal-sweep-browser.gif inside --output-dir."
        ),
    )
    return parser.parse_args()


# ── Entry point ───────────────────────────────────────────────────────────────


def main() -> None:
    args = _parse_args()

    dwell_ms = min(args.dwell_ms, MAX_DWELL_MS)
    if dwell_ms != args.dwell_ms:
        print(
            f"NOTE: --dwell-ms capped at {MAX_DWELL_MS} ms.",
            file=sys.stderr,
        )

    print("APISpy Portal Sweep", file=sys.stderr)
    print(f"  Extension : {EXTENSION_DIR}", file=sys.stderr)
    print(f"  Output dir: {args.output_dir}", file=sys.stderr)
    print(f"  Dwell     : {dwell_ms} ms per service", file=sys.stderr)
    print(f"  Session   : {args.user_data_dir}", file=sys.stderr)
    if args.record_video:
        print("  Recording : browser video enabled (--record-video)", file=sys.stderr)
    print("", file=sys.stderr)

    # ── Phase 1: device code authentication ──────────────────────────────────
    authenticate_device_code()

    # ── Phase 2: browser launch ──────────────────────────────────────────────
    print("Launching browser with APISpy extension…", file=sys.stderr)
    video_tmp_dir = Path(tempfile.mkdtemp(prefix="apispy-video-")) if args.record_video else None
    pw, context = _launch_context(args.user_data_dir, record_video_dir=video_tmp_dir)

    try:
        page = context.pages[0] if context.pages else context.new_page()

        # ── Phase 3: portal authentication ───────────────────────────────────
        print(
            "Waiting for portal authentication "
            f"(up to {PORTAL_AUTH_TIMEOUT_S}s)…",
            file=sys.stderr,
        )
        _wait_for_portal_auth(page)

        # ── Phase 3b: enable sweep-mode localStorage flag ─────────────────────
        # This tells panel.js to persist captured requests to localStorage.
        # Without this flag, the extension behaves normally and never touches storage.
        ext_id = _get_extension_id(context, user_data_dir=args.user_data_dir)
        if not ext_id:
            # Emit a diagnostic dump so the user can see what extensions Chrome loaded.
            prefs_path = args.user_data_dir / "Default" / "Preferences"
            if prefs_path.exists():
                try:
                    with open(prefs_path, encoding="utf-8") as fh:
                        prefs = json.load(fh)
                    ext_ids = list(prefs.get("extensions", {}).get("settings", {}).keys())
                    print(
                        f"  Chrome loaded {len(ext_ids)} extension(s) in {prefs_path}:\n"
                        + "".join(f"    {i}\n" for i in ext_ids),
                        file=sys.stderr,
                    )
                except Exception:
                    pass
            print(
                "ERROR: Could not find APISpy extension ID after browser launch.\n"
                "       Ensure --load-extension points to apispy/extension/.",
                file=sys.stderr,
            )
            sys.exit(1)
        print("Enabling sweep mode in APISpy…", file=sys.stderr)
        _set_sweep_mode(context, ext_id, enabled=True)

        # ── Phase 4: sweep all services ───────────────────────────────────────
        sweep_all_services(page, context, dwell_ms)

        # ── Phase 5: export CSV ───────────────────────────────────────────────
        csv_path = save_csv(context, args.output_dir, ext_id)
        print(f"\nDone. CSV exported to:\n  {csv_path}")

    finally:
        context.close()
        pw.stop()
        if args.record_video and video_tmp_dir and video_tmp_dir.exists():
            print("Saving browser recording…", file=sys.stderr)
            _save_video_recording(video_tmp_dir, args.output_dir)
            shutil.rmtree(str(video_tmp_dir), ignore_errors=True)


if __name__ == "__main__":
    main()
