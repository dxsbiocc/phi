# Scientific Trust Implementation Plan

Date: 2026-11-15
Status: Proposed — not started. No code change is authorized by this document.
Baseline: `aa295f7d` (`v0.1.7` + 1 local commit), working tree otherwise clean except
`docs/roadmap/v0.1.7-workflow-acceptance.md` and two untracked research drafts.

Scheduling update (2026-11-17): T1 also covers unresolved required output paths.
T2 builds on the existing terminal manifest record. For T5, preserve invalid-plan
rejection and fix duplicate mates, ambiguous lane handling, and missing mates in
explicit paired-end input. The T5 section below records the original proposal.
Read the stop-defect prerequisite with the latest
[workflow acceptance results](v0.1.7-workflow-acceptance.md).

Scope owner: this plan strengthens three properties of the existing internal-beta
workbench — **completion**, **accuracy**, **reproducibility** — for scientific use.
It adds no new product surface, no new distribution channel, and no collaboration
feature. Everything here is inside the
[internal beta scope](internal-beta-implementation.md): P1 wrapper reliability, P2
polish, and the existing session/run record.

## Why this plan exists

Phi's scientific claim is that a known method runs the same way every time. The
adapter layer that makes that claim true already exists: fixed versioned Nextflow
units, declared inputs, parameter validation before start, and a per-run directory.
What is still thin is the **evidence** that a finished run did what it said.

Three observations from the current code motivated this plan. All are read from
source on the baseline above, not inferred from documentation.

### Observation 1 — two run paths disagree about completion

A composition (multi-step) run validates its primary outputs and fails when one is
missing
([job-manager.ts](../../src/main/agent/wrappers/composition/job-manager.ts) → `findMissingPrimaryOutputs`,
[validate.ts](../../src/main/agent/wrappers/composition/validate.ts)).

A local single-wrapper run does not. It collects outputs into records with an
`exists` flag, writes `outputs.json`, and then transitions to `completed` purely on
`exitCode === 0`
([executor-local.ts](../../src/main/agent/wrappers/executor-local.ts) `collectOutputs` / the
`collecting → completed` transition).

So a wrapper that exits 0 and produces nothing is reported as success on one path and
as failure on the other. This is the single highest-value correctness gap in the
plan.

### Observation 2 — the answer-alignment gate exists, but only on one door

`parseAgentReport` returns `status: 'completed'` when a response has no
`<phi_agent_result>` block
([report.ts](../../src/main/agent/agents/report.ts)).

`requireDeclaredCompletion` already corrects exactly that case by downgrading an
unstructured `completed` to `partial`
([report.ts](../../src/main/agent/agents/report.ts) lines 76–79).

It is applied at the agent-run boundary only for host-origin runs
([registry.ts](../../src/main/agent/agents/registry.ts) line 427). Plan steps reach that
boundary as `origin: 'host'`
([agent-run-start.ts](../../src/main/agent/engine/in-process/agent-run-start.ts) line 46), so
**plan steps are already covered**. Direct agent-to-agent delegation (`origin: 'tool'`)
is not.

This is a real but narrow gap, and it is deliberately listed _after_ Observation 1.
It must not be described as "failures are silently swallowed" — that would be wrong
on this baseline.

### Observation 3 — a run record cannot prove how it was produced

The reproducibility bundle is honest about being a subset: its own doc comment says
it carries no registry snapshot, no workflow or environment digest, and no runtime
version capture
([reproducibility.ts](../../src/main/agent/wrappers/reproducibility.ts) lines 14, 31–39).

The target fields are already specified in the technical design's
"Audit And Reproducibility" section
([phi-wrapper-technical-design.md](../design/phi-wrapper-technical-design.md) line 692 onward).

Two concrete consequences:

- A saved `.ipynb` writes a default `kernelspec` and a `phi` marker, but not the
  managed `envId` that actually executed it
  ([analysis-notebook-files.ts](../../src/main/agent/notebook/analysis-notebook-files.ts) lines 143–159).
- Exported wrapper metadata reads the **currently installed** manifest, so upgrading
  a wrapper silently changes what an old run claims it ran with
  ([reproducibility.ts](../../src/main/agent/wrappers/reproducibility.ts) line 14).

## Work items

Ordered by (correctness gain ÷ change size). Each item is independently shippable
and independently testable. Do not batch them into one release gate.

### T1 — One primary-output verdict for every run path

**Goal.** A run is `completed` only when every `primary: true` output exists, on
both the single-wrapper and composition paths.

**Change.** Lift the existing `findMissingPrimaryOutputs` logic into a shared
validator that both executors call before their terminal transition. Local executor
calls it inside the `collecting` step and falls back to `failRun` with the missing
list when it returns non-empty. Reuse the existing `missingOutputs` field on the run
record and on `summary.json`; do not introduce a second field.

**Non-goals.** No change to remote/Slurm paths in this item; they already validate
in `remote-job.ts`. No change to the run state machine's states.

**Tests.** Extend `tests/wrapper-composition-validate.test.ts` for the shared
validator. Add a local-executor case where the fake Nextflow exits 0 and writes no
primary output, asserting `failed` + populated `missingOutputs`; and a positive case
asserting `completed` is unchanged when outputs exist.

**Acceptance.** Both paths produce the same verdict for the same manifest, params and
output tree. A regression test fails if the local path stops calling the shared
validator.

**Risk.** Low. The validator already exists; the risk is only call-site ordering
(validate after Nextflow has flushed output files, not before).

### T2 — Snapshot the manifest at run creation

**Goal.** An exported run record describes the wrapper as it was when the run
started.

**Change.** Write a read-only copy of the resolved manifest into the run directory at
creation time, and have `buildWrapperReproducibilityBundle` prefer that copy over the
installed catalog entry. Keep reading the installed manifest as a fallback for run
directories created before this change, so old records stay readable.

**Non-goals.** No registry snapshot, no package-level digest chain. Those belong to
T4 and to the deferred content-distribution work.

**Tests.** `tests/wrapper-reproducibility.test.ts`: a run created against manifest
version A, then catalog upgraded to B, still exports A. A legacy run directory
without the snapshot still exports without throwing.

**Acceptance.** Upgrading a wrapper package cannot retroactively change an old run's
exported manifest.

**Risk.** Low. Pure additive file plus a read-preference change.

### T3 — Record the executing environment in the notebook

**Goal.** A saved `.ipynb` identifies the managed environment that produced its
outputs.

**Change.** Extend the `phi` metadata block written on save with the executing
`envId`, the environment's `lockSha256`, the interpreter version, and the Phi
version. Read these from the environment handle already available at execution time,
not by re-detecting at save time.

**Non-goals.** No change to `.ipynb` compatibility. Unknown fields must remain
ignorable by other tools; `metadata` is the correct place for this and Jupyter
implementations already tolerate extra keys.

**Tests.** Extend `tests/analysis-notebook-files.test.ts` and
`tests/notebook-execution-metadata.test.ts`: a notebook executed in a managed
environment saves the `envId` and lock digest; a notebook executed on an explicitly
selected host kernel records that it was not managed, rather than omitting the block.

**Acceptance.** For a notebook executed in a managed environment, the saved file alone
is enough to name the environment and its lock digest, without opening Phi.

**Risk.** Low, but watch existing snapshot equality tests that compare whole
`metadata` objects — they will need a targeted update rather than a loosened
assertion.

### T4 — Fill the missing runtime versions into the export

**Goal.** Reproducibility metadata names the actual engine and container runtime.

**Change.** Capture at run time, not export time: Nextflow version, container runtime
and image reference with digest when a container profile is used, host OS/arch, and
the environment digest (already available as `lockSha256` in environment metadata).
Write into `summary.json` and surface through the bundle. Mark absent values as
explicitly unknown rather than omitting the key, so a consumer can distinguish
"not recorded" from "not applicable".

**Non-goals.** No new executor, no re-writing of Nextflow invocation. No attempt to
make container images immutable.

**Tests.** A local run with a fake `nextflow -version` records the version; a run with
no resolvable version records `unknown` and still completes. Export shape asserted in
`tests/wrapper-reproducibility.test.ts`.

**Acceptance.** A consumer of the bundle can answer "which Nextflow and which image"
for any run created after this item, or read `unknown` with a reason.

**Risk.** Medium-low. Version probing adds a subprocess call; it must not be able to
fail a healthy run, and must respect the same timeouts as existing doctor checks.

### T5 — Samplesheet confirmation before submit

**Goal.** A silently dropped sample cannot become a silently wrong result.

**Change.** Keep the existing filename-based derivation, but treat a partial result as
something the user confirms rather than something the run absorbs. The plan card
shows: row count, sample count, paired-completeness, and the explicit list of files
that were skipped and why. Submitting a plan whose samplesheet had dropped files
requires an explicit acknowledgement.

**Non-goals.** No new sample-naming heuristics, no guessing R1/R2 for unknown
conventions. Do not block legitimate single-end data.

**Tests.** `tests/wrapper-samplesheet.test.ts`: a set with two unmatched files yields
both a valid table and a non-empty skipped list; the acknowledgement flag is required
only when the skipped list is non-empty.

**Acceptance.** A user cannot start a run that dropped input files without having seen
which files and how many.

**Risk.** Medium. Touches the plan card and submit gate; both have existing tests, and
the UI change is additive rather than a redesign.

### T6 — Optional machine-checkable acceptance on plan steps

**Goal.** A plan step can declare how completion is verified, instead of relying only
on the sub-agent's self-report.

**Change.** Add an optional `verify` field to `PlanStep` covering a small closed set:
file existence, JSON path equality, table column presence and minimum row count, and
command exit status. The executor runs the check after an agent reports `completed`;
a failed check downgrades the step to `failed` and enters the existing retry policy.
The plan review card shows how many steps carry machine verification.

**Non-goals.** No arbitrary expression evaluation, no new scripting language, no
network assertions. This is deliberately a closed list so that the check itself is
auditable.

**Tests.** Pure-function coverage of each check type plus the downgrade path; a step
that self-reports `completed` but fails its declared check lands in `failed` with
`attempts` incremented per the existing policy.

**Acceptance.** A plan where every step declares `verify` cannot reach `completed`
unless every check passes.

**Risk.** Medium-high. This touches the shared `planRunTypes.ts` contract used by
main, preload and renderer, and needs a corresponding renderer change. Ship it only
after T1 and T2, and only with the review card updated in the same change.

### T7 — Output content assertions on wrapper manifests

**Goal.** An output that exists but is empty, truncated, or structurally wrong is not
reported as usable.

**Change.** Add an optional `expect` block to a manifest output declaration: non-empty,
minimum rows, required columns, or parse-as. Validate during output collection and
record the per-output result. This is an additive manifest field; per the wrapper
contract's versioning rule, additive changes are a minor bump and do not break
existing packages.

**Non-goals.** No semantic domain validation (no "is this a plausible alignment
rate"). That is T8's job and belongs to wrapper authors, not the engine.

**Tests.** Manifest schema validation for the new field, plus collection tests for
each assertion type and for the absent-field case (behaviour unchanged).

**Acceptance.** A manifest declaring a non-empty requirement cannot report an empty
output as present-and-valid.

**Risk.** Medium. Requires a Phi Packages builder change and a catalog-wide decision
about which packages adopt the field. Land the engine support first; adoption can
follow per package.

### T8 — QC summary extraction for common wrappers

**Goal.** The next step of a workflow receives objective metrics instead of a model's
reading of a log.

**Change.** For a small initial set of wrappers (QC and alignment), declare which
report fields to extract and expose them as a structured summary attached to the run.
Downstream steps receive that summary in their prompt context.

**Non-goals.** No general log parser, no per-tool bespoke code paths in the engine —
extraction rules are declared per wrapper, consistent with how the manifest already
declares outputs.

**Tests.** Fixture reports for each adopted wrapper produce the expected summary;
a missing report yields an explicit absent summary, not an empty object.

**Acceptance.** For an adopted wrapper, the downstream step prompt contains the
declared metrics rather than only "the step completed".

**Risk.** Medium. Depends on T7's shape landing first, and on choosing a genuinely
small initial wrapper set.

## Sequencing

```
T1, T2, T3   →  independent, small, no schema change        (ship first, separate commits)
T4           →  after T2 (writes into the same record)
T5           →  independent of T1–T3
T6           →  after T1, T2 (needs a trustworthy per-step verdict to build on)
T7           →  after T4
T8           →  after T7
```

T1, T2 and T3 are the recommended first increment. None changes a shared contract,
each has an existing test file to extend, and together they close the two claims in
the README that are currently only partly true: "confirms that each primary output
exists" and "results are ordinary files in the folder you chose".

## What this plan deliberately does not do

- It does not add a subsystem. Every item extends code that exists.
- It does not change the run state machine, the approval model, or the kernel protocol.
- It does not introduce provenance signing or remote attestation; those belong to the
  distribution and signing work, not to the local workbench.
- It does not attempt to make results bit-identical across machines. Reproducibility
  here means "recorded well enough to inspect and re-run", matching the README's own
  wording, not deterministic replay.
- It does not propose a generic verification framework. T6 and T7 are intentionally
  closed lists so that a verification result stays auditable.

## Open decisions

1. **T6 shape.** Whether `verify` lives on `PlanStep` (shared contract, three ends) or
   in a separate optional sidecar keyed by step id. The shared-contract route is
   simpler to read and harder to keep consistent; decide before implementation starts.
2. **T7 adoption.** Which packages adopt `expect` first, and whether an un-updated
   package should be flagged in the catalog as carrying no content assertions.
3. **T8 scope.** The initial wrapper list. Keeping it to QC plus one aligner is the
   smallest set that proves the pattern.
4. **Backfill.** Whether historical runs should be marked "pre-evidence" so the UI can
   distinguish old records from new ones, rather than showing missing fields as
   defects.

## Relationship to existing roadmaps

- Sits inside [internal beta implementation](internal-beta-implementation.md) P1
  wrapper reliability and P2 polish. Does not pull forward any deferred item.
- Depends on nothing from [phi-kernel-implementation.md](phi-kernel-implementation.md);
  T1, T2, T3, T5 are desktop-side and path-independent. T6 touches plan types that the
  kernel also consumes, so if kernel work lands first, re-check the shared type in the
  same change.
- Does not overlap the stop-semantics defect currently recorded in
  [v0.1.7-workflow-acceptance.md](v0.1.7-workflow-acceptance.md). That defect is a
  release blocker and takes precedence over every item here; this plan should not
  begin until it is closed.
