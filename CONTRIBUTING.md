# Contributing to UndREST-APISpy

Thank you for your interest in contributing to APISpy! This guide covers how to contribute to the browser extension, portal sweep script, and shard preparation pipeline.

**APISpy** is a Chrome/Edge DevTools extension that observes and classifies live Azure/Microsoft API requests against the SpeQL API inventory in real time.

For **SpeQL** (query engine, CodeQL queries, inventory export pipeline), see [UndREST-SpecQL](https://github.com/UndREST-Labs/UndREST-SpecQL).

## 🎯 Ways to Contribute

1. **Improve the extension** — UI, matching logic, filter behaviour
2. **Improve the portal sweep** — coverage, reliability, output format
3. **Improve shard preparation** — `prepare_data.py` pipeline
4. **Add a new API pack** — bundle shards for a new API platform (see [docs/ADDING_A_PACK.md](docs/ADDING_A_PACK.md))
5. **Add or improve JavaScript tests** — filters, matcher, normalizer, loader
6. **Improve documentation**
7. **Report bugs or suggest features**

## 🔧 Development Setup

### Prerequisites

- Chrome or Edge (for loading the unpacked extension)
- Node.js (for running JavaScript tests)
- Python 3.8+ (for portal sweep and shard prep scripts)
- Playwright (for portal sweep)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/UndREST-Labs/UndREST-APISpy.git
cd UndREST-APISpy

# Install Python dependencies
pip3 install -r requirements.txt
python -m playwright install chromium

# Load the extension
# Open chrome://extensions → Developer mode → Load unpacked → select extension/
```

## 🧩 Extension Architecture

The extension is an unpacked Chrome/Edge DevTools extension:

```
extension/
├── manifest.json       # Extension configuration
├── devtools.html/js    # DevTools panel entry point
├── panel.html/css/js   # Main panel UI and logic
├── lib/
│   ├── filters.js      # Request filtering logic (host/path scope rules)
│   ├── matcher.js      # Matches requests against shard inventory
│   ├── normalizer.js   # Normalises API paths for matching; supports pack normaliser hooks
│   └── loader.js       # Loads shard data from extension/data/; pack-aware
└── data/
    ├── manifest.json   # Pack manifest (schema 2.0.0) — lists all packs and their shards
    └── shards/         # Per-provider API inventory (flat for azure pack; <pack-id>/ subdirs for others)
```

### Pack architecture

A **pack** is a named set of shards from one API platform.  The manifest groups shards by pack so multiple platforms can coexist.  The loader reads the manifest and uses the user's pack selection (stored in browser localStorage) to filter which shards are available for matching.

To add a new API pack see **[docs/ADDING_A_PACK.md](docs/ADDING_A_PACK.md)**.

### JavaScript Code Style

- Follow standard ES6+ conventions
- Keep functions focused and single-purpose
- Comment complex matching or normalisation logic
- Avoid external dependencies (the extension must work offline)

## 🧪 Testing

### JavaScript Unit Tests

```bash
# Run all extension tests (Node.js required)
npm test

# Equivalent plain-Node commands
node tests/test_filters.js
node tests/test_loader.js
node tests/test_normalizer.js
node tests/test_matcher.js
```

### Manual Extension Testing

1. Load the unpacked extension from `extension/`
2. Open DevTools on a page that makes Azure API calls (e.g., portal.azure.com)
3. Navigate to the APISpy panel
4. Verify request classification, filtering, and export behaviour

### Portal Sweep Testing

```bash
# Use the mock sweep helper for offline testing
bash tests/vhs/helpers/mock_portal_sweep.sh
```

## 📝 Updating Shard Data Locally

To test with fresh shard data without waiting for the nightly workflow:

```bash
# Download the latest shards from UndREST-SpecQL
mkdir -p inventory
gh release download shards-latest \
  --repo UndREST-Labs/UndREST-SpecQL \
  --pattern "api-index-sharded-*.zip" \
  --dir inventory/

# Prepare the shard data (azure pack, default settings)
python3 scripts/prepare_data.py \
  --source-dir inventory/ \
  --out extension/data/

# To add a second pack and merge into the existing manifest:
python3 scripts/prepare_data.py \
  --source-dir /path/to/other-pack/ \
  --out extension/data/ \
  --pack-id   "my-api-pack" \
  --pack-name "My API Pack" \
  --platform  "other" \
  --merge
```

## 🤖 cARL Agent Governance

This repository uses [cARL](https://github.com/goldjg/cARL) (Cognitive Agent Runtime Layer) to provide
persistent governance and architectural context for AI coding agents (GitHub Copilot, Claude, Codex, etc.).

The cARL artefacts live in `.github/carl/` and `.github/instructions/`. They are loaded automatically
by supported agents at the start of every session. Human contributors do not need to interact with
cARL directly, but should be aware of:

- **`.github/carl/memory.md`** — Durable architectural truth cache for APISpy. Contains architecture
  facts, test commands, invariants, and security assumptions that agents carry between sessions.
- **`.github/carl/current-pr-contract.md`** — Scoped implementation contract for the active PR.
  Before starting work with an agent, populate this file with the PR goal and approved scope.
- **`.github/carl/invariants.yml`** — Machine-readable governance invariants enforced across all PRs.

### cARL CLI (optional, for repo maintainers)

If you have the `carl` CLI installed ([download from releases](https://github.com/goldjg/cARL/releases)):

```bash
# Check runtime health
carl version
carl doctor

# Restore any drifted managed artefacts (memory.md and runtime.json are never overwritten)
carl repair
```

## 🔄 Pull Request Process

1. **Fork** [UndREST-APISpy](https://github.com/UndREST-Labs/UndREST-APISpy)
2. **Create a branch** for your feature (`git checkout -b feature/your-feature`)
3. **Make your changes** following the guidelines above
4. **Test** — run JS tests and manually verify in the extension
5. **Commit** with clear messages (`git commit -m "Fix: matcher handles ARM batch requests"`)
6. **Push** to your fork and **create a Pull Request**

### PR Checklist

- [ ] Code follows style guidelines
- [ ] All existing JS tests still pass
- [ ] New functionality is tested (JS unit tests or manual test notes)
- [ ] Documentation is updated if behaviour changes
- [ ] No sensitive data or credentials included

## 🐛 Reporting Issues

When reporting bugs, include:
1. Browser and version (Chrome/Edge)
2. Steps to reproduce
3. Expected vs actual behaviour
4. Screenshots or console output if applicable

## 🔐 Security Considerations

- **Never commit secrets** or credentials
- **Don't include real Azure subscription IDs** in examples or tests
- **Sanitise test data** before including in PRs

## 📚 Learning Resources

- [Chrome Extensions Documentation](https://developer.chrome.com/docs/extensions/)
- [Chrome DevTools Extensions](https://developer.chrome.com/docs/extensions/mv3/devtools/)
- [Azure REST API Specifications](https://github.com/Azure/azure-rest-api-specs)

## 📧 Contact

For questions or discussions:
- Open a GitHub issue in [UndREST-APISpy](https://github.com/UndREST-Labs/UndREST-APISpy/issues)
- For SpeQL/inventory questions, see [UndREST-SpecQL](https://github.com/UndREST-Labs/UndREST-SpecQL/issues)

Thank you for contributing to APISpy and UndREST Labs!
