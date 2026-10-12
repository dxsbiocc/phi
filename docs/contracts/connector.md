# Connector contract

contractVersion: 1.6.0

A **connector** gives Phi an MCP server: a remote HTTP server (most catalog entries) or
a local stdio server that runs in a managed environment. Connectors are distributed as
packages (`type: mcp`, added here as package contract 1.1.0), so the catalog can grow
without an app release. Public REST databases are API skills, not connectors (content
distribution design §8.3). See the [package](package.md),
[environment](environment.md), and [enablement](enablement.md) contracts.

## 1. Package layout

```text
<connector-id>/
  phi-package.yaml          # type: mcp, with the `connector` block (§ 2)
  icon.<extension>         # optional SVG, PNG, WebP, JPG, or JPEG catalog image
  environment.yml           # stdio only, optional (§ 3)
  locks/<platform>.txt      # with environment.yml
  <server files>            # stdio only: what `command` runs, when not provided by the environment
```

Package-local icons follow [package contract](package.md) § 4.2 and the
[content icon convention](../content-icons.md). The builder retains the image in the
verified archive and emits optional registry sidecar metadata, so directory-source
catalogs can show icons before installation and installed connectors retain them.
Missing or invalid images use the MCP fallback; no `connector` field is required.

## 2. The `connector` block

Shared package fields (package contract § 1) plus:

| Field                   | Required   | Rule                                                                                                                                                                      |
| ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connector.transport`   | yes        | `http` or `stdio`                                                                                                                                                         |
| `connector.publisher`   | yes        | 1–80 characters                                                                                                                                                           |
| `connector.category`    | yes        | one of the catalog categories: `生产力`, `沟通协作`, `设计创作`, `健康与生命科学`, `科研数据`                                                                             |
| `connector.homepage`    | no         | `https://` URL                                                                                                                                                            |
| `connector.url`         | http only  | `https://` URL of the MCP endpoint                                                                                                                                        |
| `connector.auth`        | http only  | `none`, `oauth` (the server's own sign-in flow, as today), or `header` (the user enters a token once; stored like other provider secrets)                                 |
| `connector.environment` | stdio only | `phi:<name>@<major>` or `./environment.yml` (environment contract; a package-local environment uses scope `mcp` and the package id as owner — environment contract 1.3.0) |
| `connector.command`     | stdio only | the program to run, resolved **inside** the environment, or `./<path>` relative to the package                                                                            |
| `connector.args`        | stdio only | list of strings; `${package}` expands to the installed package directory                                                                                                  |
| `connector.secrets`     | no         | **reserved** for stdio servers that need credentials; v1 rejects it                                                                                                       |

Unknown keys under `connector` are errors.

## 3. Install and run

- **HTTP**: installing writes the server into `mcp.json` exactly as adding it from the
  catalog does today (name = package id; `type: http`; `url`); sign-in follows `auth`.
  The `mcp.json` entry records the package id so updates and uninstall find it.
  Uninstall removes that entry; a server the user added by hand is never touched.
- **stdio**: installing places the package under `~/.phi/packages/mcp/<id>/<version>/`
  and writes an `mcp.json` entry built by the managed stdio mechanism: the command is
  resolved inside the environment and started with exactly the execution contract's
  variables, so host variables never reach the server. An environment declaring
  `installation` is built and its MCP initialize/tools handshake verified before
  the new package version is activated. Failure preserves the previous version
  and enablement. Legacy environments without installation retain their existing
  first-use preparation. When the environment's envId changes, the entry is regenerated.
- Enablement (`mcp:<package id>`) controls whether the server's `mcp.json` entry is
  enabled. Defaults: catalog connectors the user added are enabled; nothing is added
  without the user's action.

Setup operations persist an identity and last stage. Interrupted operations restore as
failed with an explicit retry. Active stdio consumers lease their original environment;
upgrades/uninstall do not delete their prefix, cache or old package source until leases
are released. Cleanup validates owned runtime paths under the environment lock.

## 4. User-defined local stdio connectors

The custom-connector UI may also add a local stdio server without installing a
connector package. These entries are application-owned configuration, not part of the
package contract:

- `phiOrigin: 'user-stdio'` is the ownership proof used for removal. Phi never removes
  a hand-written or package-owned entry through this flow.
- `phiUser` records the selected runtime: `{ kind: 'environment', ref }` for a ready
  managed environment, `{ kind: 'host' }` for an absolute host executable, or
  `{ kind: 'bun' }` for Phi's bundled Bun. It also records the user-provided non-secret
  environment variables. Managed-environment entries retain their version-1
  `phiManaged` marker without package fields; host and Bun entries have no `phiManaged`
  marker.
- All three runtime modes launch an explicit argv through `/usr/bin/env -i`; no shell parses
  the command or arguments. Presentation surfaces show the original command and argv
  plus environment-variable names, never their values or the `env -i` wrapper.
- Host and Bun runtimes inherit only `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `TERM`, `TZ`,
  `LANG`, proxy variables, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `SSH_AUTH_SOCK`, and
  `LC_*`; malformed values and other host variables are dropped. Host mode retains the
  user's `PATH`. Bun mode instead uses only the bundled Bun directory and system paths,
  and keeps its package cache under Phi's runtime root.
- Bun accepts only the `x` and `run` subcommands. The executable path is selected by
  Phi, never by connector input; arguments remain an argv array and never pass through a
  shell.
- `connector.secrets` remains reserved. Custom environment variables are for
  non-sensitive configuration only and cannot override Phi's execution-contract
  variables.
- Adding a local stdio connector is a cancellable background setup job. Input,
  runtime readiness, executable availability, and name collisions are validated before
  the dialog closes. The enabled `mcp.json` entry is written only after a successful
  initialize/tools probe, then applied to running sessions. Failure or cancellation
  writes no entry.
- User-initiated local probes have a bounded 10-minute deadline. Cancellation aborts the
  worker request, closes its owned stdio transport, terminates the child process tree,
  and releases any environment lease. Package-install verification keeps its existing
  90-second default.
- Local setup records add optional presentation fields `kind: 'local-stdio'`, `title`,
  `startedAt`, and `summary`. The summary contains display argv and environment-variable
  names only; environment values are never persisted. Active records restored after an
  app restart become failed and require the connector to be added again because the full
  request remains in memory only.

## 5. Catalog

The connector catalog shows `type: mcp` packages from the verified official Phi
Packages registry, user-imported registries, and installed connectors. The official
source takes precedence for duplicate IDs; connector sources are not bundled with
Phi. An entry already present in `mcp.json` shows as added. Entries that need a newer
app version remain visible but cannot be added. Raw directory imports retain
imported trust, regardless of their directory name or location. See the
[official content source decision](../decisions/official-content-source.md).

Users may also import a public `github.com` repository as a catalog source. Phi resolves
the requested branch or ref once and pins the source to its 40-character commit SHA.
Import only validates and materializes `type: mcp` packages; it does not execute package
code, build an environment, or install a connector. GitHub sources are recorded separately
in `~/.phi/state/github-sources.json`, remain `imported`/unsigned, and show their repository
plus short SHA in the catalog. Installing one requires an explicit confirmation of its HTTP
URL or exact stdio command, arguments, and environment reference. Manual source updates
show a package-version diff before switching; removing a source does not remove connectors
already installed from it. See the [GitHub sources decision](../decisions/github-sources.md).

## 6. Versioning

`contractVersion` follows the content distribution design §4.4: minor versions are
additive only (for example allowing `secrets`); anything else needs a decision record
and a deprecation window.

## Changes

- **1.6.0** (2026-10-11): make user-defined local stdio addition a cancellable
  background setup job with a 10-minute probe deadline and privacy-safe persisted
  presentation metadata.

- **1.5.0** (2026-10-11): add the Phi-bundled Bun runtime for user-defined stdio
  connectors and document the host/Bun environment allowlist and Bun subcommand policy.

- **1.4.0** (2026-10-11): add SHA-pinned public GitHub repositories as unsigned,
  preview-only MCP catalog sources with explicit install confirmation.

- **1.3.0** (2026-10-11): add the application-owned `phiOrigin: 'user-stdio'` and
  `phiUser` contract for user-defined local stdio connectors; secrets remain reserved.

- **1.2.0** (2026-10-09): document pre-activation managed installation/probing, persistent setup recovery, and lease-protected cleanup with environment contract 1.4.0.

- **1.1.0** (2026-10-08): clarify optional package-local images and registry sidecars
  using package contract 1.3.0. Additive; existing connectors remain valid.
