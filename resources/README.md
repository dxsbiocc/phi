# Phi core resources

This directory contains application-owned assets, not the installable content
catalog. Distributable connectors, standalone skills, visualization, and wrappers
are maintained in [phi-packages](https://github.com/dxsbiocc/phi-packages).

| Path | Ownership |
| --- | --- |
| `icon.png` | Application icon |
| `agents/` | Core Wrapper agent |
| `skills/create-wrapper/` | Core wrapper-authoring skill |
| `palettes/` | Application palette definitions |
| `runtime/` | Managed runtime manifests, environments, and locks |
| `office/` | OfficeCLI runtime manifest and fetched platform binary |
| `plugins/office/` | Retained private Office plugin; some components restrict redistribution |

`agents/` currently contains only `Wrapper.md`. Phi directly loads this core
definition for local delegation and its restricted SSH-project toolbox. Moving
it into an optional package requires updating that loading contract first.
Domain agents belong in a plugin's `agents/` directory in phi-packages (for
example `plugins/visualization/agents/Visualization.md`) and install with that
plugin. The package contract currently has no standalone `agent` package type.

`office/` and `plugins/office/` serve different purposes. The former is a core
runtime, while the latter is private source and is excluded from desktop packages.
The application does not automatically install plugins from this directory.

Fetched Micromamba and OfficeCLI binaries are ignored by Git. Finder metadata,
Python caches, Nextflow work directories, and retired `db-connectors/` sources do
not belong here. `bun run check:resources` checks this boundary as well as
untracked run leftovers.

## Development checks

Core lint and `bun run test` do not require the content checkout. To validate actual
distributable content, clone phi-packages beside Phi, then run:

```sh
bun run check:package-content
bun run test:packages
```

`PHI_PACKAGES_ROOT=/path/to/phi-packages` selects another checkout for these checks.
Publishing, wrapper smoke/DAG generation, and visualization smoke commands also
accept `--source /path/to/phi-packages`. A missing content source produces an error
instead of using an old local copy. See the [official source decision](../docs/decisions/official-content-source.md).

The [content CI workflow](../.github/workflows/content.yml) keeps these checks
separate. Its core jobs run without a content checkout; the package job checks out
the reviewed `PHI_PACKAGES_REVISION` and runs content validation, conformance tests,
and offline wrapper smoke checks. Update that full commit SHA when intentionally
adopting a newer catalog source. The runtime isolation workflow remains separate.

`runtime:smoke:app:viz` explicitly installs visualization from the selected source
into its temporary account before launching the app. It does not depend on startup
auto-installation or the developer's existing Phi account.

This cleanup does not alter installed content, credentials, sessions, or artifacts
under `~/.phi`. In particular, `~/.phi/db-connectors/` still stores credentials and
is independent of the retired source directory.
