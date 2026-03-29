<img src="https://raw.githubusercontent.com/UndREST-Labs/.github/main/profile/UndREST-Labs.PNG" alt="UndREST Labs" width="600"/>

<img src="https://raw.githubusercontent.com/UndREST-Labs/.github/main/profile/UndREST-APISpy.PNG" alt="APISpy" width="600"/>

# UndREST-APISpy — API Request Inspector

**AP👁️Spy** is a Chrome/Edge DevTools extension that observes live Azure/Microsoft API calls in real time, classifying each one against the SpeQL API inventory to surface exact matches, version mismatches, and unknown routes — without leaving the browser.

The extension ships with pre-bundled provider shards (updated nightly from [UndREST-SpecQL](https://github.com/UndREST-Labs/UndREST-SpecQL)) and supports ARM batch inspection, multi-select status filters, column-level filters, clipboard/CSV export, and more.

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Usage](#usage)
- [API Packs](#api-packs)
- [Portal Sweep](#portal-sweep)
- [Shard Data](#shard-data)
- [Repository Structure](#repository-structure)
- [Ecosystem](#ecosystem)
- [Contributing](#contributing)
- [License](#license)

## Quick Start

1. Clone this repo
2. Load `extension/` as an unpacked extension in Chrome/Edge (**chrome://extensions → Developer mode → Load unpacked**)
3. Open DevTools on any Azure Portal or Microsoft API-calling page
4. Navigate to the **APISpy** panel

## Installation

### Browser Extension

```bash
git clone https://github.com/UndREST-Labs/UndREST-APISpy.git
```

1. Open **chrome://extensions** (or **edge://extensions**)
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the `extension/` directory from this repo

The extension installs with all provider shards pre-bundled in `extension/data/shards/`. These are updated automatically every night from the latest SpeQL export — see [Shard Data](#shard-data).

See [extension/README.md](extension/README.md) for full usage details, panel walkthrough, and configuration options.

### Portal Sweep Script

The portal sweep automation requires Python 3.8+:

```bash
pip3 install -r requirements.txt
python -m playwright install chromium
```

## Usage

### DevTools Panel

Once the extension is loaded, open DevTools on any page that makes Azure/Microsoft API calls (e.g., the Azure Portal) and click the **APISpy** tab.

The panel shows each outgoing API request with:
- **Provider** — e.g., `Microsoft.Compute`
- **Match Status** — Exact match / Version mismatch / Unknown
- **Method + Path** — Normalised API path
- **API Version** — Detected from the request

Use the filter controls to narrow by provider, status, or path pattern. Export to clipboard or CSV for offline analysis.

### Demo

![APISpy Portal Sweep Demo](demos/08-apispy-portal-sweep.gif)

## API Packs

An **API pack** is a named collection of provider shards derived from one API platform's specifications.  The extension manifest (`extension/data/manifest.json`, schema 2.0.0) groups shards by pack, which lets the extension load multiple API platforms simultaneously and gives users the ability to choose which pack(s) are active at runtime.

| Pack ID | Platform | Source | Description |
|---------|----------|--------|-------------|
| `azure-rest-api-specs` | Azure | [Azure/azure-rest-api-specs](https://github.com/Azure/azure-rest-api-specs) | Azure Resource Manager provider shards (updated nightly via UndREST-SpecQL) |

### Selecting active packs

Click the **Packs** button in the APISpy toolbar to open the pack settings dialog.  From there you can enable or disable individual packs.  Your selection is saved to browser storage and persists across DevTools reloads.

### Adding a new pack

See **[docs/ADDING_A_PACK.md](docs/ADDING_A_PACK.md)** for a step-by-step guide to adding shards for a new API platform (e.g. AWS, Google Cloud, a custom internal API).

The high-level steps are:
1. Generate shard files in the schema 3.0.0 format (one file per provider/service namespace)
2. Run `scripts/prepare_data.py --pack-id <id> --merge` to bundle the shards
3. Register a custom request normaliser if the new API uses non-ARM URL patterns
4. Extend `lib/filters.js` with the new platform's hosts/suffixes
5. Add a GitHub Actions workflow to keep the new pack up-to-date automatically

## Portal Sweep

`scripts/portal_sweep.py` is an automation script that walks every service on the Azure Portal **All Services** page with the APISpy extension running, then exports all captured ARM API calls as a CSV — providing broad, automated coverage of real-world Azure API traffic across all services.

```bash
python3 scripts/portal_sweep.py
```

**Options:**

```
--output-dir DIR      Output directory for CSV results (default: ./results)
--dwell-ms MS         Milliseconds to dwell on each service page (default: 3000)
```

**Prerequisites:**

```bash
pip3 install -r requirements.txt
python -m playwright install chromium

# Authenticate (device code flow — Azure CLI first-party app)
# The script will prompt you on first run
```

See [scripts/PORTAL_SWEEP.md](scripts/PORTAL_SWEEP.md) for full usage, output format, and troubleshooting.

## Shard Data

The extension's API inventory lives in `extension/data/shards/`. Each file covers a single provider namespace (e.g., `Microsoft.Storage.min.json`) and is generated by [UndREST-SpecQL](https://github.com/UndREST-Labs/UndREST-SpecQL) from the `Azure/azure-rest-api-specs` corpus.

Shards are grouped into **packs** in `extension/data/manifest.json` (schema 2.0.0).  The built-in Azure pack stores shards in the flat `shards/` directory.  Additional packs store their shards in `shards/<pack-id>/` subdirectories so filenames cannot collide.

**Automatic nightly update:**

1. UndREST-SpecQL runs its export pipeline at 05:00 UTC daily
2. It publishes the sharded zip to the `shards-latest` GitHub Release
3. This triggers the [`update-shards.yml`](.github/workflows/update-shards.yml) workflow in this repo
4. That workflow downloads the zip, runs `scripts/prepare_data.py`, and commits the updated shards to `extension/data/`

**Manual refresh:**

Go to **Actions → Update Extension Shards → Run workflow** to pull the latest shards immediately.

**Requires secret:** `SPEQL_READ_TOKEN` — a fine-grained PAT with `contents: read` on `UndREST-Labs/UndREST-SpecQL`.

## Repository Structure

```
UndREST-APISpy/
├── README.md
├── CONTRIBUTING.md
├── LICENSE
├── requirements.txt             # azure-identity, playwright
├── docs/
│   └── ADDING_A_PACK.md         # Guide for adding new API pack sources
├── extension/                   # Chrome/Edge DevTools extension
│   ├── data/
│   │   ├── manifest.json        # Pack manifest (schema 2.0.0) — lists all packs and shards
│   │   └── shards/              # Per-provider API shards (flat for azure pack; subdir for others)
│   ├── lib/                     # filters, normalizer, loader, matcher modules
│   ├── icons/
│   ├── manifest.json
│   ├── devtools.html / devtools.js
│   ├── panel.html / panel.css / panel.js
│   └── README.md
├── scripts/
│   ├── prepare_data.py          # Converts SpecQL export zip/dir into extension/data/shards/
│   ├── portal_sweep.py          # Playwright sweep of Azure Portal → CSV of ARM calls
│   ├── generate_screenshots.py  # Demo screenshot generation
│   └── PORTAL_SWEEP.md
├── tests/
│   ├── test_filters.js
│   ├── test_loader.js
│   ├── test_matcher.js
│   ├── test_normalizer.js
│   └── vhs/
│       ├── 08-apispy-portal-sweep.tape
│       └── helpers/
│           └── mock_portal_sweep.sh
├── demos/
│   ├── 08-apispy-portal-sweep.gif
│   └── apispy-*.png
└── .github/
    └── workflows/
        └── update-shards.yml    # Triggered by UndREST-SpecQL on new shard publish
```

## Ecosystem

APISpy is part of the [UndREST Labs](https://github.com/UndREST-Labs) ecosystem:

| Project | Repo | Description |
|---------|------|-------------|
| **SpeQL** | [UndREST-SpecQL](https://github.com/UndREST-Labs/UndREST-SpecQL) | Query and reason about API behaviour; the engine that feeds APISpy |
| **APISpy** | *(this repo)* | Real-time visibility into API calls in the browser |
| **Atlas** | *(future)* | Mapping API ecosystems at scale |

> **Observe → Understand → Map → Evolve**

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on contributing to the extension, portal sweep script, and shard preparation pipeline.

For SpeQL (query engine, inventory export, CodeQL queries), see [UndREST-SpecQL](https://github.com/UndREST-Labs/UndREST-SpecQL).

## License

See [LICENSE](LICENSE).
