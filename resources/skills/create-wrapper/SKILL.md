---
name: create-wrapper
description: Playbook for the core Wrapper agent — delegate wrapper requests to `Wrapper`. Author a Nextflow adapter (wrapper/main.nf + wrapper/params.json + wrapper/wrapper.yaml) under the selected phi-packages checkout's resources/wrappers/, validate it with Phi's tooling, then build and explicitly install its package. Use when asked to add or change an agent-callable module, subworkflow, or pipeline.
metadata: {"version": "1.1"}
---

# Create Wrapper

## Overview

Phi does not expose raw Nextflow modules/subworkflows to the agent directly — a module is an `include` target, not a standalone pipeline. Instead, each callable tool is a thin **wrapper adapter**: a `wrapper/` directory sitting beside a vendored component's own `main.nf`, containing exactly three files (`main.nf`, `params.json`, `wrapper.yaml`) plus an auto-picked-up `nextflow.config`. Author these files in phi-packages; no Phi engine code change is needed. The live tools discover installed packages under `~/.phi/wrappers/tree/` and user-authored wrappers. Editing the source checkout does not install or update a package.

### Select the two checkouts

Phi contains the core agent, this skill, and validation/build scripts. phi-packages contains the distributable source. Locate both before editing. In the examples below, `PHI_ROOT` is the absolute Phi checkout path and `PHI_PACKAGES_ROOT` is the absolute selected content checkout path. They are normally sibling directories; do not assume that layout when explicit paths were provided. All `resources/wrappers/...` paths below are relative to **phi-packages**, and source edits run from that checkout. Never recreate that directory inside Phi or edit installed package files as a substitute for source changes.

If either required checkout or write access is missing, report the missing requirement. This bundled skill may also be loaded by a packaged app, which does not contain the development scripts.

Full design rationale: [docs/design/phi-wrapper-agent-composition-design.md](../../../docs/design/phi-wrapper-agent-composition-design.md). This skill is the practical how-to; read the design doc if something here is ambiguous.

## Layout

```text
resources/wrappers/
  modules/<provider>/<tool>/              # e.g. modules/nf-core/fastqc, modules/local/deseq2_qc
    main.nf              # the vendored process — NEVER edit this
    meta.yml              # nf-core metadata (may be absent for local/ modules)
    environment.yml        # conda env (may be absent for local/ modules)
    tests/                 # nf-test suite + tests/data/ fixtures — READ, don't write
    wrapper/                # <-- what you create
      main.nf
      params.json
      wrapper.yaml
      nextflow.config       # picked up automatically, not part of the fixed triad
      dag.mmd                # generated, see step 7

  subworkflows/<provider>/<name>/   # same shape, wraps a subworkflow's main.nf instead
  workflows/<pipeline>/              # same shape, wraps a whole vendored nf-core pipeline (rare — see "Full pipelines" below)
```

Discovery walks `modules/**/wrapper/wrapper.yaml`, `subworkflows/**/wrapper/wrapper.yaml`, and `workflows/**/wrapper/wrapper.yaml` in the installed tree (see Phi's `src/main/agent/wrappers/composition/discovery.ts`). Source validation explicitly selects phi-packages' `resources/wrappers/` tree. A component without an adapter is not callable; a new adapter becomes callable after its package is built and installed.

## Step-by-step

### 1. Find the target and read what it actually needs

```bash
find resources/wrappers/modules -maxdepth 3 -type d -name wrapper   # what's already wrapped
```

Pick the module/subworkflow directory (e.g. `resources/wrappers/modules/nf-core/bedtools/genomecov`). Read, in this order:

1. **`main.nf`** — the `input:` and `output:` blocks tell you the exact channel shape the process expects (tuple arity, `val(meta)` vs bare `path`, `emit:` names) and what `task.ext.args`/`task.ext.prefix` it honors.
2. **`tests/main.nf.test`** — this is the ground truth for how to actually call the process: the exact `input[0] = [...]`/`input[1] = ...` values an nf-test uses. Mirror this shape in your `wrapper/main.nf` channel construction — don't guess at the tuple layout from `input:` alone.
3. **`meta.yml`** (if present) — `description`, `tools[].description`, `keywords` — for writing `wrapper.yaml`'s `summary`.
4. **Test data** — what your `wrapper/params.json` will point at. Never fabricate data; use, in this order: (a) a file already under the component's own `tests/data/`; (b) the same public nf-core test-dataset file the module's `tests/main.nf.test` loads, as a raw URL — `params.modules_testdata_base_path + "X"` in the test is `https://raw.githubusercontent.com/nf-core/test-datasets/modules/data/X` (most existing wrappers do this, e.g. `samtools/sort`); (c) for a *glob of local files* (`fastq_glob`/`path_glob` — Nextflow cannot glob over HTTP), copy the tiny `tests/data/test_{1,2}.fastq.gz` from `modules/nf-core/fastqc/` into the new component's `tests/data/`.

### 2. Write `wrapper/wrapper.yaml`

This is the **agent-facing contract only** — not a full manifest, not a copy of `meta.yml`, no defaults, no entrypoint path (that's always `wrapper/main.nf`, fixed by convention).

```yaml
# Agent-facing wrapper adapter for the vendored <TOOL> module at ../main.nf.
# Follows the minimal contract in
# docs/design/phi-wrapper-agent-composition-design.md section 3.
id: <provider>/modules/<tool>
name: <Human Name>
summary: <One sentence, what it does>

params:
  <param_name>:
    kind: input | output | option
    type: <see type table below>
    required: true | false
    description: <one sentence>
    # option-only, when relevant:
    minimum: <number>
    maximum: <number>
    enum: [<string>, <string>, ...]

outputs:
  <output_name>:
    type: directory | file | <same vocabulary as params>
    path: '${outdir}/<tool>'   # ${...} interpolates against the *param* names above
    primary: true               # exactly the output(s) that must exist after a successful run
```

Rules (from the design doc, section 3 — do not deviate):

- Every `required: true` param must have a value in `params.json` (or the agent must supply it): `wrapper_run` validates required params, `integer`/`boolean`/`string` types, `enum`, `minimum`/`maximum`, that plain-path `kind: input` values exist, and **rejects override keys that are neither declared in `wrapper.yaml` nor present in `params.json`** (typo guard). After a successful run it also fails the run if a `primary: true` output path is missing — so declare `primary` only on outputs that really appear under `${outdir}/...`.

- `params` is one flat table covering inputs, outputs, and options — `kind` is the only thing that distinguishes them; there is no separate `outputs`-shaped input block.
- Only expose params the agent plausibly needs to override. A module's `input:` block often has extra positional args (adapter FASTA, config files, toggles) — if the tool's own sane default works, hard-code it in `wrapper/main.nf` (as `[]` / `null` / a fixed value) instead of surfacing it as a param. See `fastp/wrapper/wrapper.yaml`'s and `multiqc/wrapper/wrapper.yaml`'s doc comments for real examples of this trade-off.
- Do not put defaults, environment info, or agent hints in `wrapper.yaml` — defaults live only in `params.json`; environment/tool metadata stays in `environment.yml`/`meta.yml`, which the agent reads separately via `readWrapperModuleDetails`.
- `id` has no hard validation, but follow the existing naming convention exactly (`grep -h '^id:' resources/wrappers/*/*/*/wrapper/wrapper.yaml` to see every id in use): `<provider>/modules/<tool>` where nested module directories join with a hyphen (`modules/nf-core/bowtie2/align` → `nf-core/modules/bowtie2-align`), `<provider>/subworkflows/<name>`, or `<provider>/workflows/<pipeline>`.

**Valid `type` values** (Phi's light validation understands exactly these): `string`, `integer`, `boolean`, `path`, `path_glob`, `file`, `directory`, `html`, `json`, `csv`, `fastq_glob`, `fastq`, `bam`, `bai`, `fasta`, `gtf`. Pick the closest match — `fastq_glob` for a glob matching paired/single-end reads, `file`/`fastq` for one exact file, `path`/`directory` for an output location.

### 3. Write `wrapper/main.nf`

Fixed skeleton — copy this shape, don't restructure it:

```groovy
#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored module at ../main.nf.
// See docs/design/phi-wrapper-agent-composition-design.md section 1.
nextflow.enable.dsl = 2

include { <PROCESS_NAME> } from '../main.nf'

params.<input_param> = null
params.outdir        = null

workflow {
    <build the channel(s) main.nf's input: block expects, from tests/main.nf.test>

    <PROCESS_NAME>(<args matching input: block arity>)
}
```

**Exposing an `option` param** (a tool setting, not a file): declare `params.<name> = <default>` in `main.nf`, then feed it where it is used — into the `meta` map when the module reads `meta.*` (e.g. `strandedness`, `single_end` in `subread/featurecounts/wrapper/main.nf`), or into `ext.args` in `nextflow.config` using a closure so it is evaluated per task: `ext.args = { "-t ${params.feature_type}" }`. Give it `required: false`, a real default, and `enum`/`minimum`/`maximum` when the value set is closed.

**A `params.x = default` in `main.nf` is invisible to `nextflow.config`.** Config closures (`ext.args`, `publishDir` paths) read `params` before the script runs, so an unset one is `null` (`-t null`, a `null/` output directory, and an "Access to undefined parameter" warning). Any param a config closure reads must also be defaulted **in `nextflow.config`** (`params.feature_type = 'exon'` at the top); a params file still overrides it. `wrapper_run` always merges `params.json`, which hides this — so smoke-test once with a params file that omits the option.

Common channel-construction idioms, pick based on what step 1 revealed:

| Module expects | Build it with |
|---|---|
| `tuple val(meta), path(reads)`, paired/single FASTQ glob | `Channel.fromFilePairs(params.reads, size: -1).map { sample, reads -> [[id: sample], reads] }` |
| `tuple val(meta), path(x)`, one file/glob | `Channel.fromPath(params.x, checkIfExists: true).map { f -> [[id: f.simpleName], f] }` |
| Aggregating many files into one call (e.g. MultiQC) | `Channel.fromPath(params.logs).collect().map { files -> [[id: 'multiqc'], files, [], [], [], []] }` — trailing `[]`s fill the module's other optional positional inputs; check `input:`'s full tuple arity |
| Module needs `single_end` in the meta map | `[[id: sample, single_end: reads instanceof List ? reads.size() == 1 : true], reads]` |
| Module needs a `.bai` next to the BAM (RSeQC, etc.) | Compose `SAMTOOLS_INDEX` first: `bam_ch.join(SAMTOOLS_INDEX.out.index)` gives `[meta, bam, bai]` — see `rseqc/bamstat/wrapper/main.nf` |
| Optional positional inputs your wrapper doesn't expose | Pass the literal fixed value the module treats as "off" — usually `[]` (see `gffread/wrapper/main.nf`'s `GFFREAD(gff_ch, [])`) |

**Composing two vendored modules in one wrapper** (e.g. a tool with no meaning without a prerequisite step, like STAR align needing a genome index first): `include` both modules directly and chain them in the `workflow {}` block — see `resources/wrappers/modules/nf-core/star/align/wrapper/main.nf` for the full pattern. Composition rule: only include **vendored modules/subworkflows directly**, never another wrapper's `wrapper/main.nf` — wrapper adapters must not nest inside each other.

Never edit the vendored `../main.nf` itself to make wiring easier — the adapter conforms to the module, not the reverse.

### 4. Write `wrapper/nextflow.config`

Not part of the fixed triad, but Nextflow picks it up automatically because it sits beside `wrapper/main.nf`. This block is near-identical across every existing wrapper — copy it and fill in the blanks:

```groovy
// Launcher config for the <TOOL> wrapper adapter. Not part of the fixed
// wrapper/{main.nf,params.json,wrapper.yaml} contract — Nextflow picks this
// up automatically because it sits beside wrapper/main.nf.

process {
    cpus   = <1-2 for light tools, more for aligners>
    memory = '<e.g. 2.GB>'
    time   = '<e.g. 30.min / 1.h>'

    withName: '<PROCESS_NAME>' {
        publishDir = [
            path: { "${params.outdir}/<tool>" },
            mode: 'copy'
            // add: pattern: '*.{ext,ext}'   only if you need to filter what's published
        ]
    }
}

profiles {
    docker {
        docker.enabled = true
        conda.enabled = false
        singularity.enabled = false
    }
    singularity {
        singularity.enabled = true
        singularity.autoMounts = true
        docker.enabled = false
        conda.enabled = false
    }
    conda {
        conda.enabled = true
        docker.enabled = false
        singularity.enabled = false
    }
}
```

The `profiles {}` block is boilerplate — copy it verbatim every time. `wrapper_run` always passes `-profile docker|singularity|conda`, so all three must exist.

### 5. Write `wrapper/params.json`

Real default parameters that run end-to-end on tiny data with zero edits — this is what `wrapper_run` merges agent overrides into, and what the smoke test in step 6 uses.

```json
{
  "<input_param>": "tests/data/<existing fixture from the component's own tests/data/>",
  "outdir": "results"
}
```

Local paths are relative to the **component's own root** (the module/subworkflow directory, `wrapper/`'s parent) — not to `wrapper/`. URLs are fine for a single file (`Channel.fromPath` stages them); globs must be local. Include a value for every option you want the default run to exercise, and remember the default run must pass on the tiny data — e.g. `subread/featurecounts` sets `feature_type: "CDS"` because the sarscov2 GTF has no `exon` rows.

### 6. Smoke-test it

Run the exact fixed command Phi's `wrapper_run` tool uses, from the component's own root:

The direct command needs a version-checked Nextflow and Java on `PATH`, plus Docker for the Docker profile. Prefer Phi's smoke script below, which uses the managed `phi:nextflow@1` environment unless an explicit host override was configured. Do not assume a developer-specific Conda installation.

```bash
cd "$PHI_PACKAGES_ROOT/resources/wrappers/modules/<provider>/<tool>"
nextflow run wrapper/main.nf -params-file wrapper/params.json -profile docker
# clean up run artifacts before committing:
rm -rf work .nextflow* results
```

Or use Phi's smoke script with an explicit source (it also checks the triad, `params.json` against `wrapper.yaml`, the includes, every URL in `params.json`, and each primary output, and cleans up its run artifacts):

```bash
npm --prefix "$PHI_ROOT" run smoke:wrappers -- --source "$PHI_PACKAGES_ROOT" <part of the wrapper id> --offline
npm --prefix "$PHI_ROOT" run smoke:wrappers -- --source "$PHI_PACKAGES_ROOT" <part of the wrapper id> --preview
npm --prefix "$PHI_ROOT" run smoke:wrappers -- --source "$PHI_PACKAGES_ROOT" <part of the wrapper id> --run --profile docker
```

Then confirm the primary output exists under `results/`. If the run fails, the channel shape from step 3 almost always doesn't match `main.nf`'s `input:` block — recheck `tests/main.nf.test`; if the tool itself errors on the data (e.g. "no features were loaded"), the test data and the tool's defaults disagree — set an option in `params.json`/`nextflow.config` rather than changing the data.

### 7. Generate the DAG

```bash
node "$PHI_ROOT/scripts/generate-wrapper-dags.mjs" --source "$PHI_PACKAGES_ROOT"
```

This regenerates `wrapper/dag.mmd` for every wrapper via `nextflow -preview -with-dag` (no execution, seconds to run) — needed for the Wrappers UI's structure view. Commit the refreshed `dag.mmd`.

### 8. Check the content catalog expectations

Phi's `tests/package-content/wrapper-nf-core-modules.test.ts` keeps required baseline wrapper IDs in `EXPECTED_MODULE_WRAPPER_IDS` and allows additional entries. When an intentional catalog change affects those expectations, update them explicitly. Its discovery and validation checks read the selected external source; ordinary Phi unit tests use independent fixtures.

### 9. Run the tests

```bash
PHI_PACKAGES_ROOT="$PHI_PACKAGES_ROOT" npm --prefix "$PHI_ROOT" run test:packages
npm --prefix "$PHI_ROOT" run check:package-content -- --source "$PHI_PACKAGES_ROOT"
```

This exercises discovery, `wrapper_search`, and `wrapper_inspect` against the real phi-packages source and checks that **every wrapper's own `params.json` passes `wrapper.yaml` validation**. It catches malformed manifests, retired baseline IDs, missing defaults, wrong types/enums, invalid local inputs, and broken DAGs. Run Phi's core suite when engine behavior changed; adding source content alone does not require replacing its independent unit fixtures.

### 10. Build and explicitly install the package

Stage only the reviewed source files in phi-packages before building: the registry builder packages Git-tracked files and rejects untracked content. Build into an explicit temporary output directory with Phi's `registry:build -- --source <phi-packages checkout> --out <output directory>`, selecting a new wrapper package version for changed published payloads. Import the resulting registry in Phi and explicitly install/update the affected wrapper family. Confirm it with `wrapper_search` and `wrapper_inspect`. Do not overwrite a published version with changed bytes. Public catalog signing and publishing require a task that authorizes publication; source authoring alone does not.

## Subworkflow wrappers

Same triad and same smoke test; the reference example is `resources/wrappers/subworkflows/nf-core/bam_sort_stats_samtools/wrapper/`. What differs from a module:

- `include { <SUBWORKFLOW_NAME> } from '../main.nf'` and call it with the channels from its `take:` block (the comments in `main.nf` and `tests/main.nf.test` give the tuple shapes). Include **only the subworkflow** — it already includes its own modules; never re-include those or another wrapper.
- Optional `take:` inputs you don't expose (e.g. reference FASTA/FAI) get the module-style empty value: `channel.value([[:], [], []])`.
- `id` is `<provider>/subworkflows/<name>` with underscores turned into hyphens (`bam_sort_stats_samtools` → `nf-core/subworkflows/bam-sort-stats-samtools`).
- Process names inside are qualified (`BAM_SORT_STATS_SAMTOOLS:BAM_STATS_SAMTOOLS:SAMTOOLS_STATS`), but `withName` matches the simple name, and accepts a regex — one `withName: 'SAMTOOLS_.*'` block with a `publishDir` `pattern` publishes every step's files into a single `${outdir}/<name>` directory instead of one block per process.
- The generated `dag.mmd` contains nested `subgraph` blocks; the UI parser ignores them, so nothing to do.
- **Read `tests/nextflow.config` too** — nf-test configs often carry `ext.*` overrides the subworkflow silently depends on (e.g. `fastq_align_hisat2` sets `SAMTOOLS_SORT` `ext.prefix = { "${meta.id}.sorted" }` so the sorted BAM doesn't share a name with the aligner's BAM). Copy the ones that matter into `wrapper/nextflow.config`.
- When the subworkflow needs an index/splice-sites/reference it does not build itself, `include` the modules that make them **directly from the wrapper dir**: the path to the shared modules root is `../../../../modules/<provider>/<tool>/main.nf` (one level deeper than the subworkflow's own `../../../modules/...`). See `fastq_align_hisat2/wrapper/main.nf` for the extractsplicesites → build → subworkflow chain.
- Make a second read file optional when the tool handles single-end: declare `reads_2` `required: false`, and build `single_end` from `!params.reads_2` — then smoke-test **both** branches (drop `reads_2` in a temp params file); they exercise different code.
- **Don't trust a `take:` comment for channel shape — check each consumer.** In `quantify_pseudo_alignment` the `index` comment says "path", which holds for Salmon but Kallisto's index input is `tuple(meta, index)`; passing a bare path failed with "Input tuple does not match tuple declaration". Read the `input:` of every module the subworkflow calls with that channel.
- **`val` inputs can't be `null`.** Nextflow aborts ("input channel evaluates to null"). nf-test may pass `null` only for the branch it exercises. Pass `''` (or a real default) for unset optional values, and let the module's own check produce the error when the value is actually needed.
- **A subworkflow that branches on a value** (`pseudo_aligner == 'salmon'`) needs the wrapper to build only the matching prerequisite (an `if` in the workflow block that calls one index module or the other) and one smoke test **per branch**. Expose the branch selector as an `enum` option.
- **Choose test data that satisfies the whole chain, not just the first step.** The sarscov2 GTF has no `transcript_id`/`gene_name`, which tx2gene needs; use the data the subworkflow's own test uses (here `homo_sapiens`) even when it is larger.
- A `withName: 'A|B|C'` selector works for publishing several processes at once; Nextflow may print a harmless "no process matching config selector" warning for alternatives that did not run.
- **Very wide subworkflows** (`fastq_qc_trim_filter_setstrandedness` has ~30 `take:` inputs): expose only what changes what the user gets, fix the rest to the value the nf-core pipeline uses, and say in the `wrapper.yaml` comment what is deliberately *not* exposed and why (no test data to verify BBSplit/rRNA/UMI paths). Don't expose a branch you cannot smoke-test. Pass `channel.empty()` for optional file inputs that are unused, and `error` up front when an option needs them (`auto` strandedness without a genome).
- **Results that live only in a `meta` map are not files** — the inferred strandedness was invisible on disk. Add the file yourself: `.collectFile(name: 'x.tsv', storeDir: "${params.outdir}/<name>", seed: '<header>', newLine: true)` (no trailing `\n` in `seed` — `newLine` adds one, and a second gives a blank line).
- **Copy the ext/publish overrides from the real pipeline** (`resources/wrappers/workflows/rna-seq/conf/modules/*.config`) as well as `tests/nextflow.config`: it shows which aliased instances need distinct `ext.prefix` (`FASTQC_RAW` vs `FASTQC_TRIM`, the several `FQ_LINT_AFTER_*`) so their published files don't overwrite each other.
- **Nextflow 26 strict syntax**: no closures assigned to local variables and then called (`def f = { … }; f(x)` → "`f` is not defined"). Use a top-level `def name(arg) { … }` function in `main.nf` instead.
- **Check numbers against the nf-test, not just exit code 0.** The subworkflow's own `tests/main.nf.test` asserts concrete outcomes (e.g. `fastq_remove_rrna`: 4159 pairs kept, SortMeRNA flags 20 reads, RiboDetector keeps 4162). Build a fixture that reproduces the nf-test's input and compare — a wrapper can "succeed" while removing nothing. When the nf-test assembles its input in a `setup { run("CAT_FASTQ") … }` step, you can usually recreate it once as a local fixture (`cat a.fastq.gz b.fastq.gz > c.fastq.gz` is a valid gzip; use `gzip -dc`, not `zcat`, on macOS).
- **One `withName` with a broad `pattern` can publish junk.** `SAMTOOLS_FASTQ` also emits empty `*_other`/`*_singleton` files; list the process's `output:` globs and give each publisher only the files you want, using separate `withName` blocks where they differ.
- A subworkflow with **alternative tools behind an `enum`** (`sortmerna` / `ribodetector` / `bowtie2`) needs a smoke test per tool, plus single-end vs paired-end for each that differs, and an up-front `error` when the chosen tool needs a file that wasn't given. Emulated (amd64-on-arm64) images can be slow: run long variants in the background and don't poll — a foreground Bash call is capped at 10 minutes.
- Subworkflows whose `take:` needs several coordinated inputs (indexes, GTF, strandedness) are the hard ones — decide which inputs the wrapper builds internally (compose the index-building module, like `star/align`) versus exposes, and keep the public params to the few a user would really change.

## Full pipelines (`workflows/` tier) — rare, read the design doc first

A complete vendored nf-core pipeline (e.g. `resources/wrappers/workflows/rna-seq/`) gets the same `wrapper/` adapter, but `wrapper/main.nf` is the pipeline's own real entrypoint copied one directory deeper (not hand-rewritten — relative `include` paths are mechanically adjusted from `./...` to `../...`), and `wrapper.yaml`'s `params` table is a deliberately small, curated subset of the pipeline's full `nextflow_schema.json` surface (100+ params typically exist; expose only the handful an agent would plausibly set — inputs, `outdir`, and any headline options like an aligner choice). This tier is exceptional — most wrapper work is a single module. See `resources/wrappers/workflows/rna-seq/wrapper/` and design doc section 4 ("Extended with a third root...") before attempting one.

## Common pitfalls

- **Editing the wrong checkout or expecting a source edit to appear immediately** — author in phi-packages, then build and explicitly install/update its package.
- **Inventing test data** instead of using a `tests/data/` fixture or the module's own nf-core test-datasets URL.
- **A `params.json` that fails validation** — the "every distributed wrapper passes validation" test names the wrapper and the problem.
- **Guessing the channel shape** instead of reading `tests/main.nf.test`'s `input[N] = ...` values.
- **Surfacing every module parameter** as a wrapper param — keep the contract small; hard-code sane defaults for anything the agent doesn't need to touch (document the choice in a comment, like `fastp/wrapper/wrapper.yaml` does).
- **Editing the vendored `../main.nf`** to make the adapter simpler — always adapt around it instead.
- **Nesting a wrapper inside another wrapper** — compose vendored modules/subworkflows directly (see star/align), never `include` another `wrapper/main.nf`.
- **Missing the `profiles {}` boilerplate** in `nextflow.config` — `wrapper_run` needs `docker`/`singularity`/`conda` all defined.
- **Leaving `work/`, `.nextflow*`, or `results/` behind** after the step-6 smoke test — clean up before committing.
