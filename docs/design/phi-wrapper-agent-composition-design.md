# Agent-Facing Nextflow Wrappers

Date: 2026-09-15
Status: **Decision draft — align implementation to this shape before adding composition code.**

## 1. Decision

Phi should not compose wrappers by chaining multiple Phi runs outside
Nextflow. It should expose only agent-facing **wrappers** that are runnable
Nextflow entrypoints, and it should let Nextflow own execution, monitoring,
retry, caching, logs, resources, and scheduler integration.

The core shape is:

```text
modules/<provider>/<tool>/
  main.nf
  meta.yml
  environment.yml
  tests/
  wrapper/
    main.nf
    params.json
    wrapper.yaml

subworkflows/<provider>/<workflow>/
  main.nf
  meta.yml
  tests/
  wrapper/
    main.nf
    params.json
    wrapper.yaml
```

`modules/` and `subworkflows/` stay ordinary Nextflow/nf-core assets.
`wrapper/` is the thin adapter Phi exposes to the agent. Phi does not expose
raw modules as tools, because modules are `include` targets, not standalone
pipelines.

## 2. Why This Shape

The agent needs a small, reliable calling surface. A wrapper provides that:

- `wrapper/main.nf` turns agent-friendly params into the channel/module or
  subworkflow call.
- `wrapper/params.json` is a real default parameter file that runs on tiny
  test data with no edits.
- `wrapper/wrapper.yaml` tells the agent which params to replace and where
  outputs land.

This keeps the agent in its comfort zone: discover a wrapper, inspect the
minimal parameter contract, override input/output params, and ask Phi to
plan the run. If the user wants parameter tuning, debugging, or composition,
the agent can load source and tests progressively.

## 3. Wrapper Contract

`wrapper.yaml` is intentionally small. It is not a full workflow manifest,
not a replacement for `meta.yml`, and not a Nextflow schema. It only
describes the agent-facing parameters and declared outputs.

```yaml
id: nf-core/modules/fastqc
name: FastQC
summary: Run FastQC quality checks on FASTQ files.

params:
  reads:
    kind: input
    type: path_glob
    required: true
    description: FASTQ files to analyze.
  outdir:
    kind: output
    type: path
    required: true
    description: Output directory.
  threads:
    kind: option
    type: integer
    required: false
    minimum: 1
    maximum: 16
    description: CPU threads.

outputs:
  reports:
    type: directory
    path: "${outdir}"
    primary: true
```

Rules:

- Use fixed filenames: `wrapper/main.nf`, `wrapper/params.json`,
  `wrapper/wrapper.yaml`.
- Do not put `entrypoint`, `paramsFile`, defaults, environment, or agent
  hints in `wrapper.yaml`.
- Default values live only in `wrapper/params.json`.
- `params` uses one table for inputs, outputs, and ordinary options.
- `kind` is only `input`, `output`, or `option`.
- Requiredness is `required: true`; it is not a separate kind.
- Outputs do not need `required`; `primary: true` outputs must exist after a
  successful run.
- Environment and detailed tool metadata stay in `environment.yml`,
  `meta.yml`, and Nextflow config.

## 4. Discovery And Loading

Phi should scan only:

```text
modules/**/wrapper/wrapper.yaml
subworkflows/**/wrapper/wrapper.yaml
```

If a module or subworkflow has no `wrapper/`, it is not directly callable by
the agent.

Agent tools should be generic and progressively loaded:

- `wrapper.search`: returns compact results only: id, name, summary, key
  input/output params, and primary output.
- `wrapper.inspect`: returns `wrapper.yaml` plus default
  `wrapper/params.json`.
- `wrapper.plan_run`: accepts param overrides, merges them with
  `wrapper/params.json`, validates the merged params, and creates a plan.
- `wrapper.load_source`: optional, used only for composition or debugging;
  can load `wrapper/main.nf`, component `main.nf`, `tests/`, `meta.yml`, or
  `environment.yml`.

Do not register one LLM tool per wrapper. The agent should use the generic
tools, like skills: search first, inspect only selected wrappers, and load
source only when needed.

## 5. Execution

Every wrapper must be smoke-testable with the fixed command:

```bash
nextflow run wrapper/main.nf -params-file wrapper/params.json
```

`wrapper/params.json` must use real tiny test data, not placeholders. That
file is the default run configuration. For real data, the agent usually
overrides only `kind: input` params and commonly overrides `kind: output`
params; `kind: option` params stay at their defaults unless the user asks
for tuning.

Phi validation stays light:

- required params are present after merging defaults and overrides
- simple type checks: string, integer, boolean, path, path_glob, file,
  directory, html, json, csv, fastq_glob, bam, bai, fasta, gtf
- enum/range checks when declared
- local path/glob existence where applicable
- output path can be created or written
- primary declared outputs exist after a successful run

Phi should treat `wrapper/main.nf` as a black-box Nextflow entrypoint in the
first implementation. Correct channel semantics are proven by the wrapper
smoke test and by Nextflow at runtime, not by a Phi-side Nextflow parser.

## 6. Composition

When the agent needs multiple tools, it should generate a temporary
subworkflow component with the same layout:

```text
plans/<planId>/subworkflows/agent-generated/
  main.nf
  wrapper/
    main.nf
    params.json
    wrapper.yaml
```

The temporary component does not write back into the global workspace unless
the user explicitly saves or curates it later.

Composition rules:

- The agent first searches and inspects only the selected wrappers.
- If needed, it uses `wrapper.load_source` for the selected components'
  source/tests.
- The generated subworkflow should include the original modules or
  subworkflows, not other wrappers.
- Wrapper adapters should not be nested inside other wrapper adapters.
- The temporary wrapper still runs as a single Nextflow run via
  `-params-file`, so Nextflow owns monitoring and orchestration.

This preserves a single user approval surface for the generated run plan,
instead of asking the user to approve a chain of separate Phi runs.

## 7. Tests As Usage Evidence

Component `tests/` remain the source of truth for module/subworkflow
correctness and calling patterns. The wrapper adds one extra agent-facing
smoke path:

```bash
nextflow run wrapper/main.nf -params-file wrapper/params.json
```

That proves the default params, wrapper adapter, and declared outputs work
together. The agent does not need to read tests for normal execution; tests
are loaded only for composition, debugging, or deeper parameter work.

## 8. Implementation Implications

This replaces the earlier plan to orchestrate multiple independent wrapper
runs from Phi. The implementation should move toward:

- generic wrapper tools instead of eager `wrapper.<id>` execute tools
- scanning `wrapper/` directories under `modules/` and `subworkflows/`
- plan creation from overrides merged into `wrapper/params.json`
- a minimal `wrapper.yaml` parser/validator separate from the existing full
  `wrapper.yaml` package manifest, or a migration of the existing manifest
  toward this smaller per-wrapper contract
- wrapper smoke validation before a wrapper is made available to the agent
- temporary composition plans that create a `subworkflows/agent-generated`
  component with its own `wrapper/`

Existing bundled wrappers can be migrated incrementally. The next slice
should be small: one module wrapper using this layout, indexed through the
generic search/inspect/plan path, with a smoke test proving the fixed
Nextflow command works.
