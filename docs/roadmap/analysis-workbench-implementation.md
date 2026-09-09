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

## Notebook Capability Task Breakdown

This section decomposes the full notebook workbench into implementation tasks that can be completed and reviewed independently. Each stage should produce a working app state; avoid carrying half-wired runtime paths across stages.

### N0: Static Notebook Shell

Status: complete.

Deliverables:

- Add the Analysis activity-bar entry.
- Render the Marimo-inspired notebook shell with left chat rail, center notebook canvas, and right inspector.
- Use representative mock cells, variables, files, and artifacts only.
- Add component coverage that proves the first-phase shell renders.

Boundaries:

- No Jupyter Server.
- No `.ipynb` reads or writes.
- No kernel execution.
- No new runtime dependency.

Verification:

- Component test for the shell landmarks.
- `npm run lint`.
- `npm run typecheck`.
- `npm run build`.

### N1: Notebook Document Model

Status: complete.

Deliverables:

- Add a typed notebook document model for standard `.ipynb` files.
- Parse and normalize notebook cells, metadata, outputs, execution count, and cell ids.
- Preserve unknown notebook fields and `metadata.phi` without destructive rewrites.
- Add pure helpers for insert, update, move, delete, clear output, and notebook revision hashing.

Boundaries:

- Main/renderer only use the model through typed helpers.
- Do not start kernels.
- Do not write project files yet unless the user explicitly saves through a later service.

Verification:

- Unit tests with minimal Python and R notebook fixtures.
- Round-trip tests that preserve unknown fields.
- Mutation tests for cell order, cell ids, and output clearing.

### N2: Project Notebook Registry

Status: complete.

Deliverables:

- Discover `.ipynb` files under the active project cwd with path safety checks.
- Show real project notebooks in the Analysis left rail.
- Add explicit initialization for `notebooks/`, `outputs/`, and optional analysis config.
- Keep project add/import side-effect free.

Boundaries:

- Discovery is local only.
- Do not auto-create project directories on project selection.
- Do not scan bulky ignored directories by default.

Verification:

- Tests for safe path validation and ignored directories.
- Regression test that adding a project does not mutate the project directory.
- Renderer test for empty, loading, and populated notebook lists.

### N3: Notebook Open/Save Service

Status: complete.

Deliverables:

- Add main-process service APIs for open notebook, save notebook, close notebook, and create notebook.
- Expose typed preload methods and renderer state for active notebook content.
- Wire the center notebook canvas to real `.ipynb` cells.
- Persist user edits only through explicit save/autosave policy chosen for this stage.

Boundaries:

- No kernel execution.
- No agent notebook editing tools yet.
- No raw renderer filesystem writes.

Verification:

- Main-process service tests with temporary project files.
- IPC tests with fake service responses.
- Manual smoke test: create/open/edit/save/reopen a notebook.

### N4: Local Kernel Discovery And Session Lifecycle

Status: in progress. Kernel discovery and diagnostics are complete; local server/session lifecycle remains pending.

Deliverables:

- Detect local Jupyter availability and kernelspecs for Python and R.
- Start a local Jupyter Server per project on `127.0.0.1`.
- Manage one Jupyter session/kernel per open notebook.
- Surface kernel missing, idle, busy, restarting, disconnected, and error states.

Boundaries:

- Do not auto-install Python, R, Jupyter, or IRkernel.
- Do not expose Jupyter tokens or raw server URLs to renderer state.
- Local only; no SSH tunnel.

Verification:

- Unit tests for kernelspec normalization and missing-tool diagnostics.
- Server registry lifecycle tests with fakes.
- Manual smoke test against local Python kernel; optional R kernel smoke test.

### N5: Cell Execution And Output Rendering

Deliverables:

- Run selected cell, run current-and-select-next, run all, interrupt, restart, and clear output.
- Render stdout, stderr, execute result, display data, errors, Markdown, small tables, and static images.
- Fold long output and bound table previews.
- Persist lightweight outputs back into `.ipynb`.

Boundaries:

- Interactive HTML/JS is saved as an artifact, not injected into the main React tree.
- Execution remains standard Jupyter order-based execution, not reactive execution.
- No workflow or Nextflow execution from notebook magic.

Verification:

- Component tests for output renderers.
- Service tests for execution state transitions with fakes.
- Manual smoke test: run, save, close, reopen, and confirm outputs.

### N6: Variables And Data Preview

Deliverables:

- Add Python and R inspection snippets for runtime variables.
- Show name, type/class, shape/length, schema, missingness, head/sample, and cheap summaries.
- Add bounded Data Preview inside the Variables tab.
- Refresh after cell execution and on manual refresh; clear on kernel restart.

Boundaries:

- Do not continuously poll kernels.
- Do not implement editable DataFrame grids.
- Treat AnnData, Seurat, mass spectrometry, and spatial objects as later extension points.

Verification:

- Parser tests for Python and R inspector responses.
- Payload limit tests for large tables.
- Manual smoke tests for pandas DataFrame and R data.frame/tibble.

### N7: Agent Notebook Transactions

Deliverables:

- Add agent-facing typed tools for outline, read cell, insert, update, move, run, read output, inspect variable, and export artifact.
- Record cell-level transaction summaries in chat/timeline.
- Add optimistic concurrency using cell id, content hash, and notebook revision.
- Add conflict UI when human edits race with agent edits.
- Add undo for the latest agent transaction.

Boundaries:

- Agent tools use notebook APIs, not raw JSON edits.
- Project `ask` mode gates risky notebook mutations through existing approvals.
- Do not allow silent overwrites after stale reads.

Verification:

- Transaction apply/rollback tests.
- Conflict detection tests.
- Tests that agent-triggered execution emits timeline events and respects permission mode.

### N8: Artifact Viewer

Deliverables:

- Register notebook artifacts by notebook path, cell id, type, hash, created time, size, and URI.
- Save large or interactive outputs as artifacts.
- Render HTML artifacts in sandboxed iframes.
- Provide preview/open, reveal, and copy-path actions.

Boundaries:

- Read-only artifact viewing first.
- No two-way plot selection bridge.
- Remote artifacts remain URI references until the remote stage.

Verification:

- Artifact registry tests.
- Iframe sandbox component tests.
- Manual Plotly or equivalent HTML artifact smoke test.

### N9: Workflow Runner Bridge

Deliverables:

- Discover Nextflow workflows and configs.
- Model local workflow runs and output artifacts.
- Let notebooks launch/reference/inspect workflow runs through explicit UI/actions.
- Keep Nextflow as a separate workflow surface, not hidden notebook behavior.

Boundaries:

- Local-only first.
- Prefer nf-core/DSL2 conventions.
- No remote execution in this stage.

Verification:

- Workflow discovery and run metadata tests.
- Manual tiny Nextflow workflow smoke test when Nextflow is installed.

### N10: Remote/HPC Execution

Deliverables:

- Add SSH host profiles under Phi-owned state.
- Add explicit local/remote path mappings.
- Run remote workflow commands through the controlled workflow runner.
- Tail/read remote logs by bounded requests.
- Preview small remote artifacts by explicit temporary cache download.
- Register remote artifacts as remote URIs.

Boundaries:

- Do not automatically sync remote data to local project directories.
- Do not make arbitrary remote shell the primary product surface.
- Remote interactive notebooks remain deferred unless a later decision reverses that.

Verification:

- Redaction and profile validation tests.
- Faked SSH command construction and log parsing tests.
- Manual smoke test against a trusted SSH target before beta exposure.

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
