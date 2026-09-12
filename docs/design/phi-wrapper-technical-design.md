# Phi Wrapper Technical Design

Date: 2026-09-09

This document defines the technical shape of Phi Wrapper after the clarification sequence. The design's long-term target is remote-first, Nextflow-first, verified-by-default, and compatible with the current Phi desktop architecture. Delivery is phased (see the PRD's [Phased Scope](./phi-wrapper-product-prd.md#phased-scope)): Phase 1 builds only the local-only slice of everything below — this document still specifies the full target shape (types, manifest fields, storage layout, trust tiers) so Phase 1 code doesn't need breaking changes later, but each section calls out what Phase 1 actually implements versus what is deferred to Phase 2 (remote execution) or Phase 3 (registry/signing/trust).

### Integration With The Existing Runtime (Confirmed By Milestone P1.0)

**This section replaces an earlier draft that assumed wrapper tools would register through `runtime-adapter.ts`'s `InlineExtension`/`extensionFactories` mechanism, the same path [`resources.ts`](../../src/main/agent/resources.ts) and [`plugins.ts`](../../src/main/agent/plugins.ts) use. That assumption was wrong, and Milestone P1.0 (source-level investigation, not yet a live end-to-end run — see implementation plan) exists specifically because it was wrong. The correct integration point, confirmed by reading the vendored `@oh-my-pi/pi-coding-agent` SDK source, is different and is described below.**

`InlineExtension` / `extensionFactories` (`runtime-adapter.ts`) is an approval-interception hook, not a tool-registration mechanism. Concretely: `collectToolCallHandlers()` in `runtime-adapter.ts` registers handlers for a `'tool_call'` event that fires when the agent is *about to run an already-existing tool* (built-in tools like `bash`/`write`/`edit` — see [`tool-approval.ts`](../../src/main/agent/tool-approval.ts)'s `RISKY_TOOLS` set), and the handler's return value can only approve/block that call. This is confirmed by `omp-sdk-worker.ts`'s `createSession()`, which passes `extensionFactories: record.enableToolApproval ? [createBridgeToolApprovalExtension(sessionId)] : undefined` into `DefaultResourceLoader` — the whole mechanism exists to gate the existing tool-approval UI, not to add new tools with new JSON schemas that the LLM can see and call.

The actual mechanism for adding a brand-new, schema-carrying, LLM-callable tool is the underlying SDK's `customTools: (CustomTool | ToolDefinition)[]` option on `CreateAgentSessionOptions` (defined in the SDK's `sdk.ts`, re-exported through `extensibility/legacy-pi-coding-agent-shim.ts`, which is what `omp-sdk-worker.ts` actually calls as `createLegacyAgentSession`). Confirmed by reading the source directly:

- `sdk.ts` reads `options.customTools` and merges it into the active tool set (`allCustomTools`) independently of the file-based `.omp/tools/`-style custom tool discovery — this is exactly the in-process registration path Phi Wrapper needs, since wrapper tools must be generated dynamically from installed manifests, not authored as static files on disk.
- The legacy shim's `createAgentSession()` (what `omp-sdk-worker.ts` calls) spreads all of `options` (minus `resourceLoader`) into the object it forwards to the real SDK call, so `customTools` passes through untouched — no shim-side change is needed to make this flow through, only a Phi-side change to actually supply it.
- A `CustomTool` (defined in `extensibility/custom-tools/types.ts`) has exactly the shape Phi Wrapper needs: `name`, `description`, `parameters` (a schema — the manifest's JSON Schema can be adapted to it), and an `execute(toolCallId, params, onUpdate, ctx, signal)` closure that runs with real session context and can do arbitrary Node work (filesystem, `child_process` for local Nextflow, etc.).

Concrete integration point: `omp-sdk-worker.ts`'s `createSession()` (around the `createLegacyAgentSession({...})` call) gets one more field, `customTools: buildWrapperCustomTools(...)`, where `buildWrapperCustomTools` is a new function — living in `omp-sdk-worker.ts` itself or a module it imports, **not** in `runtime-adapter.ts` — that constructs `wrapper.search`, `wrapper.inspect`, and per-wrapper `wrapper.<id>` tools by importing Phi's own `src/main/agent/wrappers/*` runtime modules directly. This works because `omp-sdk-worker.ts` is Phi's own source file, run as a `bun`-spawned child process (see `omp-bridge.ts`'s `spawn('bun', [workerPath], ...)`) — it is not a black-box vendored binary, so it can `import` sibling TypeScript modules from this repo the same way it already imports `PluginManager` and other local code. The wrapper store lives under `~/.phi/wrappers` on disk, which any process on the same machine can read/write, so there is no need to proxy tool execution back across the IPC boundary to Phi's Electron main process — the custom tool's `execute()` can call wrapper runtime functions directly, in-process, inside the worker.

### Plan/Run UI Is Not A New Pending-Action Type (Corrected)

The earlier draft proposed `type PendingAction = ToolApprovalRequest | WrapperRunRequest | RemoteConnectionRequest`, reusing the tool-approval pending-action plumbing for wrapper plan cards. Investigation for Milestone P1.0 found this unnecessary and a poor fit: `tool-approval.ts`'s pending-action flow is a synchronous, same-turn gate ("should this one tool call, about to run right now, be allowed?"), and the SDK does have its own analogous mechanism for custom tools (`CustomToolAPI.pushPendingAction` / `deferrable: true` / a hidden "resolve" tool the agent calls) — but nothing in Phi's existing Electron codebase uses that mechanism today (confirmed: no references to `pushPendingAction`, `deferrable`, or a resolve-tool pattern anywhere under `src/main`, `src/renderer`, `src/preload`), and it does not fit Phi Wrapper's requirement that a plan can be reviewed and submitted long after the agent turn that created it, even after an app restart.

Instead, follow the pattern Phi already uses for other durable, restart-surviving domain objects (installed plugins, projects): a plain main-process store plus a plain preload/IPC surface, independent of the agent tool-call loop.

- The `wrapper.<id>` custom tool's `execute()` creates and persists a `WrapperRunPlan` (via `wrappers/plans.ts`) and returns a small tool result to the LLM (plan id + one-line summary) — it does not push a pending action into the SDK's approval system.
- The custom tool's `execute()` (or an `onUpdate` call) also emits a structured session event (already part of `AgentSessionEvent`'s open `{ type: string } & Record<string, unknown>` shape) carrying the new plan's id. Phi's existing `bridge.onSessionEvent` forwarding (already wired in `RuntimeAgentSessionProxy`) delivers this to the renderer like any other session event; `session-events.ts` and `ChatView.tsx` turn a `wrapper_plan_created` event into a `WrapperPlanItem` in the timeline, which then loads full plan detail from the wrapper store by id (as already described under Chat And UI Integration below) rather than carrying the payload inline.
- The **Validate / Submit / Cancel** buttons on the resulting `WrapperPlanCard` are ordinary Electron IPC calls — preload exposes something like `window.api.wrappers.submitPlan(planId)` straight to a main-process handler in `wrappers/plans.ts` / `wrappers/runs.ts` — exactly like how installing a plugin ([`plugins.ts`](../../src/main/agent/plugins.ts)) is a plain async function called from the Plugins page, not something gated by the agent's tool-approval loop. This is simpler than threading plan submission back through the agent, and it is what actually satisfies "a run survives chat context changes and app restarts": the action is decoupled from any live agent session.

This still uses the same **design language** as `ToolApprovalRequest` cards (compact rows, chips, expandable sections — see UX Model in the PRD) for visual consistency, but it is not the same typed plumbing underneath. Do not add `WrapperRunRequest` to a shared `PendingAction` union; it doesn't need one.

## Architecture

Phi Wrapper has three entry points over one core runtime:

```text
Phi desktop UI
  -> typed IPC
  -> phi-wrapper core

Agent tools
  -> generated wrapper tools
  -> phi-wrapper core

phi-wrapper CLI
  -> phi-wrapper core
```

Phase 1 (and Phase 2/3, until there's real reason to extract) should keep the core inside the current app structure:

```text
src/main/agent/wrappers/
  types.ts
  manifest.ts
  registry.ts
  install.ts
  plans.ts
  runs.ts
  path-mapping.ts
  executor-nextflow.ts
  executor-remote.ts
  doctor.ts
  audit.ts
```

The module boundary should stay clean enough to extract later into:

```text
packages/phi-wrapper-core/
packages/phi-wrapper-cli/
```

Do not start Phase 1 by converting the repo into a monorepo.

## Storage

Wrapper data lives independently from plugins. Full target layout:

```text
~/.phi/
  wrappers/
    registry/               # Phase 3
      index.json
      snapshots/
      signatures/
    installed/              # Phase 1
      <namespace>/<wrapper>/<version>/
        wrapper.yaml
        main.nf
        modules/
        tests/
        examples/
    plans/                  # Phase 1
      <planId>/
        plan.json
        params.json
        command-plan.json
        input-preview.json
        validation.json
    runs/                   # Phase 1 (remote.snapshot.json etc. arrive Phase 2)
      <runId>/
        status.json
        events.jsonl
        audit.jsonl
        manifest.snapshot.yaml
        registry.snapshot.json
        params.json
        command-plan.json
        outputs.json
        summary.json
        logs/
        work/
  resources/
  remotes/                  # Phase 2
    connections.json
```

Phase 1 only creates `installed/`, `plans/`, and `runs/`. `installed/` holds both the app-bundled demo wrapper (written at first run/update, not user-installed) and any `custom` dev-mode wrappers the user points at — there is no `registry/` directory until Phase 3 introduces a real registry to snapshot. `registry.snapshot.json` inside a run record is Phase 1-writable as a fixed, hardcoded snapshot (the bundled wrapper's own metadata) rather than a real registry query result; its shape should already match what Phase 3 will produce.

Project state stores references, not wrapper definitions. Full target shape (Phase 2 fields marked):

```json
{
  "projectId": "project_...",
  "defaultRemoteConnectionId": "lab-hpc",       // Phase 2
  "remoteWorkspaceRoot": "/data/lab/project-a", // Phase 2
  "wrapperDefaults": {
    "phi/ngs/fastq-qc": {
      "version": "1.0.0",
      "executor": "remote:lab-hpc",             // Phase 1 value is always "local"
      "profile": "slurm",                       // Phase 2
      "params": {
        "threads": 16
      },
      "resources": {
        "cpus": 16,
        "memory": "32 GB"
      }
    }
  }
}
```

Phase 1 writes `wrapperDefaults` (version/params/resources) but omits `defaultRemoteConnectionId`, `remoteWorkspaceRoot`, and any non-`local` `executor`/`profile` value — the fields exist in the type from the start so the project-state schema doesn't change shape in Phase 2, they're just unpopulated.

## Wrapper Identity

Wrappers use namespaced canonical ids:

```text
canonicalId: phi/ngs/fastq-qc
namespace: phi/ngs
shortId: fastq-qc
```

Rules:

- Registry canonical ids are unique.
- Short ids are UX aliases only.
- CLI may accept a short id when it resolves to one wrapper.
- Conflict resolution must prompt or fail.
- Run records always store canonical id.
- Agent tools use a safe generated name such as `wrapper.phi_ngs_fastq_qc`.

Versions use SemVer:

```text
1.0.0
1.1.0-beta.1
2.0.0-rc.1
```

Run identity is exact:

```text
canonicalId + version + source ref + commit + digests
```

No run resolves `latest` at execution time.

## Manifest

Author-facing manifest uses YAML:

```text
wrapper.yaml
```

Runtime state uses JSON/JSONL. Verification uses a canonicalized manifest digest, not raw YAML text.

Minimal manifest shape:

```yaml
phiWrapperVersion: 1
id: phi/ngs/fastq-qc
shortId: fastq-qc
name: FASTQ QC
version: 1.0.0
summary: Run FASTQ quality control and produce a report.

runtime:
  minVersion: 1.0.0
  maxVersion: 1.x

source:
  repository: https://github.com/phi-wrappers/ngs-fastq-qc
  ref: v1.0.0
  commit: abc123

verification:
  status: official_verified
  registry: phi
  manifestDigest: sha256:...
  workflowDigest: sha256:...
  environmentDigest: sha256:...

registryStatus: active
resourceClass: standard

engine:
  type: nextflow
  entrypoint: main.nf
  profiles:
    - id: local
      executor: local
    - id: docker
      executor: local
      containerRuntime: docker
    - id: slurm
      executor: remote
      scheduler: slurm
      controller: detached_ssh
    - id: slurm-controller
      executor: remote
      scheduler: slurm
      controller: sbatch
    - id: remote-background
      executor: remote
      scheduler: none
      controller: detached_ssh

# Optional. Declares the workflow's DAG for the structure/live-state diagram
# (see "Workflow Structure And Live Run State" below). `id` must match the
# Nextflow process name so live weblog events can be attributed to a step.
# Omit entirely for a wrapper that doesn't want a detailed diagram — the UI
# falls back to a trivial inputs → wrapper → outputs graph.
steps:
  - id: fastqc
    label: FastQC
    dependsOn: []
  - id: multiqc
    label: MultiQC
    dependsOn: [fastqc]

environment:
  default: apptainer
  options:
    - kind: container
      runtime: docker
      image: ghcr.io/phi-wrappers/fastq-qc:1.0.0
      digest: sha256:...
    - kind: container
      runtime: apptainer
      image: oras://ghcr.io/phi-wrappers/fastq-qc:1.0.0
      digest: sha256:...
    - kind: conda
      file: environment.yml
      lock: conda-lock.yml
      digest: sha256:...

inputs:
  - id: reads
    type: fastq_reads
    layout: paired_end
    required: true
    samplesheet:
      columns:
        - sample
        - fastq_1
        - fastq_2

parameters:
  schema:
    type: object
    required:
      - reads
    properties:
      reads:
        type: string
        format: path-glob-or-samplesheet
      threads:
        type: integer
        default: 4
        minimum: 1
        maximum: 64

outputs:
  - id: report
    label: MultiQC report
    type: html
    path: results/multiqc_report.html
    primary: true
  - id: metrics
    label: QC metrics
    type: table
    path: results/multiqc_data/multiqc_general_stats.txt

summaries:
  - id: qc_metrics
    fromOutput: metrics
    kind: table
    maxRows: 50

resources:
  defaults:
    cpus: 4
    memory: 8 GB
    time: 2h
  references: []

permissions:
  filesystem:
    read:
      - input_paths
      - reference_resources
    write:
      - run_workdir
      - declared_outdir
  network:
    default: disabled
    allowedDomains: []
  remote:
    allowed: true

tests:
  smoke:
    params: tests/smoke/params.yaml
    expected:
      - path: results/multiqc_report.html
        exists: true

license:
  wrapper: MIT
  tools:
    - name: FastQC
      license: GPL-3.0

citations:
  - id: multiqc
    doi: 10.1093/bioinformatics/btw354

dataPolicy:
  acceptedSensitivity:
    - public
    - internal
    - human_subject
    - clinical
  externalTransfer:
    default: false
```

## Input And Output Types

Parameters use JSON Schema. Inputs and outputs add domain semantics.

Example semantic types:

- `fastq_reads`
- `bam`
- `cram`
- `vcf`
- `gvcf`
- `count_matrix`
- `single_cell_matrix`
- `reference_genome`
- `gene_annotation`
- `peak_set`
- `bed`
- `fasta`
- `proteome_fasta`
- `mzml`

FASTQ inputs should standardize on samplesheets. Glob input is a convenience layer that runtime resolves into a samplesheet. The generated samplesheet is persisted in the plan/run directory.

Output declarations are mandatory. Runtime writes `outputs.json` after completion:

```json
{
  "runId": "wrun_...",
  "outputs": [
    {
      "id": "report",
      "path": "/data/project/results/phi-wrapper/fastq-qc/run/results/multiqc_report.html",
      "exists": true,
      "bytes": 421337,
      "primary": true,
      "location": "remote",
      "connectionId": "lab-hpc"
    }
  ]
}
```

Undeclared files can be browsed in the file tree but are not default agent inputs.

## Trust And Registry

This whole section is Phase 3 target design. Phase 1 has no registry at all: trust tier is derived purely from which `installed/` subtree a wrapper's manifest was loaded from — `installed/<namespace>/<wrapper>/<version>/` written by the app itself at build/first-run time is `bundled`; anything loaded via a dev-mode local-path pointer is `custom`. A manifest's own `verification:` block (see Manifest) is never trusted as a self-report in any phase — it is informational only, and Phase 1 code should not read it to decide trust tier at all. This matters: don't let a Phase 1 implementation shortcut by trusting `verification.status: official_verified` written inside the YAML itself, since that would make trust trivially forgeable by anyone who edits a manifest — the actual trust decision has to come from *how the wrapper got onto disk* (bundled by the app vs. pointed at by the user), never from a claim inside the file.

Phase 3: registry is Git-backed and signed. Phi may ship a bootstrap snapshot for offline catalog display.

Registry entry records:

- Canonical id.
- Version.
- Source repository and ref.
- Resolved commit.
- Manifest digest.
- Workflow digest.
- Environment digest.
- Smoke test result.
- Registry signer.
- Lifecycle status: `active`, `deprecated`, `retired`, or `blocked`.

Verification status is not inferred from GitHub alone. A valid GitHub repository can be `compatible`, but it is not `verified` until a trusted registry entry and digest checks match.

Install rules:

- No arbitrary post-install hooks by default.
- No `curl | bash`.
- No install-time project writes.
- No hidden setup scripts.
- Container pulls and reference provisioning require explicit policy or confirmation.

## Plan State

Wrapper plans are persisted objects.

States:

```text
draft
validating
valid
invalid
expired
submitted
cancelled
```

Plan revisions:

- Same wrapper/version/executor/source with parameter changes creates a new revision.
- Changing wrapper id, version, source, trust tier, or executor creates a new plan.
- Submit always targets a specific valid plan revision.
- Plans have TTL and become stale when wrapper, registry, project defaults, or remote bindings change.

## Run State

Runs are durable objects independent from chat messages.

States:

```text
created
validating
provisioning
queued
running
collecting
completed
failed
cancelling
cancelled
lost
```

`queued` means executor or scheduler queue state. V1 does not maintain a local Phi submission queue.

Run ids are machine-generated. Run names are optional:

```text
runId: wrun_...
runName: tumor-rnaseq-qc
outDir: results/phi-wrapper/fastq-qc/2026-09-09-tumor-rnaseq-qc-a1b2c3/
```

New runs use unique output directories by default. Overwrite requires explicit confirmation and is never added automatically by the agent.

## Execution Model

Workflow code is fixed. Phi Wrapper does not generate Nextflow DSL dynamically.

For Nextflow, runtime generates:

- `params.json`
- `nextflow.config`
- command plan
- launch script

Then it runs the verified entrypoint:

```bash
nextflow run wrapper/main.nf -params-file params.json -profile <profile>
```

V1 supports `engine.type = nextflow` only. Manifest can reserve future values such as `snakemake`, `cwl`, or `wdl`, but runtime must reject unsupported engines.

nf-core pipelines can be wrapped, but an nf-core pipeline is not automatically a Phi verified wrapper. A Phi wrapper adapter must fix inputs, outputs, params, source revision, environment, and verification metadata.

## Executor Model

Executors:

```text
local               # Phase 1
remote-background   # Phase 2
slurm               # Phase 2
slurm-controller    # Phase 2
```

Phase 1 implements `local` as the real, primary way runs execute — not a fallback or a smoke-test-only stub. The `executor` field on a plan/run should still be typed as the full union above from the start so Phase 2 doesn't need a migration, but Phase 1 code paths only ever produce/consume `local`.

Phase 2 remote execution flow:

```text
verify local installed wrapper
create execution bundle
create remoteRunDir
upload bundle + params + config + launch script
run remote validate
submit detached job
record remote metadata
poll by SSH/scheduler
collect outputs metadata
```

Remote run directory:

```text
<remotePhiRoot>/wrappers/runs/<runId>/
  wrapper/
  params.json
  nextflow.config
  launch.sh
  status.json
  events.jsonl
  logs/
```

No input data is uploaded by default.

### Slurm

Default Slurm profile:

```text
controller: detached_ssh
nextflow executor: slurm
```

The remote detached controller starts Nextflow, and Nextflow submits process jobs to Slurm.

Advanced profile:

```text
controller: sbatch
nextflow executor: slurm
```

This is named `slurm-controller` and is used when login nodes cannot host a detached controller process.

### Remote Background

When no scheduler is available, Phi starts a detached launch script:

```bash
setsid bash launch.sh > logs/stdout.log 2> logs/stderr.log &
```

The script writes:

- `pid`
- `status.json`
- `events.jsonl`
- exit code

Local disconnect must not kill the remote process.

## Monitoring And Recovery

V1 does not require a remote daemon.

Monitoring uses:

- SSH polling.
- `squeue`/`sacct` for Slurm.
- `ps` and status files for remote-background.
- Nextflow logs, trace, timeline, and report files.

If the app closes or the network disconnects, the remote job keeps running. On reconnect, Phi reconciles status from run metadata and remote state.

If state cannot be confirmed, mark the run `lost`, not `failed`.

## Cancellation

Cancellation is executor-specific and does not delete work or outputs.

- Local: terminate process group or Nextflow controller.
- Remote-background: SSH kill process group using recorded pid.
- Slurm: `scancel` relevant jobs.
- Slurm controller: cancel controller job and clean child jobs where possible.

Cancellation states:

```text
running -> cancelling -> cancelled
running -> cancelling -> failed
running -> lost
```

## Resources

Wrapper resources are policy checked before submission.

Global/project policy supports:

- Max concurrent wrapper runs.
- Max local CPU/memory/time.
- Max remote CPU/memory/time.
- Confirmation thresholds.
- Queue or partition defaults.

Phi does not maintain a local auto-submit queue in V1. If policy blocks submission, the plan stays valid but unsubmitted.

Large reference genomes, indexes, databases, and model weights belong to Phi Resource Manager, not wrapper definitions. Wrappers declare requirements; resource resolution returns concrete local or remote paths.

V1 may only check and report resource availability. Automatic remote provisioning of containers or references requires explicit confirmation or policy.

## Path Mapping

Runtime owns path normalization and executor mapping.

Inputs can be:

- Project-relative path.
- Absolute local path.
- Glob.
- Samplesheet.
- Remote path.

Runtime resolves:

```json
{
  "reads": {
    "kind": "samplesheet",
    "userValue": "data/*_{R1,R2}.fastq.gz",
    "localPaths": ["/Users/me/project/data/S1_R1.fastq.gz"],
    "remotePaths": ["/data/lab/project/data/S1_R1.fastq.gz"],
    "containerPaths": ["/mnt/project/data/S1_R1.fastq.gz"]
  }
}
```

Wrappers do not consume host-specific paths directly.

## Network, Secrets, And Data Policy

Wrapper runs are offline by default.

Network access must be declared:

- Domain.
- Reason.
- Phase.
- Policy requirement.

Secrets are not ordinary params. If required, they are Phi secret references:

```text
secret://provider/resource-name
```

Secret values are never written to manifest, params, logs, command snapshots, or audit events.

Data sensitivity metadata is recorded but V1 does not claim automatic compliance.

## Audit And Reproducibility

Every plan and run appends structured audit events:

- Plan requested.
- Actor: user or agent.
- Validation result.
- Confirmation decision.
- Command digest.
- Submit event.
- Remote job id.
- Status transitions.
- Cancel request.
- Retry/rerun relation.
- Output collection.
- Download action.

Every run can export reproducibility metadata:

- Manifest snapshot.
- Registry snapshot.
- Wrapper source ref and commit.
- Workflow digest.
- Environment digest.
- Params.
- Input metadata.
- Resource versions and digests.
- Executor profile.
- Command plan.
- Nextflow version.
- Container runtime version.
- Outputs.
- Events and audit logs.

Large input files are not bundled by default.

## Agent Tool Registration

Agent-facing tools:

```text
wrapper.search
wrapper.inspect
wrapper.<snake_case_id>
```

Default registration:

- Always include search and inspect.
- Include only top-N context-relevant trusted verified wrappers.
- Do not include all installed wrappers.
- Do not include compatible/custom wrappers unless the user explicitly allows them.

Specific wrapper tools use schema generated from the manifest JSON Schema. Internal execution uses one shared runtime path.

The agent creates run plans by default. Actual submission requires policy or user confirmation.

## Chat And UI Integration

Add structured timeline items rather than plain text:

```ts
type ChatItem = ExistingChatItem | WrapperPlanItem | WrapperRunItem
```

Plan and run cards reference ids and load detail from the wrapper store. Large metadata stays out of messages.

**Correction from Milestone P1.0** (see "Plan/Run UI Is Not A New Pending-Action Type" above): do not add a `WrapperRunRequest` to a shared `PendingAction` union alongside `ToolApprovalRequest`. Wrapper plan/run cards are not an approval gate on an about-to-run tool call — they are a view onto a durable, independently-stored `WrapperRunPlan`/`WrapperRun` object, and their action buttons (validate/submit/cancel) call plain IPC methods on the main process, not the agent's tool-approval flow. Reuse the *visual* design language of `ToolApprovalRequest` cards (compact rows, chips, expandable sections), not its type or its approval plumbing.

### Workflow Structure And Live Run State (react-flow)

Both the chat plan card and the Wrappers sidebar detail view show the wrapper as a small workflow diagram, not just a text summary — using [`@xyflow/react`](https://reactflow.dev) (the current package name for what was `react-flow-renderer`; a `ReactFlowProvider` + `<ReactFlow nodes edges />` pair, styled to match Phi's theme rather than the library's defaults). There are two views sharing the same layout, differing only in node state:

- **Structure (plan-time)**: shows the wrapper's declared steps and how inputs/outputs connect to them, before anything has run. Source: a new optional `steps` array on the manifest (see Manifest section below). If a wrapper doesn't declare `steps` (an older or minimal manifest), fall back to a trivial 3-node graph: `inputs → <wrapper name> → outputs`, so there is always something to render, never a blank panel.
- **Live state (run-time)**: the same node/edge layout, but each step node is colored/labeled by state (`pending` / `running` / `completed` / `failed`) as the run progresses, plus a run-level state badge. Source: Nextflow's own `-with-weblog <url>` flag, which POSTs a JSON event to a local HTTP endpoint every time a process/task starts, completes, or fails — this is the actual live-status mechanism, not a parsed-stdout heuristic. Milestone P1.7's local executor starts a short-lived local HTTP listener for this, maps incoming Nextflow process names to the manifest's declared step ids (a wrapper author names steps to match Nextflow process names — see Manifest below), and appends `run_state_changed` events (already part of `WrapperEvent`) carrying the per-step state. The plan/run card and Wrappers sidebar subscribe to those events (the same session-event / IPC channel already used for run status) and re-render the diagram live.
- If per-step live state can't be attributed (a step id with no matching Nextflow process name, or a wrapper that didn't declare `steps` at all), fall back to the run's overall `WrapperRunState` on the single fallback node — degrade gracefully, never show a wrong step as running.
- Read-only: no drag-to-rewire, no editing the graph from the UI. This is a status view, not a workflow editor.

This lands across two milestones, not one: **P1.5** renders the structure view (plan-time, no live state yet — nothing is running at plan-creation time), and **P1.7**/its P1.6 sidebar counterpart wire up the live weblog-driven state once the local executor exists. Don't block P1.5 on P1.7 — a plan card with a static structure diagram and no live state yet is a complete, useful P1.5 deliverable on its own.

## What Phase 2 Needs From Phase 1 (Stability Contract)

Written at the end of Phase 1 (P1.10), grounded in what actually got built, not what
was originally planned — a few things turned out more/less stable than assumed going
in.

**Stable — build on these without expecting a breaking change:**

- `WrapperRunPlan`/`WrapperRun` (`src/shared/wrapperTypes.ts`) already type `executor`
  as the full `'local' | 'remote-background' | 'slurm' | 'slurm-controller'` union and
  `trustTier` as the full Phase 3 union; Phase 1 code only ever produces `'local'`/
  `'bundled'`/`'custom'`. `WrapperInputResolution` already carries optional
  `remotePaths`/`containerPaths` fields, unpopulated in Phase 1. Both types already
  carry `cwd` (added mid-Phase-1 once the local executor needed it to resolve
  `outputDir` to an absolute path) and `steps` (the manifest snapshot the diagram
  renders from). Phase 2 populates more of these fields; it shouldn't need to add new
  required ones to the core plan/run shape.
- `runs.ts`'s `submitWrapperRunPlan` already branches on `run.executor === 'local'`
  before invoking the local executor — this was shaped that way specifically so a
  Phase 2 remote branch is an `else if`, not a rewrite of the submit path itself.
- `executor-local.ts` vs. a future `executor-remote.ts` are already separate modules;
  Phase 2 shouldn't need to touch `executor-local.ts` at all.
- `weblog-listener.ts`'s step-state attribution (`applyWeblogEvent`) only depends on
  `run.runId` + `run.steps` + a Nextflow weblog payload — it doesn't know or care
  whether the process that POSTs to it is local or reached via an SSH tunnel from a
  remote host. If Phase 2's remote executor also drives Nextflow with
  `-with-weblog`, this listener is reusable as-is rather than needing a remote-specific
  reimplementation — worth trying before building something new.
- `tools.ts`'s agent tools call `createWrapperRunPlan({ cwd: ctx.sessionManager
  .getCwd(), ... })` and nothing else about plan creation — the resolver Phase 2 adds
  lives inside `plans.ts`, not in the tool layer, so `tools.ts` shouldn't need changes
  for Phase 2's resolver work.

**Expect to change, not just extend:**

- `plans.ts`'s `buildPlan()` currently hardcodes `executor: 'local'` and a trivial
  `resolveLocalProfileId()` lookup. Phase 2's PRD-described resolver chain (explicit →
  project default → global default → auto resolver) replaces this specific piece of
  internal logic — the function's *output shape* (a `WrapperRunPlan`) doesn't change,
  but its *body* does non-trivially. Don't try to bolt remote resolution onto
  `resolveLocalProfileId` — replace it.
- `ProjectWrapperDefault` (`src/main/agent/projects.ts`) already reserves
  `executor`/`profile` as plain `string` (not narrowed to `WrapperExecutor`) precisely
  so Phase 2 can add remote values without a type change — but `defaultRemoteConnectionId`/
  `remoteWorkspaceRoot` still need adding to `Project` itself; they don't exist yet.
- The `RunLocalWrapperOptions`-style `spawnImpl`/`doctorImpl` injection pattern
  (`executor-local.ts`) proved valuable for testing without the real binary installed —
  worth deliberately repeating for `executor-remote.ts`'s SSH calls, not treated as a
  local-only convenience.

**Confirmed working, but only on this one machine:** the `customTools` agent-tool
integration (P1.0/P1.8) and the `omp-sdk-worker.ts` build-copy plugins were verified
against this repo's actual dev/production build output, not merely reasoned about —
but that verification happened on one developer machine. Re-verify (rebuild, restart,
real session creation) after any upgrade of `@oh-my-pi/pi-coding-agent` or any change
to `electron.vite.config.ts`'s rollup output settings, since both are exactly the kind
of change that silently invalidates the path assumptions baked into
`copyWrapperFixturesPlugin`/`copyWrapperWorkerDepsPlugin`.

## Future Extensions

- Private organization registries.
- Snakemake engine.
- Seqera/Tower adapter.
- Validated composition.
- Remote daemon if SSH polling proves insufficient.
- CWL/WDL adapters only after Nextflow path is stable.
- Rich UI run forms after the plan/card flow is proven.
