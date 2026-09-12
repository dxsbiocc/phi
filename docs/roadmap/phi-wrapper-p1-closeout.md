# Phi Wrapper Phase 1 Closeout

Date: 2026-09-10

Scope: close the "Phi Wrapper Phase 1 (Local Core)" slice — see
[phi-wrapper-product-prd.md](../design/phi-wrapper-product-prd.md)'s Phased Scope and
[phi-wrapper-v1-implementation-plan.md](../design/phi-wrapper-v1-implementation-plan.md)
for the milestone-by-milestone plan this closes out. Status is reported against the
PRD's own Phase 1 success criteria, not against a rewritten checklist, so a reader can
compare this table to the original commitment directly.

| Phase 1 success criterion (PRD) | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Open the Wrappers page and see the bundled `fastq-qc` wrapper with manifest, inputs, and profile detail | Done | `WrapperView.tsx` sidebar + detail pane; `tests/wrapper-view.test.ts` | None |
| Ask the agent to prepare a FASTQ QC wrapper plan; the agent creates a plan, not a submitted run | Done | `tools.ts`'s `wrapper.phi_ngs_fastq_qc` execute tool always creates a plan and never submits; live-confirmed by sending a real `session.create` RPC to the built worker (see P1.8 in the implementation plan) and by `tests/wrapper-tools.test.ts` | A real LLM choosing to call the tool mid-conversation hasn't been watched happen — that's nondeterministic model behavior, not something to script around, and is the natural first thing to try by hand |
| Review the plan card in the chat timeline: inputs, samplesheet preview, output directory, resources, command plan | Done | `WrapperPlanCard.tsx` fetches each input's `<input>.samplesheet.csv` via the new `wrappers:getPlanArtifact` IPC method and renders it as a compact table (capped preview rows, row-count note) alongside the existing input/output/resources/command-plan detail | Not yet manually watched render against a real submitted plan with an actual multi-sample samplesheet — only type-checked, linted, and confirmed the fixture-driven code path is correct |
| Submit the plan and watch a real local Nextflow run execute | Built, not run for real | `executor-local.ts` drives the full state machine against a real child process with injectable `spawnImpl`/`doctorImpl`; all tests use a fake process since **this development machine has no `nextflow` binary installed** (Docker and Java are present) | A genuine local Nextflow execution is Milestone P1.9 — install Nextflow and run the fixture wrapper for real before calling Phase 1 fully proven, not just architecturally sound |
| See the run in both the chat timeline and the Wrappers page run history, across an app restart | Done (by construction) | Runs are written to `~/.phi/wrappers/runs/<runId>/run.json` on every state transition, not held in memory; `WrapperPlanCard` polls `getWrapperRun`, `WrapperView` lists `listWrapperRuns()` | Not yet manually verified against a real in-flight run surviving an actual app restart — blocked on the same P1.9 Nextflow gap above |
| Preview the primary MultiQC report in the local file preview panel | Wired, not yet at file granularity | `WrapperView.tsx`'s "打开输出目录" now resolves `run.outDir` to an absolute path (via `resolveLocalPath`) and calls the app's own `onOpenLocalPath` (threaded from `App.tsx` through the same in-app file preview panel `ChatView.tsx` already uses), instead of `window.api.revealPath()` | Opens the run's output *directory* in Phi's own preview panel, not the primary MultiQC report file directly — jumping straight to the primary output (per `manifest.outputs[].primary`) is a follow-up, not done here |
| Export reproducibility metadata for the run (manifest snapshot, params, digests, command plan) | Done | `reproducibility.ts`'s `buildWrapperReproducibilityBundle()` (run, plan, manifest, events, params/outputs/summary artifacts) behind a new `wrappers:exportReproducibility` IPC handler with a native save dialog and audit log entry, plus an export button (icon + tooltip) on each run row in `WrapperView.tsx`; `tests/wrapper-reproducibility.test.ts` | None |
| Point Phi at a local custom wrapper folder and have it show up as `custom`, not a default agent tool | Done | `catalog.ts`'s `addCustomWrapper`/`listDefaultAgentToolWrappers`; `tests/wrapper-catalog.test.ts`, `tests/wrapper-tools.test.ts` | None |

## What Actually Shipped Beyond The Checklist

- Live per-step run status in the chat plan card (`WrapperFlowDiagram` fed by
  `run.stepStates`, driven by Nextflow's `-with-weblog` events) — this was added
  mid-Phase-1 in response to explicit design direction partway through implementation,
  not part of the original PRD checklist above.
- A real, source-verified correction to how agent tools actually register
  (`customTools` on session creation, not `runtime-adapter.ts`'s approval-interception
  extensions) — see the technical design's "Integration With The Existing Runtime"
  section. The original plan's assumption here was wrong; Milestone P1.0 exists
  specifically because it was wrong, and P1.8's live RPC check confirmed the
  correction, not the original assumption.
- Two real build-system gaps neither `npm test` nor `tsc --noEmit` can catch, found and
  fixed only by actually building and running the app: Rollup silently drops the
  bundled wrapper's `wrapper.yaml` fixture from `out/` (fixed by
  `copyWrapperFixturesPlugin`), and `omp-sdk-worker.ts` runs unbundled, so its new
  `./wrappers/*` imports needed their own copy plugin
  (`copyWrapperWorkerDepsPlugin`) — see both plugins' doc comments in
  `electron.vite.config.ts` for the reasoning, and the "What Phase 2 Needs From Phase
  1" section of the technical design for what to re-check if this ever breaks again.

## Conclusion

Phi Wrapper Phase 1 is **not yet ready to close out** — the three UI/functionality gaps
below have been closed since the table above was first written (samplesheet preview
content, in-app output preview, reproducibility export), but the core "does a real
local Nextflow run actually work" claim is still architecturally sound but unproven on
real Nextflow (Milestone P1.9, blocked on installing it). What Phase 1 *has* proven,
with live verification rather than only unit tests: the wrapper abstraction itself fits
how the agent and chat UI want to use it, and the riskiest technical unknown
(agent-tool registration) works exactly as corrected in P1.0.

The three UI gaps were closed by: reading and rendering the generated samplesheet CSV
in the plan card, routing "打开输出目录" through the app's own in-app file preview panel
instead of the OS file manager, and adding a reproducibility-export IPC action + button.
All three are type-checked, linted, and covered by tests (`tests/wrapper-view.test.ts`,
`tests/wrapper-reproducibility.test.ts`); the app was rebuilt and started cleanly with
the bundled wrapper installing successfully, but a hands-on visual pass against a real
submitted plan and run (not just fixture data) hasn't happened yet in this session.

Recommended next steps, in order: (1) a hands-on visual/functional pass over the three
gaps just closed, against a real submitted plan, (2) install Nextflow and run Milestone
P1.9's manual loop for real, then (3) revisit this closeout table before starting
Phase 2 (Remote Execution).
