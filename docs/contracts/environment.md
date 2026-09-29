# Environment contract

Version **1.0.0**. Normative schemas:

- [environment.schema.json](environment.schema.json) — `environment.yml`
- [env-metadata.schema.json](env-metadata.schema.json) — `.phi/env.json`

The runtime copies live in `src/main/agent/envs/schemas.ts` and must stay deep-equal to those files. Parsing and id rules are implemented by `src/main/agent/envs/contract.ts`. This freezes L1 of the [runtime foundation](../design/phi-runtime-foundation.md) (§2–§3, §10). Versioning follows [content distribution design §4.4](../design/phi-content-distribution-design.md).

## Purpose

An environment is an immutable micromamba prefix identified by `envId`. Authors declare it in `environment.yml`. Official environments ship one explicit lock per platform; clients install from that lock and do not solve. `host`, `sourcePackages`, and `description` are Phi data. They are not conda input.

## Spec file (`environment.yml`)

UTF-8 YAML mapping. Unknown keys are errors, including conda keys this contract does not define (`prefix`, `variables`, and anything else).

| Field            | Required | Rule                                                                                         |
| ---------------- | -------- | -------------------------------------------------------------------------------------------- |
| `name`           | yes      | `^[a-z][a-z0-9-]{0,62}$`                                                                     |
| `channels`       | yes      | non-empty array of non-empty strings                                                         |
| `dependencies`   | yes      | at least one item: conda match-spec strings, or a single-key object `{ pip: [string, ...] }` |
| `description`    | no       | human-readable string; stripped before micromamba                                            |
| `host`           | no       | Phi extension below                                                                          |
| `sourcePackages` | no       | Phi extension below                                                                          |

## Phi extensions

`condaSpecOf` returns only `name`, `channels`, and `dependencies`. `description`, `host`, and `sourcePackages` are removed before anything is passed to micromamba. This contract does not invoke micromamba.

### `host`

Commands the host must already provide (LibreOffice, Docker, Singularity). Phi probes them and records the path it found. It does not install them.

| Field         | Required | Rule                                               |
| ------------- | -------- | -------------------------------------------------- |
| `name`        | yes      | plain command name, `^[A-Za-z0-9._+-]+$` (no path) |
| `description` | no       | string                                             |
| `platforms`   | no       | any of `darwin-arm64`, `darwin-x64`, `linux-x64`   |
| `candidates`  | no       | absolute paths to probe, each starting with `/`    |

### `sourcePackages`

R packages with no conda build, installed from a pinned source archive when the environment is built (foundation §3.5). Order matters: an entry may depend only on the conda dependencies or on earlier entries. Installation does not fetch dependencies from the network.

| Field      | Required    | Rule                                                                                                                                                                           |
| ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `language` | yes         | `r`                                                                                                                                                                            |
| `name`     | yes         | `^[A-Za-z][A-Za-z0-9.]*$`                                                                                                                                                      |
| `source`   | yes         | `cran` or `github`                                                                                                                                                             |
| `repo`     | github only | `owner/name` (`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`). Forbidden when `source` is `cran`                                                                                          |
| `ref`      | yes         | github: full 40-character lowercase commit sha. cran: exact version `^[0-9]+(\.[0-9]+){1,3}(-[0-9]+)?$`, such as `1.2.3` or `1.2.3-1`. Branches, tags, and ranges are rejected |
| `sha256`   | yes         | 64 lowercase hex characters; digest of the source archive                                                                                                                      |

## Lock files

One explicit lock per platform, at `locks/<platform>.txt` (for example `locks/darwin-arm64.txt`).

- A line whose first character is `#` is a comment.
- The first non-comment, non-empty line must be exactly `@EXPLICIT`.
- Every later non-empty, non-comment line is an `https://` URL ending in `#` and a 32-character lowercase md5.

`lockSha256` is the SHA-256 hex digest of the lock after this normalisation: normalise line endings to `\n`, trim whitespace on every line, and drop comment lines and empty lines. A comment-only edit, blank lines, indentation, a CRLF versus LF difference, or a final newline does not change the hash.

## Platforms

| Phi platform   | conda subdir |
| -------------- | ------------ |
| `darwin-arm64` | `osx-arm64`  |
| `darwin-x64`   | `osx-64`     |
| `linux-x64`    | `linux-64`   |

`currentPlatform(platform, arch)` joins `platform` and `arch` (defaulting to `process.platform` and `process.arch`) and returns that id when it is in the table. Any other pair, including `win32`, throws `unsupported platform: <platform>-<arch>`.

## Names and references

Environment names are kebab-case, matching `name` above. Phi-maintained environments use a `phi-` prefix and are named by purpose (`phi-python`, `phi-r`, `phi-nextflow`, `phi-jupyter`). Plugin-local names have no prefix (`viz`). See foundation §10.

`parseEnvironmentRef` accepts four forms and throws on anything else:

| Form                 | Result                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `phi:<name>@<major>` | `{ kind: 'phi', name, major }`. `major` is `0` or a decimal integer with no leading zeros |
| `plugin:<name>`      | `{ kind: 'plugin', name }`                                                                |
| `project:<name>`     | `{ kind: 'project', name }`                                                               |
| `./…`                | `{ kind: 'path', path }`. The path must stay under `./`: no empty, `.`, or `..` segments  |

`<name>` uses the environment name pattern. Examples: `phi:python@1`, `plugin:viz`, `project:default`, `./environment.yml`.

The reference token is the purpose (`python` in `phi:python@1`). The spec file's conda name for that environment is `phi-python`. `computeEnvId` does not rewrite the name you pass: pass `python` so the id is `phi-python-<hash12>`, not `phi-phi-python-…`.

## `envId`

```text
phi:     phi-<name>-<hash12>
plugin:  plugin-<owner>-<name>-<hash12>
project: project-<owner>-<name>-<hash12>
```

`owner` is required for `plugin` and `project` and, like `name`, must match `^[a-z][a-z0-9-]{0,62}$`; anything else is rejected so the id always matches the `env.json` pattern. `owner` is omitted for `phi` even when the caller passes one. Examples: `phi-python-3f9a1c2b7d10`, `plugin-visualization-viz-…`, `project-<short project id>-default-…`.

`<hash12>` is the first 12 hex characters of SHA-256 over the UTF-8 canonical JSON of:

```json
{
  "lockSha256": "<lockSha256>",
  "platform": "<platform>",
  "sourcePackages": []
}
```

Object keys are sorted at every level. `sourcePackages` stays in declared order. Each package object contains `language`, `name`, `ref`, `sha256`, and `source`, plus `repo` only when it is set. `lockSha256` is the normalised lock digest above. An omitted `sourcePackages` list hashes as `[]`. Changing the normalised lock or the source-package list changes the id.

## `env.json`

Path: `<prefix>/.phi/env.json`. Every field below is required. Use `{}` for `host` and `[]` for `sourcePackages` when there are none. Unknown top-level keys are errors.

| Field               | Rule                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------- |
| `envId`             | starts with a lowercase letter and ends with `-<12 lowercase hex>`                      |
| `name`              | environment name pattern                                                                |
| `kind`              | `base`, `package`, or `project`                                                         |
| `platform`          | a Phi platform id                                                                       |
| `lockSha256`        | 64 lowercase hex characters                                                             |
| `createdAt`         | ISO-8601 date-time with `Z` or a numeric offset, optional fractional seconds            |
| `micromambaVersion` | non-empty string                                                                        |
| `activation`        | `{ set: { <name>: <string> }, pathPrepend: [<string>, ...] }`, captured after the build |
| `host`              | map of command name to an absolute path                                                 |
| `sourcePackages`    | installed entries, same object shape as in the spec                                     |
| `status`            | `absent`, `building`, `ready`, `failed`, or `drifted`                                   |
| `contractVersion`   | `1.<minor>.<patch>`                                                                     |

`activation.set` is the diff of `micromamba run -p <prefix> env` against the sanitised base environment, including variables set by `activate.d` scripts. Later runs apply this snapshot directly.

## State machine

`canTransition(from, to)` is true only for these edges:

| From       | To                    |
| ---------- | --------------------- |
| `absent`   | `building`            |
| `building` | `ready`, `failed`     |
| `ready`    | `drifted`, `building` |
| `drifted`  | `building`            |
| `failed`   | `building`            |

`absent` means no prefix yet. A failed build deletes the prefix and records `failed`; there is no half-built environment. Repair moves `drifted` (or a `ready` environment being rebuilt) to `building`. `building` does not go directly to `drifted`, and `failed` does not go directly to `ready`.

## Versioning

`ENVIRONMENT_CONTRACT_VERSION` is `1.0.0`. Per content distribution design §4.4:

- Minor versions are additive only: new optional fields, no change to the meaning of existing fields.
- A major version needs an ADR, a deprecation window of at least two app releases in which both versions are accepted, and a migration note.
- Metadata records the `1.x.x` version it was written for.

The 1.0.0 schemas use `additionalProperties: false`. A conda key or typo that this version does not name fails validation instead of being forwarded. A later minor version adds an optional field by naming it in the schema.
