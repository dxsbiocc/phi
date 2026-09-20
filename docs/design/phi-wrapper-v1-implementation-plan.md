# Phi Wrapper Implementation Plan

Date: 2026-09-09 (revised 2026-09-10: rephased local-first)

This plan turns the Phi Wrapper PRD and technical design into reviewable implementation stages for the current Phi app. It stays aligned with the internal beta roadmap: prefer durable project/session state, clear approvals, visible resources, bounded outputs, and recoverable history over broad marketplace features.

## Why This Was Rephased

The original plan sequenced local execution as a fallback inside a remote-first V1 that also built registry signing, SSH, and Slurm support in one pass. That bundles the riskiest, least-proven part of this feature — whether the wrapper abstraction (manifest → plan → chat card → execution → outputs) actually fits how the agent and user want to run tools — together with the most infrastructure-heavy part (SSH/Slurm/signed registry), so a mistake in the abstraction wouldn't surface until after paying for all of the plumbing. This revision splits delivery into three phases and moves everything remote- and trust-registry-related out of Phase 1. Phase 1 must produce a real, usable, local-only wrapper flow before Phase 2 (remote) or Phase 3 (registry/signing) start. See the PRD's [Phased Scope](./phi-wrapper-product-prd.md#phased-scope) for the product-level scope split this plan implements.

## Implementation Principles

- Local-first delivery, remote-first product vision: Phase 1 proves the abstraction locally; Phase 2 adds the remote/HPC control plane the product is ultimately meant to provide.
- Plan before submit: agent creates a persisted `WrapperRunPlan`; submission is a separate step, in every phase.
- Nextflow-first: fixed Nextflow workflows only, no dynamic workflow generation, in every phase.
- Trust starts simple: Phase 1 uses `bundled`/`custom` only (see PRD); the full signed-registry trust model is Phase 3.
- No automatic large data upload or result download (relevant once Phase 2 adds remote).
- No arbitrary install hooks, in every phase.
- De-risk the biggest unknown first: Milestone P1.0 confirmed agent-tool registration goes through `customTools` on `omp-sdk-worker.ts`'s session creation, not through `runtime-adapter.ts`'s `InlineExtension` pipeline as originally assumed — build P1.8 on the confirmed mechanism.
- Keep changes small and testable.
- Put wrapper core under `src/main/agent/wrappers/` with an extraction-friendly boundary (`packages/phi-wrapper-core/` later, not now).

## Milestone W0: Design Baseline

Status: this document set.

Deliverables:

- Product PRD.
- Technical design.
- This implementation plan (revised, phased).

Verification:

- Docs committed with no whitespace errors.
- Links from future roadmap or decisions can point at these files.

---

# Phase 1: Local Core

Goal: a user can ask the agent to prepare and run a real local Nextflow wrapper, see the plan and run in the chat timeline and the Wrappers sidebar, and preview the output — with zero remote/network setup. See PRD Phase 1 success criteria.

## Milestone P1.0: Runtime Integration Spike — DONE (source-level; live run still pending)

Goal: de-risk the one true unknown before committing to the rest of the plan — does registering a dynamic, manifest-generated tool through the existing agent runtime actually work the way the technical design assumed?

Status: the original assumption (wrapper tools register through `runtime-adapter.ts`'s `InlineExtension`/`extensionFactories`, the same path as `resources.ts`/`plugins.ts`) was **wrong**, and investigating the vendored `@oh-my-pi/pi-coding-agent` SDK source found the actual mechanism. See the technical design's "Integration With The Existing Runtime (Confirmed By Milestone P1.0)" and "Plan/Run UI Is Not A New Pending-Action Type" sections for the full writeup. Summary:

- New LLM-callable tools go through `CreateAgentSessionOptions.customTools: (CustomTool | ToolDefinition)[]` (defined in the SDK's `sdk.ts`), not `extensionFactories`. `extensionFactories`/`'tool_call'` is an approval-interception hook for _existing_ tools (confirmed via `omp-sdk-worker.ts`'s `enableToolApproval` branch and `tool-approval.ts`'s `RISKY_TOOLS`), unrelated to defining a new tool schema.
- The legacy shim `createAgentSession()` (what `omp-sdk-worker.ts` actually calls as `createLegacyAgentSession`) forwards `customTools` through untouched via its `...rest` spread — confirmed by reading `legacy-pi-coding-agent-shim.ts` directly. No SDK-side change needed, only a Phi-side one.
- Concrete integration point: `omp-sdk-worker.ts`'s `createSession()` function needs a new `customTools: buildWrapperCustomTools(...)` field passed into its `createLegacyAgentSession({...})` call. `buildWrapperCustomTools` should live in (or be imported by) `omp-sdk-worker.ts` itself, since that file is Phi's own source, runs as a `bun`-spawned child process, and can import `src/main/agent/wrappers/*` directly — no IPC serialization of tool closures is needed, since the worker process can read/write `~/.phi/wrappers` on disk itself.
- The pending-action/approval side of the plan was also wrong: there is no need for a `WrapperRunRequest` in a shared `PendingAction` union. Wrapper plan cards use a plain main-process store + plain IPC (validate/submit/cancel call ordinary preload-exposed functions), the same pattern already used for plugins/projects — not the agent's tool-approval loop, and not the SDK's own `pushPendingAction`/`deferrable` mechanism (confirmed unused anywhere in Phi's existing `src/main`/`src/renderer`/`src/preload`).

What's still open: this was verified by reading source (sdk.ts, legacy-pi-coding-agent-shim.ts, omp-sdk-worker.ts, tool-approval.ts) and confirming the exact call chain, not yet by running a real chat turn end-to-end against a live model — that requires a running Phi app with real model credentials, which isn't available in a plain coding session. Treat the wiring in P1.8 as the live confirmation: if `buildWrapperCustomTools` doesn't work as described once wired into `omp-sdk-worker.ts` and exercised through the real app, stop and re-open this milestone rather than pushing forward on a broken assumption a second time.

Acceptance (revised to match what's actually verifiable without a running app):

- Technical design's Agent Tool Registration and Chat And UI Integration sections are corrected to match the confirmed mechanism (done).
- The concrete Phi-side integration point (`omp-sdk-worker.ts`'s `createSession()`) is identified precisely enough that P1.8 is a wiring task, not a research task.
- Live confirmation (a real custom tool actually callable from a real chat turn) happens as part of P1.8's manual verification, not as a separate throwaway spike artifact.

## Milestone P1.1: Core Types And Store

Goal: add durable wrapper data models without executing anything.

Files:

```text
src/main/agent/wrappers/types.ts
src/main/agent/wrappers/store.ts
src/main/agent/wrappers/audit.ts
src/renderer/src/types.ts
tests/wrappers-store.test.ts
```

Deliverables:

- Types for wrapper identity, trust tier (full Phase 3 union, but Phase 1 code only ever produces `bundled`/`custom`), plan state, run state, executor (full union, Phase 1 only produces `local`), outputs, audit events.
- Storage helpers under `~/.phi/wrappers` (`installed/`, `plans/`, `runs/` only — no `registry/`, no `remotes/`).
- Append-only `events.jsonl` and `audit.jsonl` helpers.
- Project state extension for `wrapperDefaults` (version/params/resources only; remote fields typed but unused).

Tests:

- Creates wrapper storage directories.
- Persists and reads plan/run metadata.
- Appends events without rewriting previous entries.
- Redacts secrets from audit payloads.

Acceptance:

- No UI yet.
- No Nextflow dependency required.

## Milestone P1.2: Manifest Parser And Validator

Goal: parse wrapper manifests and validate static contracts.

Files:

```text
src/main/agent/wrappers/manifest.ts
src/main/agent/wrappers/schema.ts
tests/wrapper-manifest.test.ts
```

Deliverables:

- YAML manifest parser.
- Canonical manifest digest (computed and stored even though nothing verifies it against a registry yet — Phase 3 needs this to already exist).
- SemVer validation.
- Runtime compatibility check.
- JSON Schema parameter validation surface.
- Semantic input/output validation.
- Smoke test metadata parsing.
- The manifest's own `verification:` block is parsed but never used to decide trust tier (see technical design's Trust And Registry note) — trust tier comes from install location, not manifest content.

Tests:

- Accepts valid `phi/ngs/fastq-qc`.
- Rejects non-SemVer versions.
- Rejects unsupported runtime schema.
- Rejects unsupported engines for execution (only `nextflow` is executable).
- Preserves docs/license/citation metadata.
- A manifest that self-declares `verification.status: official_verified` does not get treated as trusted by anything in this milestone.

Acceptance:

- `engine.type = nextflow` is the only executable engine.

## Milestone P1.3: Bundled And Custom Wrapper Catalog

Goal: show the bundled demo wrapper and support pointing at a local dev wrapper, with no registry.

Files:

```text
src/main/agent/wrappers/catalog.ts
resources/wrappers/phi-ngs-fastq-qc/
tests/wrapper-catalog.test.ts
```

Deliverables:

- Bundled wrapper written to `installed/` at app startup (idempotent, from the fixture shipped with the app).
- Custom wrapper loader: user points Phi at a local folder; it's parsed, validated, and marked `custom`.
- Trust tier resolution: `bundled` (came from the app's own fixture path) vs `custom` (came from a user-provided path). No `compatible`, no `blocked`, no digests-matter-yet logic.
- No GitHub install, no registry install, no post-install hooks — these commands/paths simply don't exist in Phase 1.

Tests:

- `phi/ngs/fastq-qc` resolves as `bundled`.
- A wrapper loaded from an arbitrary local path resolves as `custom`.
- A `custom` wrapper is never returned by the "default agent tools" query.
- Two wrappers with the same canonical id at different versions coexist.

Acceptance:

- `phi/ngs/fastq-qc` appears as an installed, bundled wrapper with no network access required.

## Milestone P1.4: Run Plan Creation And Validation (Local)

Goal: create executable plans against the local executor only.

Files:

```text
src/main/agent/wrappers/plans.ts
src/main/agent/wrappers/path-mapping.ts
src/main/agent/wrappers/samplesheet.ts
src/main/agent/wrappers/policy.ts
tests/wrapper-plans.test.ts
```

Deliverables:

- `createWrapperRunPlan`, always resolving `executor: local` (no resolver chain needed yet — there is exactly one option).
- Plan revisions and TTL.
- `resourceClass: heavy`/`hpc` produces a plan-level warning the user must acknowledge on submit (no remote to redirect to yet — see PRD Execution Policy, Phase 1).
- Local input path mapping only (project-relative, absolute, glob).
- FASTQ glob to samplesheet conversion.
- Input preview summary.
- Local resource policy checks (max concurrent local runs, rough CPU/memory sanity).
- Command plan preview (`nextflow run ... -profile local`).

Tests:

- Plan always resolves to `executor: local`.
- Heavy/hpc wrapper produces the acknowledgment-required warning rather than silently running.
- Glob with zero matches fails.
- Samplesheet is generated and persisted.
- Path mapping rejects missing local inputs.

Acceptance:

- Plans can be valid or invalid.
- No job is submitted in this milestone.

## Milestone P1.5: Chat Timeline Plan Card (Plain IPC, Not A Pending-Action Type) — DONE

Implemented: `WrapperPlanItem` chat item type; `agentEventReducer.ts` renders a `wrapper.*` tool call as a `WrapperPlanItem` (not a generic `ToolCallItem`), extracting `planId` from the tool result's `details: { kind: 'wrapper_plan', planId }` convention (`chatItems.ts`'s `isWrapperToolName`/`extractWrapperPlanId`) rather than a bespoke session-event channel — this reuses the tool-call event pipeline that already exists instead of adding a new one. `WrapperPlanCard.tsx` fetches the plan by id via plain IPC (`getWrapperPlan`/`submitWrapperPlan`/`cancelWrapperRunPlan`, added to preload/main following the existing `listPlugins`-style flat API, not nested under a `wrappers.*` namespace) and renders it with `WrapperFlowDiagram` (`@xyflow/react`) built from `buildWrapperFlowGraph(plan)` — the plan snapshots `wrapperName`/`steps` from the manifest at creation time so the diagram doesn't need a second manifest lookup. `runs.ts` (`submitWrapperRunPlan`/`cancelWrapperRunPlan`/`cancelWrapperRun`) creates/cancels the durable run record; actually driving it to `running`/`completed` is still P1.7. All new code has passing tests (`wrapper-flow.test.ts`, `wrapper-runs.test.ts`, plus additions to `agent-event-reducer.test.ts`, `chatItems.test.ts`, `chat-view.test.ts`); full suite, lint, and typecheck are clean.

Goal: integrate wrapper plans into the chat experience as structured timeline cards — visually in the pending-action design language, but not built on the pending-action type or the agent tool-call loop (see technical design's P1.0 correction).

Files:

```text
src/renderer/src/components/WrapperPlanCard.tsx
src/renderer/src/components/WrapperFlowDiagram.tsx
src/renderer/src/lib/wrapperFlow.ts
src/renderer/src/components/ChatView.tsx
src/renderer/src/lib/chatItems.ts
src/renderer/src/types.ts
src/main/agent/session-events.ts
src/main/index.ts
src/preload/index.ts
src/preload/index.d.ts
tests/chat-view.test.ts
tests/chat-items.test.ts
tests/wrapper-flow.test.ts
```

Deliverables:

- `WrapperPlanItem`, `WrapperRunItem` chat timeline item types (added to the existing `ChatItem` union).
- A `wrapper_plan_created` (and similar) session event type the P1.8 custom tool emits with just the plan id; `session-events.ts`/`ChatView.tsx` turn it into a `WrapperPlanItem` that loads full detail from the wrapper store by id.
- Plain preload/IPC methods for Validate/Submit/Cancel (e.g. `window.api.wrappers.validatePlan/submitPlan/cancelPlan`), calling straight into `wrappers/plans.ts`/`wrappers/runs.ts` in the main process — the same shape as how plugin install/uninstall already works, not a new approval-gated request type.
- Card UI aligned with permission request _design language_: wrapper id/name/version/trust tier, inputs and samplesheet summary, output directory, resource request (with the heavy-workload warning from P1.4 when applicable), command plan summary. No executor/remote-connection row yet (always local).
- `wrapperFlow.ts`: pure function turning a manifest (its optional `steps`, or the trivial inputs→wrapper→outputs fallback) into `@xyflow/react` nodes/edges — no live state yet at this milestone, since nothing has run at plan-creation time. Kept pure/testable independent of the component.
- `WrapperFlowDiagram.tsx`: thin `@xyflow/react` wrapper rendering those nodes/edges, styled to Phi's theme, read-only (no drag-to-rewire). Embedded in the plan card as the structure view. See technical design's "Workflow Structure And Live Run State".
- Compact summary rows, chips, and expandable detail. No nested bordered subgroups. Not the Add popover.

Tests:

- Plan item restores after app restart (reads plan store by id, not from session/message history).
- Valid plan shows an enabled submit action; invalid plan shows a validation error instead.
- Card does not render large metadata directly (loads it by id).
- Submit/cancel IPC calls reach the plan/run store correctly and don't depend on any active agent session.
- `wrapperFlow.ts` produces the declared step graph when `steps` is present, and the 3-node fallback when it's absent.

Acceptance:

- Mock IPC (a session event carrying a plan id) can produce a visible plan card without needing a live custom tool yet — that arrives in P1.8.
- The plan card shows a structure diagram (react-flow) for every wrapper, declared-steps or fallback — never a blank panel.
- Submit is wired to the real local executor once P1.7 lands (can stay disabled until then if sequencing requires it, but don't leave it disabled longer than necessary — Phase 1's whole point is proving the live loop). Live per-step state on the diagram is explicitly out of scope here — that's P1.7.

## Milestone P1.6: Wrappers Sidebar View — DONE

Implemented as a container/presentational split: `WrapperViewContent` (pure, props-driven, same testing convention as `PluginView.tsx`) plus a thin stateful `WrapperView` default export that fetches via `window.api.listWrapperCatalog()`/`listWrapperRuns()` — deliberately self-contained (its own `useEffect`, not routed through App.tsx's central `rendererApi` state) since wrapper data is global, not per-project/cwd-scoped, so it doesn't need App.tsx's cwd-change refresh wiring. Added to the activity bar (`AppView`, nav icon `PhiIcons.nav.wrappers`/`entity.wrapper` using lucide's `Workflow` icon) with minimal App.tsx surgery — no new central state, no new refresh callback threading. "Add custom wrapper" reuses the existing `pickProjectDirectory` directory-picker IPC rather than adding a new dialog. Reuses `WrapperFlowDiagram`/`buildWrapperFlowGraph` from P1.5 for the detail structure diagram. `ensureBundledWrappersInstalled()` now runs at app startup (`app.whenReady()`, wrapped in try/catch + `writeAppLog` — a wrapper install failure must not crash the app). All tests passing (`tests/wrapper-view.test.ts`); full suite/lint/typecheck clean.

Goal: add first-class wrapper browsing and local run history.

Files:

```text
src/renderer/src/components/WrapperView.tsx
src/renderer/src/App.tsx
src/renderer/src/icons.ts
src/main/index.ts
src/preload/index.ts
src/preload/index.d.ts
tests/wrapper-view.test.ts
tests/main-integration.test.ts
```

Deliverables:

- Activity bar `wrappers` view.
- Catalog: bundled + custom, no registry catalog UI.
- Wrapper detail: manifest summary, inputs, params, outputs, env, profiles (local/docker only), trust tier, and the same `WrapperFlowDiagram` structure view from P1.5 (reused, not reimplemented) so the catalog detail page and the chat plan card show the same diagram for the same wrapper.
- Run history (local only); an open run's detail view reuses `WrapperFlowDiagram` too, ready to receive live per-step state once P1.7 starts emitting it.
- Primary output/report link opens the existing local file preview panel — no new remote file tree component.

Tests:

- Wrapper view shows `bundled`/`custom` states distinctly.
- Run history links to detail.
- Empty state (no custom wrappers added yet) is useful and compact.
- Wrapper detail's diagram matches the plan card's diagram for the same manifest (same `wrapperFlow.ts` output).

Acceptance:

- View is useful without any remote infrastructure.

## Milestone P1.7: Local Nextflow Executor — DONE (code + fake-executor tests; real Nextflow run still manual)

Implemented with injectable `spawnImpl`/`doctorImpl` seams (`executor-local.ts`) so the full state machine (`created → provisioning → running → collecting → completed/failed`) is tested against a fake child process, without Nextflow installed — this dev machine has Docker and Java but no `nextflow` binary, confirming the plan's assumption that a real smoke run stays manual (P1.9). `executor-nextflow.ts` builds the fixed launch args/params.json (pure, reusable by a future remote executor). `weblog-listener.ts` starts a real local HTTP server per run, tested with genuine `fetch()` POSTs (not mocked) — matches trace names like `"fastqc (sample1)"` to declared step ids and never fabricates a step state for an unresolved process name. `submitWrapperRunPlan` (`runs.ts`) now fires the local executor in the background after creating the run record (an `autoExecute: false` escape hatch keeps the P1.5 plan/run-record tests from trying to spawn anything). Added `cwd`/`steps` snapshots to both `WrapperRunPlan` and `WrapperRun` (needed to resolve `outputDir` to an absolute path and to attribute weblog events) — additive, not breaking, per the Phase 1/2/3 typing discipline. `WrapperPlanCard.tsx` now polls `getWrapperRun` every 2s once a plan is submitted and feeds `stepStates` into the same `WrapperFlowDiagram`, so the chat card shows live per-step progress, not just a static structure diagram — this closes the "show the running state" requirement directly in chat, not only in the P1.6 sidebar. All new code tested (`wrapper-executor.test.ts`, `wrapper-weblog.test.ts`); 391/391 full suite, lint, typecheck clean.

Goal: submit real local Nextflow runs from validated plans.

Files:

```text
src/main/agent/wrappers/executor-nextflow.ts
src/main/agent/wrappers/executor-local.ts
src/main/agent/wrappers/weblog-listener.ts
src/main/agent/wrappers/doctor.ts
src/main/agent/wrappers/runs.ts
tests/wrapper-executor.test.ts
tests/wrapper-weblog.test.ts
tests/main-integration.test.ts
```

Deliverables:

- `submitWrapperRunPlan` for the local executor.
- Local doctor check (Nextflow present, container runtime present if the chosen profile needs one).
- Status tracking through the run states relevant locally (`created` → `validating` → `provisioning` → `running` → `collecting` → `completed`/`failed`/`cancelled`).
- `weblog-listener.ts`: a short-lived local HTTP listener the executor starts before launching Nextflow, passed to it via `-with-weblog http://127.0.0.1:<port>/weblog`. Translates incoming Nextflow process-start/complete/fail events into per-step state, matched against the manifest's declared `steps[].id` (falls back to the run's overall state when a step id can't be matched — see technical design). Appends `run_state_changed` events (`store.ts`'s `appendWrapperRunEvent`) so the P1.5/P1.6 diagrams update live.
- Cancellation: terminate the local process group / Nextflow controller (and stop the weblog listener).
- Output collection to `outputs.json`, summary extraction to `summary.json`.

Tests:

- Submission creates a `WrapperRun` and marks the plan submitted.
- Fake/mocked Nextflow invocation is required for CI; a real local Nextflow smoke run is manual (P1.9).
- `weblog-listener.ts` maps a fake POSTed Nextflow weblog payload to the correct step id and appends the right run event — testable without real Nextflow, since it's just an HTTP handler.
- An unmatched process name falls back to overall run state, not a fabricated step state.
- Cancel calls the local stop path and does not delete outputs.

Acceptance:

- A real (or faithfully faked) local Nextflow run produces `outputs.json` and `summary.json` matching the manifest's declared outputs.

## Milestone P1.8: Agent Tools (Wires The P1.0 Finding — Live Confirmation Happens Here) — DONE

Implemented and **live-confirmed**, not just unit-tested: sent a real `session.create` RPC directly to the built `out/main/agent/omp-sdk-worker.ts` over stdio (the same protocol `omp-bridge.ts` uses) with `noTools:false`, and it returned `ok:true` with a real session — `customTools` flows through exactly as the P1.0 source reading predicted, with zero crashes or import errors in the actual worker process, not just in the TS-transpile-only unit test loader.

That live check surfaced a real build-system gap the plan hadn't anticipated: `omp-sdk-worker.ts` runs as a **standalone script**, copied verbatim into `out/` and executed directly by `bun` — it is not bundled by rollup like the rest of the main process. Before this milestone, every one of its imports was a Node builtin or an installed package for exactly this reason (confirmed by finding `runtime-paths.ts`'s `getAdditionalProjectResourcePaths`/`getKnownProjectResourceBaseDir` duplicated inline in `omp-sdk-worker.ts` rather than imported). Duplicating the whole `wrappers/` module the same way wasn't viable (real, already-tested logic, not two helper functions), so `electron.vite.config.ts` gained a third copy plugin, `copyWrapperWorkerDepsPlugin`, mirroring `src/main/agent/wrappers/`, `runtime-paths.ts`, and `src/shared/` into `out/` at the same relative paths `bun` needs to resolve them at runtime. **Lesson, extending the one from P1.6/P1.7: a passing `npm test` says nothing about whether a file that isn't bundled by rollup can actually resolve its imports in the real build — always do the live run for any change touching `omp-sdk-worker.ts` specifically, since it's the one file in this codebase exempt from normal bundling.**

`wrappers/tools.ts` builds `wrapper_search`/`wrapper_inspect` (always registered, `approval: 'read'`) and one `wrapper_<id>` execute tool per **bundled** wrapper (`approval: 'write'`, since it creates a plan file) via `buildDefaultWrapperCustomTools()`. An execute tool's `execute()` creates a `WrapperRunPlan` with `actor: 'agent'` and returns `{ details: { kind: 'wrapper_plan', planId } }` — matching the P1.5 convention `chatItems.ts`'s `extractWrapperPlanId` already expects, so the chat card renders correctly with no changes needed on that side. All 7 tests pass without a live SDK session (pure functions plus a minimal `{ sessionManager: { getCwd } }` context stub); full suite (402 tests), lint, and typecheck clean.

What's still open: the live check confirmed session creation accepts `customTools` without error — it did not confirm an LLM actually _chooses_ to call `wrapper.phi_ngs_fastq_qc` mid-conversation (that's nondeterministic model behavior, not something to script around). Manually asking Phi to run FASTQ QC and watching the plan card appear is the natural remaining check, and fits naturally into P1.9's manual verification pass rather than needing its own step.

Goal: expose the bundled wrapper safely to the agent, using the `customTools` mechanism confirmed by P1.0. This milestone IS the live end-to-end confirmation of P1.0's finding — treat a failure here as reopening P1.0, not as a normal bug.

Files:

```text
src/main/agent/wrappers/tools.ts
src/main/agent/omp-sdk-worker.ts
tests/wrapper-tools.test.ts
```

Deliverables:

- `wrappers/tools.ts`: pure functions that build `CustomTool` definitions (`wrapper_search`, `wrapper_inspect`, per-wrapper `wrapper_<id>`) from the catalog/manifest — importable both by `omp-sdk-worker.ts` and by tests, independent of the SDK's process boundary.
- `omp-sdk-worker.ts`'s `createSession()` passes `customTools: buildWrapperCustomTools(...)` into its `createLegacyAgentSession({...})` call (see technical design).
- Generated `wrapper.phi_ngs_fastq_qc` tool (the one bundled wrapper — "top-N" is trivial with a single-wrapper catalog, but the selection logic should already be shaped for more than one).
- `custom` wrappers never register as default agent tools.
- Tool calls create plans by default, not submitted runs; submission goes through the P1.5 plain-IPC card actions, not an agent-side approval gate.

Tests:

- Unit tests on `wrappers/tools.ts` build functions (schema matches manifest, default set includes only the bundled wrapper) — these don't need a live SDK session.
- Default tools include the bundled wrapper only.
- A `custom` wrapper requires explicit user allowance to become a tool.
- Generated schema matches manifest JSON Schema.
- Tool-created plan records actor `agent`.

Acceptance:

- Agent can prepare a `fastq-qc` plan from a natural-language chat request.
- Agent cannot silently submit a run — the P1.5 card confirmation is always required.

## Milestone P1.9: Smoke Wrapper And Manual Local Loop

Goal: prove the full Phase 1 vertical slice end-to-end.

Wrapper:

```text
phi/ngs/fastq-qc
```

Deliverables:

- Small smoke FASTQ fixture.
- Fixed Nextflow `main.nf`.
- Docker (and/or Apptainer) environment declaration for the local profile.
- Local profile only.
- Outputs and summary declarations.
- License and citation metadata.

Manual verification:

- `nextflow`/doctor check passes locally.
- Ask the agent (real chat turn, not a mock) to prepare a FASTQ QC plan.
- Review and submit the plan card.
- Watch the run complete locally.
- Reopen Phi and confirm the run and its outputs are still there.
- Open the MultiQC report in the local preview panel.
- Export reproducibility metadata for the run and confirm it's complete.

Acceptance:

- Phase 1 is not complete until this loop works against real local Nextflow (Docker or Apptainer), not just mocked executors.

## Milestone P1.10: Documentation And Handoff — DONE (as a handoff; Phase 1 itself is not fully closed)

Delivered: a [README section](../../README.md#phi-wrapper-phase-1), the
[authoring guide](./phi-wrapper-authoring-guide.md) (grounded directly in what
`manifest.ts` actually validates, not the aspirational full schema), a "What Phase 2
Needs From Phase 1" stability contract appended to the technical design, and a
[closeout doc](../roadmap/phi-wrapper-p1-closeout.md) — following this repo's existing
`docs/roadmap/*-closeout.md` convention (see `p1-plugin-beta-closeout.md`) rather than
inventing a new format.

The closeout doc is the important part to read before starting Phase 2: writing it
honestly against the PRD's own Phase 1 success criteria table surfaced three real,
previously-unnoticed gaps (samplesheet content isn't shown in the plan card, output
preview reveals in Finder rather than Phi's own preview panel, there's no
reproducibility-metadata export action) plus the fact that Milestone P1.9 is still
blocked on installing Nextflow on a real machine. One of the three gaps (input file
counts, though not full samplesheet row content) was closed on the spot while writing
this milestone since it was small and directly relevant to writing an honest doc — the
other two are left as real follow-up work, not silently scoped out.

Verification: `npm run lint` and `npm test` are clean for every wrapper-related file.
`npm run typecheck`/`npm run build` currently fail, but only on pre-existing errors in
`AnalysisView.tsx` from unrelated, concurrently in-progress work in this same
repository — confirmed by running `tsc --noEmit` scoped to each tsconfig and grepping
for "wrapper" in the output (nothing), and by running `npx electron-vite build`
directly (bypassing the typecheck gate) to confirm the actual bundling step — including
both build-copy plugins — succeeds cleanly on its own. Don't take "`npm run build`
fails" at face value without checking whose code the failure is actually in.

Goal: make Phase 1 usable by internal beta testers, and set up Phase 2 to start cleanly.

Deliverables:

- README section for Phi Wrapper (Phase 1 scope, explicitly noting remote is not yet available).
- Wrapper authoring guide (manifest fields, how to add a `custom` dev wrapper).
- Notebook-vs-wrapper guidance for users (see PRD's Relationship To Notebook Analysis).
- Short "what Phase 2 needs from Phase 1" note: confirm which Phase 1 types/interfaces are stable enough to build the remote resolver and remote path mapping on top of without a breaking change.

Verification:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- Manual local smoke evidence (P1.9) attached to the handoff.

---

# Phase 2: Remote Execution

Goal: add the remote-first control plane on top of the proven Phase 1 core. Do not start Phase 2 design-locking until Phase 1's P1.9 manual loop has actually run successfully — Phase 2's resolver, path mapping, and CLI all build directly on Phase 1 types, and any awkwardness found while actually using Phase 1 should feed back into those types before they're relied on remotely.

This phase is intentionally left as milestone-level scope, not fully detailed tasks — detail it once Phase 1 ships and real usage informs what to prioritize inside it (e.g. remote-background may matter more than Slurm for the first real users, or vice versa).

## Milestone P2.1: Remote Connection Model And File Browser Foundation

- Global remote connection records; project binding (`connectionId` + `remoteProjectRoot`).
- Remote doctor over SSH.
- Remote directory listing and small file preview over SSH.
- Download API as an explicit action; no automatic upload/download.
- Fake SSH adapters for tests.

## Milestone P2.2: Remote-First Resolver And Remote Path Mapping

- Extend `plans.ts`'s executor/profile resolution to the full chain (explicit → project default → global default → auto resolver) described in the PRD's Phase 2 Execution Policy.
- Remote and container path mapping variants.
- Heavy/hpc wrappers stop using the Phase 1 warning-only path and instead prompt to configure remote or explicitly confirm local fallback.

## Milestone P2.3: Remote And Slurm Executors

- Remote execution bundle upload (wrapper + params + config + launch script, never input data).
- Remote detached Nextflow launch.
- Slurm detection and `slurm` profile; `remote-background` fallback when no scheduler exists; optional `slurm-controller` profile.
- Status reconciliation via SSH polling / `squeue`/`sacct` without a remote daemon.
- Remote cancellation (`scancel`, or SSH kill via recorded pid).
- `lost` state when remote status can't be confirmed.

## Milestone P2.4: CLI Thin Shell

- `phi-wrapper list|inspect|doctor|validate|plan|submit|run|runs|show` over the same core used by the desktop UI.
- `run` as shorthand for plan + submit; same confirmation rules apply.

## Milestone P2.5: Remote Smoke Loop

- Same `phi/ngs/fastq-qc` wrapper, remote-background and Slurm profiles added.
- Manual verification against a controlled remote test host (or a faithful fake plus a documented manual command plan): submit, disconnect/reconnect, reconcile, browse remote output, preview report over SSH, explicit download.

---

# Phase 3: Trust & Registry

Goal: support more than one wrapper author safely. Left at milestone-level scope; detail once Phase 2 ships and there's a concrete second wrapper (or external author) motivating it.

## Milestone P3.1: Signed Registry

- Git-backed registry, bootstrap snapshot for offline catalog display.
- Manifest/workflow/environment digest verification against registry entries.
- Full trust tier model (`official_verified`, `community_verified`, `organization_verified`, `compatible`, `blocked`) replacing the Phase 1 `bundled`/`custom` split — this should be additive to the Phase 1 `WrapperTrustTier` union, not a breaking rename.
- Lifecycle status (`active`/`deprecated`/`retired`/`blocked`) enforcement.

## Milestone P3.2: GitHub/Registry Install

- `phi-wrapper install registry:...` / `install github:...`.
- No arbitrary post-install hooks, no `curl | bash`, no install-time project writes — same rules as Phase 1's simpler install path, just extended to remote sources.

## Milestone P3.3: Authoring CLI And Org Registries

- `phi-wrapper init|validate|test|pack` for third-party wrapper authors.
- Private organization registry UI and key management.
- Remote resource manager, richer scheduler adapters, more verified wrappers, Snakemake support if demand warrants it, validated composition, Seqera/Tower adapter.

---

## Suggested File Map (Phase 1)

Main process:

```text
src/main/agent/wrappers/
src/main/index.ts
```

Preload:

```text
src/preload/index.ts
src/preload/index.d.ts
```

Renderer:

```text
src/renderer/src/components/WrapperView.tsx
src/renderer/src/components/WrapperPlanCard.tsx
src/renderer/src/App.tsx
src/renderer/src/icons.ts
src/renderer/src/types.ts
```

Tests:

```text
tests/wrapper-manifest.test.ts
tests/wrapper-catalog.test.ts
tests/wrapper-plans.test.ts
tests/wrapper-executor.test.ts
tests/wrapper-tools.test.ts
tests/wrapper-view.test.ts
tests/main-integration.test.ts
```

`src/main/agent/remotes.ts` and `src/renderer/src/components/RemoteFilePanel.tsx` move to Phase 2's file map.

## Phase 1 Acceptance Checklist

- Bundled wrapper appears in Wrappers view with no network access.
- Agent can create a wrapper run plan from a real chat request.
- Plan card appears as a structured chat timeline item.
- Plan validation shows input preview and command plan.
- Heavy/hpc wrapper surfaces an acknowledgment-required warning instead of silently running.
- Submit creates a durable wrapper run and executes it via real local Nextflow.
- Run history persists across app restart, visible in both chat timeline and Wrappers page.
- Outputs are collected into `outputs.json`; summary into `summary.json`.
- Primary report opens in the existing local file preview panel.
- Reproducibility metadata can be exported.
- Audit events identify actor, plan, run, wrapper, version, confirmation, and command digest.
- A `custom` local wrapper can be added and never becomes a default agent tool.

## Remaining Risks

- The `customTools` agent-tool integration (P1.0) is confirmed by source reading but not yet by a live run; P1.8 is where that gets exercised for real. If `omp-sdk-worker.ts` behaves differently than the source suggests once actually wired up, stop and re-open P1.0 rather than working around it locally in P1.8.
- Apptainer/Docker availability on the developer's own machine may block P1.9's real local smoke run; have a Docker-only fallback path.
- The current app already has active work on file preview and resources, so wrapper UI should reuse those surfaces instead of duplicating them (unchanged from the original plan).
- Deferring the resolver/remote path mapping to Phase 2 means Phase 1's `plans.ts` must still be shaped so the Phase 2 resolver chain is additive, not a rewrite — review this specifically at the P1.4/P1.10 boundary.
- Real SSH/Slurm behavior varies across clusters (Phase 2 risk, unchanged from the original plan — just no longer blocking Phase 1).
- **Confirmed incident, now fixed:** unit tests run against source via a plain TS transpile and never caught that Rollup drops non-JS files (the fixture `wrapper.yaml`) from the bundled `out/main/index.mjs` — the bundled wrapper silently failed to install in the real packaged/dev-built app even though every test passed. Fixed with a `closeBundle` copy plugin in `electron.vite.config.ts` (same pattern as the pre-existing `copyOmpWorkerPlugin`), copying `src/main/agent/wrappers/fixtures/` to `out/main/fixtures/` — note the target is flat (`out/main/fixtures`), not a path mirroring the source tree, because rollup flattens the whole main entry into one file and `import.meta.url`-relative resolution inside it resolves against that file's own location. **Lesson for P1.9 and beyond: unit tests alone don't catch bundler/packaging gaps — always do at least one real `electron-vite dev` restart-and-click check for any change that adds a new non-JS asset or a new IPC surface, not just `npm test`.**

  **Superseded:** bundled wrapper packages were later moved out of `src/` entirely, to `resources/wrappers/`, using electron-builder's existing `asarUnpack: resources/**` mechanism instead of a bespoke copy plugin — `copyWrapperFixturesPlugin` was removed from `electron.vite.config.ts`. Path resolution across dev/packaged/plain-`node --test` contexts now goes through `getBundledWrapperPackagesDir()` in `catalog.ts`, using Electron's own `process.resourcesPath` / `app.getAppPath()` / `app.isPackaged` APIs. Verified against a real `electron-builder --dir` package: `app.asar.unpacked/resources/wrappers/` contains all bundled wrapper packages, and a real launch of the packaged app successfully installed them into `~/.phi/wrappers/installed/`.

- Also confirmed and fixed in the same pass: the Wrappers sidebar (P1.6) didn't match the rest of the app's shell (title-bar drag region, resizable sidebar divider, icon-box list rows, detail header block) because it was built from scratch instead of copying `McpView.tsx`'s structure. Fixed by restructuring `WrapperView.tsx` to follow that file line-for-line on layout. When adding a new sidebar view, copy the closest existing view's shell first and only change the content — don't rebuild the shell from general MUI intuition.
