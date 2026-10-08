# Official content source

Date: 2026-10-08

The requested primary domain-content source is the public
[phi-packages repository](https://github.com/dxsbiocc/phi-packages), published as the
signed [catalog-v1 release](https://github.com/dxsbiocc/phi-packages/releases/tag/catalog-v1).
This supersedes the earlier local-registry-first rollout choice for the current build.

- Catalogs load the fixed official source first, followed by user-imported directories.
  Official entries take precedence for duplicate package IDs. Existing installed,
  project, and user-authored content remains available.
- Browsing obtains a verified index, connector manifest sidecars and optional icons.
  Selected installation/update plans fetch their required archives through Chromium's
  desktop networking, then reuse the normal integrity checks and installer.
- Signed metadata is activated atomically under
  `~/.phi/cache/registries/phi-packages/generations/<index-sha256>/`. Verified caches
  remain usable offline; failures never fall back to domain content in `resources/`.
- Standalone skills, plugins and MCP packages install under
  `~/.phi/packages/<type>/<id>/<version>/`. Wrapper families install into
  `~/.phi/wrappers/tree/`, with ownership/provenance in `wrappers/tree.json`.
- Desktop packaging excludes domain connector/plugin/wrapper/skill sources. Core
  runtimes, palettes, system agents and `create-wrapper` remain in the application.
- Former bundled plugin installations without `.source.json` are recognized only
  after the plugin loader validates them. Malformed existing provenance remains rejected.

The dedicated Ed25519 private signing key stays at
`~/.phi/publishing/phi-packages-ed25519.pem` with owner-only permissions. It was created
with explicit user approval and is never committed or uploaded. Phi embeds only its
public key. See [publishing instructions](https://github.com/dxsbiocc/phi-packages/blob/main/docs/publishing.md)
and the [package contract](../contracts/package.md).

Existing licensed Office installations are retained. Office is not distributed by the
public catalog. Cleanup preserves sessions, credentials, live databases/WAL, analysis
artifacts, custom resources, legacy wrappers still read by current tools, and environments
with historical references. Data migrations keep a private backup and record versioned
references for retained historical plugin environments.
