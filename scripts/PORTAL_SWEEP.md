# APISpy Portal Sweep

`portal_sweep.py` is a Playwright-based automation script that walks every
service on the Azure Portal **All Services** page with the APISpy DevTools
extension running, then exports the collected ARM API calls as a CSV file.

![APISpy Portal Sweep terminal demo](../../demos/apispy-portal-sweep-terminal.gif)

---

## How it works

```
┌─────────────────────────────────────────────────────────────────────┐
│  Device code auth  →  Browser launch  →  Portal login wait          │
│  → Harvest 305 service URLs  →  Visit each URL (dwell briefly)      │
│  → Open APISpy panel (standalone)  →  Export CSV                    │
└─────────────────────────────────────────────────────────────────────┘
```

1. **Device code authentication** — authenticates to Azure with the Azure CLI
   first-party app (`04b07795-…`).  Prints a one-time code and URL to the
   terminal; the user opens the URL in any browser and enters the code.  The
   script then holds a valid Azure token to confirm the operator's identity.

2. **Browser launch** — starts a headed Chromium instance via Playwright's
   persistent context, loading the APISpy extension from `apispy/extension/`.
   `--auto-open-devtools-for-tabs` ensures DevTools is open on every tab so
   APISpy's `onRequestFinished` listener fires immediately.

3. **Portal login wait** — navigates to `https://portal.azure.com/`.  If the
   browser session from a previous run is still valid, this is instant.
   Otherwise, the portal sign-in page appears in the browser window and the
   script waits up to 3 minutes for the user to authenticate there.

4. **Sweep mode** — sets `apispy_sweep_mode = '1'` in `localStorage`.
   `devtools.js` detects this flag and, for every `management.azure.com` ARM
   request, immediately runs the full Normalizer → Loader → Matcher pipeline
   and stores a compact pre-processed entry in `apispy_sweep_entries`.

5. **URL collection** — navigates to `#allservices/category/All`, scrolls until
   all 305 service tiles are rendered, and harvests every `portal.azure.com`
   deep-link URL before any navigation begins.

6. **Sweep loop** — visits each URL in order, waiting for `domcontentloaded`
   then dwelling for `--dwell-ms` (default 1 500 ms).  Most portal blades fire
   their ARM calls within the first second of loading; the dwell covers the
   initial burst.

7. **CSV export** — disables sweep mode, opens `panel.html` in standalone mode,
   reads `apispy_sweep_entries` from `localStorage` synchronously, renders the
   results, and downloads them as a CSV file.

---

## Prerequisites

```bash
pip install azure-identity playwright
python3 -m playwright install chromium
```

---

## Usage

```bash
# From the repository root (or any directory):
python3 scripts/portal_sweep.py
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--output-dir PATH` | current directory | Where to save the CSV (and video files). |
| `--dwell-ms MS` | `1500` | Milliseconds to dwell on each service after `domcontentloaded`. Increase on slow connections (max 10 000 ms). |
| `--user-data-dir PATH` | `~/.apispy-sweep-session` | Chromium profile directory. Reusing the same directory persists the portal login between runs. |
| `--record-video` | off | Record the browser session as a `.webm` video. If `ffmpeg` is on PATH, also creates a trimmed `apispy-portal-sweep-browser.gif`. |

### Examples

```bash
# Standard sweep, CSV saved to current directory
python3 scripts/portal_sweep.py

# Slower connection — increase dwell to 3 s
python3 scripts/portal_sweep.py --dwell-ms 3000

# Record browser video + auto-create GIF (requires ffmpeg)
python3 scripts/portal_sweep.py --record-video --output-dir ./results

# Use a shared session directory (avoids re-logging in)
python3 scripts/portal_sweep.py --user-data-dir /mnt/shared/apispy-session
```

---

## Output files

| File | Description |
|------|-------------|
| `apispy-YYYY-MM-DD-HH-MM-SS.csv` | Captured ARM requests, 16 columns (see below). |
| `apispy-sweep-TIMESTAMP.webm` | Full browser recording (`--record-video` only). |
| `apispy-portal-sweep-browser.gif` | Trimmed GIF (first 90 s) of the browser sweep, if `ffmpeg` is available. |

### CSV columns

The CSV has the same schema as APISpy's interactive **Save CSV** export:

| Column | Description |
|--------|-------------|
| `#` | Row index |
| `Time` | Request timestamp |
| `Method` | HTTP verb |
| `Host` | Request host |
| `Path` | Normalised URL path |
| `api-version` | `api-version` query parameter |
| `Status` | Classification: `exact`, `version_mismatch`, `unknown_route`, `no_match`, `arm_root` |
| `Reason` | Reason code from the matcher |
| `Label` | Human-readable status label |
| `Provider` | Azure provider namespace (e.g. `Microsoft.Compute`) |
| `Matched route` | Route key from the spec index |
| `Matched versions` | Spec versions for the matched route |
| `Shard` | Provider shard file used for matching |
| `Error` | Shard load error, if any |
| `Batch sub-request` | `true` if this row was expanded from an ARM batch body |
| `URL` | Full request URL |

---

## Performance

On a typical broadband connection with default settings:

| Phase | Duration |
|-------|----------|
| Device code auth | ~30 s (user interaction) |
| Portal login (cached session) | < 5 s |
| URL collection (305 services) | ~15 s |
| Sweep loop (305 × 1 500 ms dwell + load) | ~7–10 min |
| CSV export | < 5 s |
| **Total** | **~8–11 min** |

> Tip: on the first run, leave `--dwell-ms` at the default.  On subsequent runs
> once you know your connection speed, you can lower it to `1000` ms.

---

## Session persistence

The `--user-data-dir` stores the Chromium profile including cookies and portal
session tokens.  On the first run you will need to authenticate in the browser
window (separate from the device code terminal prompt — that's only to confirm
your Azure identity to the script).  On subsequent runs the same profile is
reused and the portal loads directly without a login prompt.

To force a fresh portal login, delete the user data directory:
```bash
rm -rf ~/.apispy-sweep-session
```

---

## Recording a browser demo GIF

Run with `--record-video`.  If `ffmpeg` is installed, the GIF is created
automatically in `--output-dir`.  Otherwise, the script prints the `ffmpeg`
command to run manually.

To install `ffmpeg` on Ubuntu/Debian:
```bash
sudo apt install ffmpeg
```

The generated GIF covers the first 90 seconds of the recording (portal loading,
URL collection, and the first ~30 services sweeping past).  For the full
recording, use the `.webm` directly.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `playwright is not installed` | `pip install playwright && python3 -m playwright install chromium` |
| `azure-identity is not installed` | `pip install azure-identity` |
| Browser window opens briefly then closes | Python error — check the full traceback. Likely a Playwright version issue. |
| Device code prompt appears but portal login loops | Delete `~/.apispy-sweep-session` and try again. |
| `Could not find APISpy extension ID` | Ensure `apispy/extension/` exists relative to the script. |
| CSV has 0 matched requests | DevTools may not have opened; check `--auto-open-devtools-for-tabs` is in the Chrome args. |
| Sweep very slow (> 15 min) | Try `--dwell-ms 1000` — the default is already optimised for most connections. |
| `ffmpeg` GIF conversion fails | Check `ffmpeg` version (`ffmpeg -version`); needs ≥ 4.x with `palettegen` filter. |

