# Phi Analysis Workbench Decisions

Date: 2026-09-06

Phi should grow into a project-bound data analysis workbench for Python, R, and later bioinformatics workflows. The first useful version should prove a tight interactive analysis loop: open a project notebook, edit and run cells manually, let the agent inspect results and modify cells through structured APIs, and keep outputs visible without losing the current internal-beta safety model.

This is intentionally not a decision to turn Phi into a full JupyterLab, RStudio, or workflow platform in one step. The analysis workbench should extend the existing project/session/run model and keep the internal beta focused on reliable local work.

## Product Position

- The primary analysis surface is notebook-first. Chat is a collaborative side panel and command surface, not the only place where analysis state lives.
- Project scripts, notebooks, workflows, and reports belong to the project working directory, not the Phi conversation history.
- Phi session storage is for run state, timeline events, transient previews, tool output, and references to project artifacts.
- The first phase supports local `.ipynb` notebooks with Python and R kernels. Remote interactive notebooks, Nextflow workflow running, and domain-specific omics viewers are later phases.

## Notebook Format

- Standard Jupyter `.ipynb` is the primary file format.
- `.py` and `.R` scripts remain supported as auxiliary project files for reusable functions, batch scripts, and workflow glue code, but they are not the default interactive analysis unit.
- Phi may write non-invasive metadata under `metadata.phi`, but notebooks must remain usable in JupyterLab, VS Code, and other standard notebook tools if that metadata is removed.
- Notebook files default to project paths such as `notebooks/exploration.ipynb`.
- Agent edits should update or append cells in the current notebook instead of creating repeated `v1/final/revised` notebook copies.

## Project And Session Boundaries

- The project working directory is the durable source of truth for analysis code and committed artifacts.
- `~/.phi/sessions/{sessionId}/` stores Phi timeline state, run events, temporary previews, and local tool output.
- Project-level analysis configuration may be written to `.phi/analysis.json`, but only through an explicit initialization or resource action. Adding a project must not create project files.
- Phi-owned global settings, credentials, remote host profiles, and project defaults remain under `~/.phi`.
- The current session manifest may record which notebook is open, which artifacts were referenced, and which execution events occurred, but it must not become the durable owner of project analysis code.

## Human And Agent Editing

- Humans should interact with notebooks like a normal notebook environment: create cells, edit code, execute selected cells, clear output, restart or interrupt kernels, and inspect variables.
- Agents must not hand-edit notebook JSON directly. They should use structured notebook operations such as read notebook, insert cell, update cell, move cell, run cell, inspect variable, and export artifact.
- Agent modifications are applied as cell-level transactions with before/after summaries.
- Small agent changes may be written directly; large notebook rewrites should present a notebook-level plan or diff first.
- Undo should operate at the agent transaction level.
- Agent updates use optimistic concurrency. Each update is based on a stable cell id plus a content hash or notebook revision, and must not overwrite a cell changed by the user after the agent read it.
- Agent deletion of human-authored cells is high risk and should require explicit intent or approval.

## Execution Model

- Phi should use a local Jupyter Server managed by the main process for the first implementation.
- Servers are scoped per project. Notebook sessions and kernels are scoped per notebook.
- Kernels are discovered from the user's existing Jupyter kernelspecs. Phi provides diagnostics and installation guidance when Python or R kernels are missing, but does not manage environments in the first phase.
- The notebook's kernelspec wins over the project preferred kernel. The project preferred kernel wins over app defaults when creating a new notebook.
- Renderer code must not spawn kernels or receive raw Jupyter tokens. All notebook and kernel actions go through typed preload IPC and main-process services.
- Human-triggered cell execution runs immediately and records lightweight notebook events.
- Agent-triggered execution must reuse Phi's run, timeline, and approval model. Project `ask` mode still gates risky operations.

## Outputs And Artifacts

- Lightweight outputs can be saved in the `.ipynb` file: short text, small tables, small static images, errors, and analysis notes.
- Heavy outputs are stored outside the notebook under project output directories or Phi-managed temporary/session storage, with notebook previews and references.
- Interactive HTML or JavaScript visualizations are saved as artifacts and rendered in a sandboxed iframe. Raw HTML is not injected into Markdown or the main React tree.
- The sandboxed iframe should avoid privileged Electron or Node access. Any future two-way bridge must be explicit, narrow, and event-based.
- The first phase supports front-end interaction with HTML artifacts, but not selection or interaction state flowing back into the kernel or agent.

## Variable And Data Inspection

- The first variable inspector is summary-level, not a full object browser.
- Core support covers pandas DataFrame, R data.frame, and tibble summaries: shape, column names, column types, missingness, head, and basic summary statistics.
- Large objects return summaries, schemas, pagination, or samples by default.
- Domain objects such as AnnData, Seurat, SummarizedExperiment, GenomicRanges, mzML, BAM, and VCF are added by later specialist inspectors.
- The agent receives notebook outline, selected/recent cell context, variable summaries, and artifact indexes by default. Full historical outputs or heavy artifacts are read only on demand.

## Data And Artifact Registry

- Phi should provide a lightweight project data/artifact registry, not a full data management platform.
- The registry records paths, types, labels, provenance, source notebook/cell, source workflow run, and timestamps.
- The registry should be useful to the agent but disposable from the notebook's perspective. If it is missing, notebooks and workflows should still run.
- Phi must not move, rename, delete, or deeply index user datasets unless explicitly asked.
- Large local or remote datasets are represented by metadata and path references, not copied into app storage.

## Nextflow And Bioinformatics Scope

- Nextflow is an independent workflow runner surface, not a hidden notebook feature.
- Notebooks can launch, reference, inspect, and explain workflow results, but Nextflow execution should happen through a workflow runner with recorded workflow path, params, profile, revision/hash, output directory, logs, reports, trace, and exit status.
- Workflow code should live in project directories such as `workflows/`, `modules/`, `subworkflows/`, and `conf/`.
- Prefer nf-core/Nextflow DSL2 conventions and reusable module style. Phi should not invent a private bioinformatics module system.
- Container or Apptainer execution is preferred for production and HPC. Conda or mamba can be a fallback. System PATH execution is for local development and debugging.
- Single-cell, spatial transcriptomics, mass spectrometry, and genome browser panels should be added as specialist plugins or workbench panels after the base notebook and artifact system is reliable.

## Remote Execution

- First phase remote support is deferred. Local notebooks and local kernels come first.
- Remote execution should begin with controlled workflow/job running, not an arbitrary remote shell product surface.
- SSH credentials and host profiles live in Phi global configuration. Project configuration only references host profile ids and explicit path mappings.
- Remote data and results stay remote by default. Phi reads logs, metadata, and small previews over SSH/SFTP and downloads files only when explicitly requested.
- Remote artifacts can be registered as URIs such as `ssh://profile-id/path/to/result.html`.
- Remote interactive notebooks can be a later phase once SSH tunnels, remote Jupyter tokens, path mapping, kernel lifecycle, disconnection recovery, and preview caching are designed.

## Suggested Explicit Project Structure

Phi may offer an explicit "initialize analysis project" action that creates a structure like:

```text
project/
  notebooks/
    exploration.ipynb
  scripts/
    python/
    r/
  data/
    raw/
    processed/
    references/
  workflows/
    main.nf
    nextflow.config
    modules/
    subworkflows/
    conf/
  results/
  reports/
  docs/
    analysis-log.md
```

This action must be explicit and approval-gated in project `ask` mode. It must not run automatically when a project is added.

## References

- Jupyter messaging protocol: https://jupyter-client.readthedocs.io/en/stable/messaging.html
- JupyterLab services package: https://jupyterlab.readthedocs.io/en/stable/api/modules/services.html
- Nextflow executors: https://www.nextflow.io/docs/latest/executor.html
- Nextflow configuration profiles and process configuration: https://www.nextflow.io/docs/latest/config.html
- nf-core DSL2 module terminology: https://nf-co.re/docs/usage/getting_started/terminology
- nf-core/modules repository: https://github.com/nf-core/modules
