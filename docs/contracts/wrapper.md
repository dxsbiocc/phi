# Wrapper contract

contractVersion: 1.0.0

A **wrapper** makes one vendored Nextflow module, subworkflow, or workflow callable by
agents through the generic wrapper tools (`wrapper_search`, `wrapper_inspect`,
`wrapper_plan_run`, …). This contract freezes the wrapper adapter (§ 1–2), defines
wrapper **packages** — the tool-family unit Phi distributes — and the tree installed
packages are assembled into (§ 3–5). It builds on the [package contract](package.md)
(`type: wrapper`, added here as package contract 1.1.0) and the
[enablement contract](enablement.md) (`wrapper:` items, enablement 1.1.0). See
[content distribution design](../design/phi-content-distribution-design.md) §8.2 and
[bundled wrapper agent composition guide](../../resources/skills/create-wrapper/references/guide.md) §3–§4.

## 1. Adapter layout

```text
<kind>/<provider>/<path…>/          # the vendored component (nf-core or local)
  main.nf  meta.yml  environment.yml  tests/
  wrapper/                          # the adapter: only this makes it callable
    wrapper.yaml                    # required (§ 2)
    main.nf                         # required: the fixed entry point
    params.json                     # required: default parameter values (the only place for defaults)
    nextflow.config                 # optional: profiles (conda, docker, singularity)
    dag.mmd                         # optional: diagram for the UI
```

`<kind>` is `modules`, `subworkflows`, or `workflows`; `<provider>` is `nf-core` or
`local`. A component without `wrapper/` is not callable. Subworkflows and workflows
include modules by relative path (`../../../modules/…`), which is why installed wrappers
share one tree (§ 4).

## 2. `wrapper.yaml`

| Field     | Required | Rule                                                                                                              |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`      | yes      | `<provider>/<kind>/<name>` (e.g. `nf-core/modules/samtools-faidx`); unique across installed wrappers              |
| `name`    | yes      | 1–80 characters, shown to the user and the agent                                                                  |
| `summary` | yes      | 1–300 characters                                                                                                  |
| `params`  | yes      | map `<name>` → param (below); names `^[a-z][a-z0-9_]*$`                                                           |
| `outputs` | yes      | map `<name>` → `{ type, path, primary? }`; `path` may reference params as `${name}`; at least one `primary: true` |

A param is `{ kind, type, required?, description?, minimum?, maximum?, enum? }`:
`kind` is `input`, `output`, or `option`; `type` is a non-empty string (`path`,
`path_glob`, `fasta`, `integer`, `number`, `boolean`, `string`, …); `required` is a
boolean (default `false`); `minimum`/`maximum` only for numeric types; `enum` a list of
strings.

Defaults live **only** in `wrapper/params.json`. `wrapper.yaml` has no `default`,
`entrypoint`, `paramsFile`, environment, or agent hints. Unknown keys are errors.
`primary: true` outputs must exist after a successful run.

### Local differential-expression quality control

An installed DESeq2 adapter declares primary outputs `results` and `research_qc`.
The latter has type `research_qc` and suffix `.deseq2.qc.tsv`. Version 1 contains
a UTF-8 tab-separated header and a single record, with these columns in order:

```text
schemaVersion  disposition  contrast  geneIdColumn  padjThreshold  log2fcThreshold  evaluated  hits  resultMd5
```

The package computes the verdict from the published TSV. A valid screen with hits
is `eligible`, a valid screen with zero hits is `skip`, and an unevaluable screen
is `invalid`. Phi checks the declared artifacts, the counts and their relationship,
the supplied parameters and the checksum of the results file. A missing, corrupt
or inconsistent result fails the local run. The parent receives a compact verdict
and references. The plugin independently checks the result bytes and counts again
before ORA. A positive result makes ORA applicable when the user has approved
it and supplied an appropriate gene-set collection. Valid zero hits end
candidate-list ORA. The comparison, thresholds and design remain part of the
record for that run. A paired preflight can publish a version 1 `research_input`
question before stopping. Phi validates the two to four options and relays them to
the parent. An answer must be supplied before the dependent analysis can start.
Remote runs carry an explicit unverified state.

## 3. Wrapper packages

A wrapper package (`type: wrapper`, package contract § 1) contains:

| Package               | `id`                            | Contents                                                                                                      |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| a **module family**   | `module-<provider>-<tool>`      | every component under `modules/<provider>/<tool>/` (all subcommands of that tool, with or without `wrapper/`) |
| a **subworkflow**     | `subworkflow-<provider>-<name>` | `subworkflows/<provider>/<name>/`                                                                             |
| a **workflow**        | `workflow-<provider>-<name>`    | `workflows/<provider>/<name>/` (`workflows/<provider>/` itself when it holds one workflow)                    |
| a **scenario bundle** | `bundle-<name>`                 | no files; only `dependsOn`                                                                                    |

`_` in names becomes `-`. A package's files keep their tree-relative paths
(`modules/nf-core/samtools/faidx/wrapper/wrapper.yaml`), next to `phi-package.yaml` and
`files.json` at the package root. A subworkflow or workflow package `dependsOn` every
module family (and subworkflow) its `include` statements reach; the builder computes
this from the includes, and the installer refuses an include that no dependency
provides. Shared support files (container recipes under `images/`, tree-level config)
belong to the package whose components use them; a file used by several packages
goes into a `support-<provider>-<name>` package that they all depend on.

## 4. The wrapper tree

Installed wrapper packages are merged into **one** tree, `~/.phi/wrappers/tree/`,
mirroring the source layout so relative includes keep working unchanged. The installer:

1. refuses a package that would write a path another installed package owns;
2. copies the package's tree files in, verified against its `files.json`;
3. records which paths each package owns (`~/.phi/wrappers/tree.json`), so uninstall
   removes exactly those paths and an upgrade replaces them atomically per package;
4. never edits files it does not own; user-authored wrappers stay in
   `~/.phi/wrappers/custom/` and are not part of the tree.

This replaces the single "wrapper pack" install: there is no whole-tree pack, overlay
pack, or pack-level digest anymore.

## 5. Discovery and enablement

Wrapper tools see wrappers from installed packages that are **enabled**
(`wrapper:<package id>`), plus user-authored wrappers. Every wrapper package is
installed from the catalog, so installed and user-authored wrappers are enabled by
default; a package the user disabled stays out of use. Disabling a module family that an
enabled subworkflow depends on also hides that subworkflow, and the UI says why.

Removing a package previews what it affects before changing anything: it deletes every
file and folder the package owns, and enabled packages that depend on it are named.
Confirming disables those dependents first and then removes the package, so a dependency
cannot silently re-enable a package that was just removed. Tool binaries, container images
and runtime environments are not part of a wrapper package and are never deleted here.

Older builds seeded a bundled wrapper pack into `~/.phi/wrappers` before any user choice.
Those records are not catalog installs: startup replaces the ones still in use (chosen, or
required by an installed package) with catalog copies, then deletes the rest. Dependency
planning never treats such a legacy record as installed, so a catalog install replaces it
instead of being skipped.

## 6. Versioning

`contractVersion` follows the content distribution design §4.4: minor versions are
additive only; anything else needs a decision record and a deprecation window.
