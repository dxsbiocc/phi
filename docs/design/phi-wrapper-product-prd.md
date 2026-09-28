# Phi Wrapper Product PRD

Date: 2026-09-09

Phi Wrapper is a reproducible execution layer for bioinformatics and other heavy command-line tools. It lets Phi and its agents call fixed, verified wrappers instead of asking the agent to assemble software environments, shell commands, workflow syntax, and result paths dynamically.

The long-term product direction is remote-first: real bioinformatics workloads should ultimately run on a remote server or HPC system, with Phi acting as the control plane for planning, approval, submission, monitoring, result browsing, and audit. But delivery is phased local-first. Phase 1 proves the wrapper model end-to-end (manifest, plan, chat integration, execution, outputs) entirely on local Nextflow, with no SSH, no scheduler, and no signed registry. Remote/HPC execution and the full trust/registry infrastructure are Phase 2 and Phase 3. This order exists because the riskiest, least-proven part of this feature is the wrapper abstraction itself (does a fixed manifest + plan/submit flow actually fit how the agent and user want to run tools), not the SSH/Slurm plumbing. Validate the abstraction locally before paying for remote-execution complexity. See [Phased Scope](#phased-scope).

## Problem

Bioinformatics work spans many tools, runtimes, databases, containers, references, schedulers, and output conventions. Asking an agent to solve those details at run time is unreliable. The common failure mode is not just a wrong command; it is an unreproducible environment, silent data movement, unclear resource use, and outputs that the UI cannot interpret.

Phi Wrapper solves this by making each executable unit fixed and declared:

- The workflow is checked in and verified.
- The environment is pinned by digest where possible.
- Inputs, parameters, outputs, permissions, resources, and citations are declared in a manifest.
- The agent receives a typed wrapper tool, not raw shell access.
- Every run produces a durable plan, run record, logs, outputs, and reproducibility metadata.

## Product Goals

- Make bioinformatics wrappers callable from Phi, CLI, and agents without dynamic environment handling.
- Default to verified, reproducible wrappers.
- Keep remote/HPC execution as the primary path for resource-heavy tasks.
- Support local execution for development, smoke tests, and light work.
- Provide a consistent run plan, approval, audit, monitoring, and result browsing experience.
- Avoid automatic upload or download of large data.
- Integrate with current Phi concepts: projects, sessions, approvals, plugins, skills, MCP, file preview, and the right-side file browser.

## Non-Goals

These hold across all three phases unless a phase note says otherwise:

- Do not make the agent generate workflow code dynamically.
- Do not support arbitrary wrapper composition.
- Do not treat local execution as the permanent default for heavy bioinformatics workloads once Phase 2 remote execution exists. (Phase 1 has no remote at all, so every run is local by necessity — that's expected and is not the same thing as making local the long-term default for heavy work once remote is available.)
- Do not auto-install Docker, Java, Nextflow, Apptainer, or HPC dependencies.
- Do not auto-sync project data to remote servers.
- Do not auto-download remote results.
- Do not build a public marketplace.
- Do not depend on Seqera Platform, Tower, CWL, WDL, or a remote daemon.
- Do not promise full clinical, HIPAA, GDPR, or IRB compliance automation.

## Users

- Bioinformatics researchers who need repeatable NGS, single-cell, genomics, proteomics, and QC workflows.
- Phi users who want agents to launch verified computational work without environment guesswork.
- Project developers who want to publish reusable wrappers from GitHub.
- Lab or organization maintainers who may later provide organization-verified private wrapper registries.

## Relationship To Notebook Analysis

Phi already has an interactive analysis path: Jupyter-backed notebooks where the agent writes and runs Python/R code cell by cell against local kernels. Phi Wrapper is a second, deliberately different execution path. They are not competing implementations of the same feature; they serve different moments in a research workflow.

|                       | Notebook analysis                                        | Phi Wrapper                                               |
| --------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Code origin           | Agent writes code live                                   | Fixed, versioned, checked-in workflow                     |
| Typical use           | Explore, iterate, plot, debug a hypothesis               | Run a known heavy/standard pipeline (QC, alignment, etc.) |
| Reproducibility       | Best-effort; depends on what the agent happened to write | Guaranteed by manifest + digests                          |
| Resource profile      | Light, interactive, in-process                           | Can be light, standard, heavy, or HPC-scale               |
| Environment           | Whatever kernel/venv is active                           | Pinned by manifest (container/conda)                      |
| Failure mode if wrong | Cheap to notice and rerun a cell                         | Expensive if a mis-specified run burns compute            |

Guidance for the agent: prefer notebook analysis when the task is exploratory, needs custom logic, or produces small in-memory results; prefer a wrapper when a community-standard or lab-standard pipeline already exists for the task and reproducibility/resource cost matters. The agent should not silently choose a wrapper without the user seeing the plan card, and should not implement a hand-written substitute for a workflow that has a verified wrapper available. Where both are plausible, the agent asks or offers a choice rather than picking silently — do not add heuristics that guess this automatically in Phase 1; that can come later once we see how users actually choose.

## Core Concepts

### Wrapper

A wrapper is a fixed, validated, reproducible executable unit. It is not a prompt, not an MCP server, and not a general plugin.

Wrappers are first-class Phi resources:

- They have their own sidebar entry.
- They use their own installation directory under `~/.phi/wrappers`.
- They have independent run history and metadata.
- They may be installed through plugin-like UX, but they are not stored as ordinary plugins.

### Verified By Default

Phi defaults to running verified wrappers only.

Target trust tiers (full model, Phase 3):

- `official_verified`: signed by the Phi official registry.
- `community_verified`: signed by a community registry and enabled by policy.
- `organization_verified`: signed by a configured organization registry.
- `compatible`: schema-valid but not verified by a trusted registry.
- `custom`: local, dev, or project-defined wrapper.

Phase 1 trust model (simplified): only two tiers exist — `bundled` (ships inside the Phi app, no network install, treated as the Phase-1 equivalent of "verified" for default agent tool registration) and `custom` (any other local/dev wrapper path, requires explicit user intent, never a default agent tool). There is no registry, no signing, and no GitHub install source yet. The `WrapperTrustTier` type should still be modeled as the full Phase 3 union from the start (see technical design) so Phase 1 code does not need a breaking type change later — it just only ever produces `bundled` or `custom` values.

Agent behavior (target, full tiers):

- Trusted verified wrappers can be registered as agent tools.
- Compatible wrappers are visible but not default agent tools.
- Custom/project wrappers require explicit user intent.
- Blocked wrapper versions cannot be selected by default.

Agent behavior (Phase 1): `bundled` wrappers register as default agent tools; `custom` wrappers require explicit user intent. There is no `compatible` or `blocked` state yet — a wrapper is either the one bundled demo (trusted) or something the user pointed at manually (not trusted by default).

### Run Plan

A run plan is a persisted, executable plan that has not yet been submitted. Natural language analysis plans are separate and cannot be submitted directly.

A run plan contains:

- Wrapper id, version, trust tier, source, and digests.
- Parameters and schema validation result.
- Input resolution and samplesheet preview.
- Executor and profile resolution.
- Resource and permission summary.
- Command plan and path mappings.
- Validation status and revision.

### Wrapper Run

A wrapper run is an independent durable object created when a validated plan is submitted.

A run survives chat context changes and app restarts. It is visible in:

- The origin chat timeline.
- The Wrappers page run history.
- Project-related run lists.

Deleting or archiving a chat must not delete wrapper run history.

## UX Model

### CLI (Phase 2)

The CLI is deferred to Phase 2. Phase 1 validates the wrapper model through the Phi desktop UI and agent tools only — a CLI is mainly useful for headless/remote workflows and wrapper-authoring iteration, neither of which is the Phase 1 focus. Keep the surface below as the target shape so Phase 2 doesn't redesign it.

Canonical CLI:

```bash
phi-wrapper list
phi-wrapper inspect phi/ngs/fastq-qc
phi-wrapper validate phi/ngs/fastq-qc --params params.yaml
phi-wrapper plan phi/ngs/fastq-qc --params params.yaml
phi-wrapper submit wplan_...
phi-wrapper run phi/ngs/fastq-qc --params params.yaml
phi-wrapper runs
phi-wrapper show wrun_...
phi-wrapper doctor
```

Optional domain alias:

```bash
phi-bio run fastq-qc
```

`phi-bio` is only an alias. Internal APIs and agent tools use the canonical wrapper runtime.

### Phi Desktop

Wrappers appear as a first-class activity bar entry beside chat, projects, plugins, skills, and MCP.

The Wrappers page focuses on:

- Catalog. (Phase 1: bundled + custom only; Phase 3: registry catalog.)
- Installed wrappers.
- Trust tier and version state.
- Manifest details.
- Runtime readiness.
- Run history.
- Output and report links.
- Local or remote file tree entry points. (Remote entry point is Phase 2.)

The primary submission UX is not a large sidebar form. When an agent prepares work, Phi creates a structured wrapper plan item in the chat timeline. This item uses the same pending-action design language as permission requests, but it is its own request type. It is not the Add menu popover.

The wrapper plan card shows:

- Wrapper id, name, version, and trust tier.
- Executor, remote connection, and profile. (Phase 1: executor is always `local`, no remote connection field is shown.)
- Inputs and samplesheet summary.
- Output directory.
- Resource request.
- Network and permission summary.
- Command plan summary.
- Actions: validate, submit, cancel, inspect, open settings.

Do not use nested bordered subgroups inside this card. Prefer compact rows, chips, icons, and expandable sections.

### Remote File Browsing (Phase 2)

Remote file browsing is a Phi-wide capability, not wrapper-specific. Phase 1 only needs the local output directory entry point, which reuses the existing local file preview panel — no new browsing capability is required for Phase 1.

Wrapper run detail can open the right-side file browser at:

- Remote output directory.
- Remote work directory.
- Declared report path.
- Local output directory.

Remote browsing streams previews over SSH. It does not imply downloading the file.

## Execution Policy

### Phase 1: Local Only

In Phase 1 there is no remote connection model, so there is no resolver to run. Every plan executes with `executor: local`. `resourceClass: heavy` or `hpc` wrappers are not blocked from running locally, but the plan card surfaces a visible resource warning ("this is a heavy workload; Phase 1 has no remote execution") that the user must acknowledge before submit — this keeps the heavy-workload confirmation _concept_ alive without requiring remote infrastructure to exist yet. The demo wrapper for Phase 1 (`fastq-qc`) is deliberately `resourceClass: light` so this warning path is rarely exercised in the reference flow, but the field and the check exist from the start.

### Phase 2: Remote-First Resolver

Once remote connections exist, the executor/profile resolution below applies. This section describes the Phase 2 target, not Phase 1 behavior.

Default executor/profile resolution:

```text
1. Explicit run executor/profile
2. Project default executor/profile
3. Global default executor/profile
4. Auto resolver
```

Auto resolver:

```text
If the current project has a remote binding:
  run remote doctor
  if Slurm exists, choose slurm
  otherwise choose remote-background

If the project has no remote binding:
  allow local only for light work or explicit fallback
  for heavy/hpc wrappers, prompt to configure remote or confirm local fallback
```

### Heavy Workloads

Wrappers declare `resourceClass`:

```text
light
standard
heavy
hpc
```

Heavy and HPC wrappers must not silently run locally when no remote is configured. (Phase 2; see Phase 1 note above for the interim warning-based behavior before remote connections exist.)

### Data Movement

Phase 2 remote execution assumes the data already exists on the remote server.

Phi does not automatically:

- Upload FASTQ, BAM, CRAM, VCF, matrix, or project directories.
- Sync project directories.
- Download output directories.
- Download final reports.

Phi does:

- Map local project paths to remote project roots.
- Validate remote input existence.
- Upload the small verified wrapper execution bundle.
- Upload params, config, and launch scripts.
- Browse and preview remote results over SSH.
- Download only when the user explicitly selects files.

## Wrapper Lifecycle

### Install

Phase 1 has exactly two ways a wrapper exists on disk: it ships bundled inside the app (`~/.phi/wrappers/installed/phi/ngs/fastq-qc/1.0.0/`, written at first run / app update, not user-installed), or a developer points Phi at a local directory in dev mode. There is no install command, no registry, and no GitHub fetch in Phase 1.

```bash
# Phase 1: dev/custom only, no CLI — the equivalent Phase 1 action is
# "open Wrappers page > Add custom wrapper > choose local folder"
```

Target CLI shape, not built in Phase 1 (`--dev` becomes available once the Phase 2 CLI ships; `registry:`/`github:` need the Phase 3 signed registry):

```bash
phi-wrapper install registry:phi/ngs/fastq-qc@1.0.0  # Phase 3
phi-wrapper install github:phi-wrappers/ngs-fastq-qc@v1.0.0  # Phase 3
phi-wrapper install --dev /path/to/local/wrapper  # Phase 2 (Phase 1 does the same thing through the UI, no CLI)
```

Rules (apply once registry/GitHub sources exist in Phase 3):

- Registry and GitHub refs are supported.
- Local paths are dev/custom mode.
- Arbitrary zip/tarball installs are not supported by default.
- Post-install hooks are not allowed by default.
- Installation performs static checks and digest verification.

### Authoring

Phase 3 developer commands (arrive with the signed registry, since `pack`/`init` exist to prepare a wrapper for registry publication):

```bash
phi-wrapper init fastq-qc
phi-wrapper validate .
phi-wrapper test .
phi-wrapper pack .
```

In Phase 1 and Phase 2, a wrapper author edits `wrapper.yaml`/`main.nf` directly and validates by pointing Phi's dev-mode loader at the folder; `manifest.ts`'s parser is the only validation available, exercised through the desktop UI (Phase 1) or the runtime `phi-wrapper validate <id>` command against an installed wrapper (Phase 2) — neither is a dedicated authoring/packaging command.

Wrapper repositories should include:

```text
wrapper.yaml
main.nf
modules/
tests/smoke/
examples/
README.md
CHANGELOG.md
LICENSE
```

Verified publication can initially happen through a registry PR/manual review process.

## Phased Scope

Three phases. Each phase must be individually shippable and useful before the next one starts — Phase 2 is not blocked on imagining Phase 3, and Phase 1 must stand on its own as something an internal user can actually run.

### Phase 1 Scope: Local Core

Prove the wrapper abstraction end-to-end, entirely locally:

- Wrapper manifest parser and validator.
- Namespaced canonical wrapper ids, SemVer versions.
- Simplified two-tier trust model: `bundled` and `custom` (see Core Concepts).
- Run plan and submitted run stores.
- JSON Schema parameter validation.
- Semantic bio input/output types.
- Samplesheet standardization.
- Local path mapping only (no remote paths, no container path variant needed yet if the local profile runs outside a container — container path mapping can wait until a profile actually needs it).
- Local Nextflow executor for real runs (not just smoke tests — Phase 1 IS the local runtime, not a stand-in for one).
- Structured logs, outputs, summaries, and audit events.
- Local file preview integration (reuse the existing preview panel; no new remote browsing).
- Wrappers sidebar page (catalog + run history, local-only).
- Agent tools for wrapper search, inspect, and the one bundled demo wrapper, registered through the existing runtime-adapter tool pipeline.
- Chat timeline plan/run cards using the existing pending-action design system.

Explicitly out of Phase 1: any remote connection model, SSH, Slurm, registry signing, GitHub/registry install, CLI.

First demo wrapper:

- `phi/ngs/fastq-qc`
- Nextflow engine.
- FastQC and MultiQC style workflow.
- Small smoke test data.
- Local profile only (`resourceClass: light`).

### Phase 2 Scope: Remote Execution

Adds the remote-first execution model on top of the proven Phase 1 core:

- Remote connection binding at project level.
- SSH remote doctor.
- SSH remote bundle upload.
- Remote detached Nextflow launch.
- Slurm detection and Slurm profile; remote-background fallback when no scheduler exists.
- Remote path mapping and container path variants.
- Run status reconciliation without a remote daemon.
- Remote file browsing / preview over SSH.
- `phi-wrapper` CLI thin shell over the same core.
- Remote-first executor/profile resolver (see Execution Policy).

### Phase 3 Scope: Trust & Registry

Adds the parts of the original design that only pay off once there is more than one wrapper author:

- Git-backed signed registry, bootstrap snapshot, digest verification.
- Full trust tier model (`official_verified`, `community_verified`, `organization_verified`, `compatible`, `blocked`).
- GitHub install source.
- Private organization registry UI and key management.
- Wrapper authoring CLI (`init`, `pack`) for third-party authors.
- Richer remote/HPC scheduler adapters, remote resource manager.
- More verified wrappers, Snakemake engine support if demand warrants it.
- Validated wrapper composition, Seqera/Tower adapter.
- Lightweight remote daemon only if SSH polling proves insufficient.

## Success Criteria

### Phase 1 (must work with zero remote/network setup)

A user can:

- Open the Wrappers page and see the bundled `fastq-qc` wrapper with manifest, inputs, and profile detail.
- Ask the agent to prepare a FASTQ QC wrapper plan; the agent creates a plan, not a submitted run.
- Review the plan card in the chat timeline: inputs, samplesheet preview, output directory, resources, command plan.
- Submit the plan and watch a real local Nextflow run execute.
- See the run in both the chat timeline and the Wrappers page run history, across an app restart.
- Preview the primary MultiQC report in the local file preview panel.
- Export reproducibility metadata for the run (manifest snapshot, params, digests, command plan).
- Point Phi at a local custom wrapper folder and have it show up as `custom`, not a default agent tool.

### Phase 2 (adds remote)

- Configure a project with a remote server and remote root.
- Submit the same plan to a remote connection; remote-first resolver picks Slurm or remote-background.
- Keep the remote run alive after local disconnect; reopen Phi and reconcile run status.
- Open the remote output directory in the right-side file browser; preview the primary report over SSH.
- Download selected outputs only after explicit choice.
- Run the same flow from the `phi-wrapper` CLI.

### Phase 3 (adds trust/registry)

- Install a wrapper from `registry:` or `github:` source and see it resolve to a verified trust tier only when the registry digest matches.
- A blocked wrapper version cannot be selected by default.
