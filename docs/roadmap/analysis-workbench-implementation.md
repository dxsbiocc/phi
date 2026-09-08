# Phi Analysis Workbench Implementation Roadmap

Date: 2026-09-06

This roadmap is downstream of `docs/decisions/analysis-workbench.md`. It should not compete with the current internal beta roadmap. The internal beta still prioritizes reliable project-bound sessions, approvals, durable timeline state, resource visibility, and local history. Analysis workbench implementation should begin only as a small, roadmap-backed extension of those foundations.

## Phase 0: Design And Spike

Goal: prove the local Jupyter integration shape without committing to a broad UI rewrite.

- Add a short technical spike that starts a local Jupyter Server from the main process on `127.0.0.1`.
- Detect whether `jupyter server` and usable Python/R kernelspecs are available.
- Use a temporary project notebook to run one Python cell and one R cell when kernels exist.
- Verify stdout, errors, display data, PNG/SVG, and simple HTML output handling.
- Decide whether `@jupyterlab/services` is sufficient for server/session/kernel management from Electron main.
- Document missing local prerequisites without auto-installing them.
- Do not add remote execution, Nextflow, or domain-specific viewers in this phase.

Verification:

- Unit tests for kernelspec discovery normalization and missing-tool diagnostics.
- A small manual smoke test against a local Python kernel.
- Optional manual R kernel test when IRkernel is installed.

## Phase 1: Project Notebook Registry

Goal: make notebooks first-class project files while keeping Phi's storage boundaries intact.

- Add project analysis discovery that lists `.ipynb` files under user-approved project directories.
- Add explicit project analysis initialization that creates `notebooks/`, `outputs/`, and optional `.phi/analysis.json`.
- Store project analysis preferences in Phi-owned project state or explicitly created `.phi/analysis.json`, never on project add.
- Add the current notebook reference to the Phi session manifest or timeline events.
- Preserve standard notebook JSON and write Phi-only fields under `metadata.phi`.
- Add path safety checks mirroring current project/session file boundaries.

Verification:

- Unit tests for project notebook path validation.
- Unit tests for registry read/write without creating project `.phi/` implicitly.
- Regression test that adding a project still does not modify the project directory.

## Phase 2: Notebook Service In Main Process

Goal: own notebook file operations and kernel lifecycle behind typed IPC.

- Add a main-process analysis service for opening, saving, and closing notebooks.
- Manage one Jupyter Server per project and one Jupyter session/kernel per open notebook.
- Expose typed preload APIs for list notebooks, open notebook, save notebook, list kernels, select kernel, start/restart/interrupt/shutdown kernel, and close notebook.
- Keep Jupyter token and server URLs out of renderer state except for safe opaque ids.
- Record notebook lifecycle events in the Phi session timeline.
- Stop project Jupyter servers on app exit.

Verification:

- Unit tests for server registry lifecycle with fakes.
- Unit tests for notebook open/save and metadata preservation.
- Integration-style tests for IPC shape using fake services.

## Phase 3: Notebook UI

Goal: provide a usable notebook-first interface inside Phi.

- Add an `analysis` view to the activity bar.
- Build a notebook list for the current project.
- Build a cell list editor for Markdown and code cells.
- Support add, update, move, delete, run cell, run all, clear output, interrupt, restart, and kernel status.
- Keep chat available as a side panel or companion panel rather than replacing the notebook.
- Render stdout, stderr, errors, Markdown, images, and lightweight table outputs.
- Persist lightweight outputs in `.ipynb`.
- Save large or interactive outputs as project/session artifacts with references.

Verification:

- Component tests for cell editing and output rendering.
- Manual smoke test for creating a notebook, running a cell, saving, closing, and reopening.
- Visual check that long output, table preview, and HTML artifact links do not break layout.

## Phase 4: Agent Notebook Tools

Goal: let the agent collaborate through structured notebook APIs instead of raw JSON edits.

- Add agent-facing tools for read notebook outline, read cell, insert cell, update cell, move cell, run cell, read output, inspect variable, and export artifact.
- Record every agent notebook edit as a cell-level transaction.
- Add optimistic concurrency with cell id, content hash, and notebook revision.
- Prevent silent overwrites when a human changed the cell after the agent read it.
- Add undo for the last agent transaction.
- Reuse Phi run ids, approval events, and session timeline for agent-triggered cell execution.
- In project `ask` mode, gate risky agent notebook operations through the existing approval model.

Verification:

- Unit tests for transaction application and rollback.
- Unit tests for optimistic concurrency conflict detection.
- Tests that agent-triggered execution emits run/timeline events and respects project permission mode.

## Phase 5: Variable Inspector And Data Preview

Goal: give humans and agents enough runtime context for exploratory analysis without moving large data through the UI.

- Add kernel-side inspection snippets for Python and R.
- Support pandas DataFrame, R data.frame, and tibble summaries.
- Return variable name, type, shape, schema, missingness, head, and summary statistics.
- Add a Data Preview panel with pagination or bounded sampling.
- Limit default row counts and payload size.
- Provide explicit export actions for CSV/Parquet/RDS where available.
- Treat specialist objects as plugin extension points rather than core first-phase scope.

Verification:

- Unit tests for inspector response parsing.
- Manual smoke tests for pandas and R data.frame previews.
- Payload limit tests for large table previews.

## Phase 6: Artifact Viewer

Goal: safely view interactive and heavy outputs generated by notebooks.

- Save interactive HTML/JS outputs as artifacts rather than injecting raw HTML into Markdown.
- Render HTML artifacts in sandboxed iframes.
- Provide reveal/open actions for artifacts.
- Register artifacts with notebook path, cell id, type, hash, created time, and local or remote URI.
- Keep the first implementation read-only: no selection feedback bridge into kernel or agent.

Verification:

- Unit tests for artifact registry entries.
- Component tests for iframe sandbox attributes.
- Manual smoke tests for Plotly or equivalent HTML output.

## Phase 7: Workflow Runner Foundation

Goal: prepare Nextflow integration as a separate workflow surface.

- Add project workflow discovery for `nextflow.config`, `workflows/*.nf`, and project registry entries.
- Model a workflow run as workflow path, profile, params file, output directory, work directory, revision/hash, started/finished time, exit code, and log/report paths.
- Build a local-only Nextflow runner first.
- Register run outputs as artifacts.
- Keep notebook integration to launch/reference/inspect runs; do not execute workflow magic inside hidden notebook behavior.
- Prefer nf-core/DSL2 module conventions for generated workflow code.

Verification:

- Unit tests for workflow discovery and run metadata.
- Manual local Nextflow smoke test with a tiny workflow when Nextflow is installed.

## Phase 8: Remote Workflow Execution

Goal: support HPC-oriented execution without syncing large datasets to the local machine.

- Add global SSH host profiles under `~/.phi`.
- Let project analysis config reference profile ids and explicit local/remote path mappings.
- Run remote workflow commands through a controlled workflow runner.
- Read remote logs by bounded tail/range requests.
- Preview remote small artifacts through temporary cache downloads.
- Register remote artifacts as remote URIs.
- Do not build an arbitrary remote shell panel as the primary product surface.
- Do not automatically sync remote data back to local project directories.

Verification:

- Unit tests for profile reference validation and redaction.
- Faked SSH tests for remote command construction and log parsing.
- Manual smoke test against a trusted SSH target before beta exposure.

## Deferred

- Remote interactive notebooks and remote Jupyter kernels.
- SSH tunnel management for Jupyter Server.
- Two-way interactive plot selection bridge.
- Full object browser or editable DataFrame grid.
- AnnData, Seurat, spatial transcriptomics, mass spectrometry, and IGV panels.
- Automatic Python/R/conda/renv/kernel installation.
- Full nf-core module installation and update management.
- Arbitrary remote shell as a primary UI.

## Implementation Guardrails

- Keep the internal beta roadmap in force. Do not start analysis work before the session/runtime/approval/storage foundations it depends on are stable.
- Add no new dependency without a concrete phase task and review of the package surface.
- Keep renderer unprivileged: no direct process spawning, no raw Jupyter tokens, no direct filesystem writes outside approved APIs.
- Prefer typed IPC and main-process services for all kernel, file, artifact, workflow, and remote operations.
- Keep notebook files standard and portable.
- Preserve current project safety: project operations remain bound to cwd and permission mode.
- Verify each phase with tests and at least one local manual smoke test before expanding the surface.
