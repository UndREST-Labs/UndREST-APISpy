# Adding a New API Pack to APISpy

A **pack** is a named set of shards that describes one platform's API surface
(e.g. Azure REST API Specs, AWS API, Google Cloud API).  The extension
manifest (`extension/data/manifest.json`, schema 2.0.0) groups shards by pack,
which allows the extension to load and enable packs independently and gives
users the ability to choose which pack(s) are active.

This guide walks through the steps needed to add shards for a new API platform.

---

## Concepts

| Term | Description |
|------|-------------|
| **Pack** | A named collection of shards from one API source (e.g. AWS REST API). |
| **Shard** | A single `.min.json` file covering one provider/service namespace within a pack. |
| **Pack ID** | A machine-readable slug identifying the pack (e.g. `aws-rest-api-specs`). |
| **Platform** | A short platform tag used in the UI (e.g. `azure`, `aws`, `gcp`). |

---

## Step 1 — Generate shards for the new API

The shard format (schema 3.0.0) is defined by [UndREST-SpecQL](https://github.com/UndREST-Labs/UndREST-SpecQL).
Each shard file is a minified JSON document with this top-level shape:

```json
{
  "metadata": {
    "generated_at": "2026-03-21T22:51:41Z",
    "source_repo": "YourOrg/your-api-specs",
    "source_branch": "main",
    "source_commit": "<sha>",
    "tool_name": "YourTool",
    "schema_version": "3.0.0"
  },
  "provider_namespace": "YourService.SubService",
  "hosts": {
    "api.yourservice.example.com": {
      "routes": {
        "GET /resources/{resourceId}": {
          "method": "GET",
          "path_template": "/resources/{resourceId}",
          "provider_namespace": "YourService.SubService",
          "plane": "data",
          "lookup_key": "api.yourservice.example.com|GET|/resources/{resourceId}",
          "versions": { "2024-01-01": {} }
        }
      }
    }
  }
}
```

Produce one `.min.json` file per service namespace and place them all in a
local directory, e.g. `inventory/shards/`.

---

## Step 2 — Bundle shards into the extension

Run `scripts/prepare_data.py` with the pack metadata arguments:

```bash
python3 scripts/prepare_data.py \
  --source-dir inventory/ \
  --out extension/data/ \
  --pack-id   "aws-rest-api-specs" \
  --pack-name "AWS REST API Specs" \
  --platform  "aws" \
  --pack-description "AWS service API specifications from aws/aws-sdk." \
  --merge
```

`--merge` preserves any existing packs already in `extension/data/manifest.json`.
Without it, the manifest is replaced with only the new pack.

Shards for non-default packs are stored in a subdirectory named after the
pack ID to avoid filename collisions:

```
extension/data/shards/
  aws-rest-api-specs/
    SomeService.SubService.min.json
    ...
```

The `filename` field in the manifest entry will be
`aws-rest-api-specs/SomeService.SubService.min.json` (relative to
`extension/data/shards/`).

---

## Step 3 — Register a custom request normaliser (if needed)

The built-in normaliser in `extension/lib/normalizer.js` is tuned for Azure
Resource Manager URL patterns.  If the new API uses a different URL structure
you can register a pack-specific normaliser:

```js
// In a new file, e.g. extension/lib/normalisers/aws.js

(function (exports) {

  function matchesRequest(host, _path) {
    return host.endsWith(".amazonaws.com");
  }

  function normalise(rawUrl, rawMethod) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch (err) {
      return { ok: false, error: "invalid_url: " + String(err) };
    }

    const method   = (rawMethod || "GET").toUpperCase().trim();
    const host     = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;

    // Apply AWS-specific path normalisation here.
    const normalisedPath = normaliseAwsPath(pathname);

    return {
      ok: true,
      method,
      host,
      pathname,
      normalisedPath,
      armPath: normalisedPath,   // reuse normalisedPath when no distinct form needed
      apiVersion: parsed.searchParams.get("version") || null,
      fullUrl: rawUrl,
    };
  }

  function normaliseAwsPath(path) {
    // ... your normalisation logic ...
    return path;
  }

  // Self-register when loaded in a browser context.
  if (typeof window !== "undefined" && window.Normalizer) {
    window.Normalizer.registerPackNormaliser("aws-rest-api-specs", { matchesRequest, normalise });
  }

  // Export for Node.js tests.
  if (typeof exports !== "undefined") {
    exports.AwsNormaliser = { matchesRequest, normalise };
  }

}(typeof window !== "undefined" ? window : exports));
```

Then load it in `extension/panel.html` **after** `lib/normalizer.js` and
**before** `panel.js`:

```html
<script src="lib/normalizer.js"></script>
<script src="lib/normalisers/aws.js"></script>   <!-- ← new -->
<script src="lib/loader.js"></script>
<script src="lib/matcher.js"></script>
<script src="panel.js"></script>
```

And in `extension/devtools.html` (for sweep mode) in the same order:

```html
<script src="lib/filters.js"></script>
<script src="lib/normalizer.js"></script>
<script src="lib/normalisers/aws.js"></script>   <!-- ← new -->
<script src="lib/loader.js"></script>
<script src="lib/matcher.js"></script>
<script src="devtools.js"></script>
```

The normaliser's `matchesRequest(host, path)` function is tested first for
every incoming request.  If it returns `true`, the normaliser's own `normalise()`
function is called instead of the built-in Azure ARM normaliser.

---

## Step 4 — Add a scope filter for the new platform (if needed)

`extension/lib/filters.js` contains the list of hosts and path prefixes that
APISpy considers "in scope".  If the new API runs on a different host domain,
add it to the appropriate list:

```js
// Exact hosts
const EXACT_HOSTS = new Set([
  "management.azure.com",
  // ... existing ...
  "api.yourservice.example.com",   // ← add new exact host
]);

// Or use a suffix pattern for multiple subdomains:
const HOST_SUFFIXES = [
  ".azure.com",
  // ... existing ...
  ".amazonaws.com",   // ← add new suffix
];
```

---

## Step 5 — Automate shard updates with a GitHub Actions workflow

Copy `.github/workflows/update-shards.yml` to a new file (e.g.
`update-shards-aws.yml`) and point it at the new pack's release artifact
and SpecQL instance:

```yaml
name: Update AWS Extension Shards

on:
  workflow_dispatch:
    inputs:
      merge:
        description: 'Merge into existing manifest'
        required: false
        default: 'true'

jobs:
  update-shards:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.x' }
      - run: pip install -r requirements.txt

      - name: Download AWS shards
        run: |
          mkdir -p inventory
          # Download your pack's shard zip here
          gh release download shards-latest \
            --repo YourOrg/your-api-specs-tool \
            --pattern "api-index-sharded-*.zip" \
            --dir inventory/ --clobber
          unzip -o inventory/api-index-sharded-*.zip -d inventory/
        env:
          GH_TOKEN: ${{ secrets.YOUR_READ_TOKEN }}

      - name: Prepare shard data
        run: |
          python3 scripts/prepare_data.py \
            --source-dir inventory/ \
            --out extension/data/ \
            --pack-id   "aws-rest-api-specs" \
            --pack-name "AWS REST API Specs" \
            --platform  "aws" \
            --merge

      - name: Commit
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add extension/data/
          git diff --cached --quiet || \
            git commit -m "chore: update AWS shard data [skip ci]" && \
            git push origin HEAD:"${GITHUB_REF_NAME}"
```

---

## Step 6 — Reload the extension and verify

1. Reload the unpacked extension in Chrome (**chrome://extensions → 🔄**)
2. Open DevTools on a page that calls the new API
3. Click the **Packs** button in the APISpy toolbar
4. Confirm the new pack appears and is enabled
5. Observe requests being classified against the new pack's shards

---

## Checklist

- [ ] Shard files generated in schema 3.0.0 format
- [ ] `prepare_data.py --merge` run successfully — manifest v2.0.0 updated
- [ ] Custom normaliser registered (if host/path structure differs from ARM)
- [ ] `filters.js` updated with new hosts/suffixes (if new domain)
- [ ] Dedicated GitHub Actions workflow added for automated shard updates
- [ ] Tests added for the new normaliser in `tests/`
- [ ] Extension reloaded and manually verified in DevTools
