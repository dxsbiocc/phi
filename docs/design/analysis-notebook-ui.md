# Analysis Notebook UI Spec

Date: 2026-09-09

This spec captures the first-phase notebook analysis interface for Phi. It sits under the broader analysis workbench decision record and should remain aligned with the internal beta goal: a reliable local desktop workbench with clear project boundaries, recoverable local state, and understandable approvals.

The first UI milestone is a local notebook workbench shell. It should make `.ipynb` analysis feel native in Phi without turning the app into a full JupyterLab, RStudio, or omics platform.

## Layout

The analysis view uses a three-region desktop layout:

```text
Activity Bar | Left Rail                | Notebook Canvas             | Right Inspector
             | Chat / Notebooks         | rendered notebook cells      | Files / Variables / Artifacts
```

- The existing Activity Bar remains the global app navigation and gains an Analysis entry.
- The left rail is collapsible and scoped to the current analysis context.
- The center canvas is reserved for the active notebook.
- The right inspector is collapsible and uses tabs for analysis context.
- The layout should prefer notebook readability over permanently visible side panels.

## Left Rail

The left rail replaces the normal conversation/sidebar emphasis while in Analysis mode.

- It has a lightweight top switch with `Chat` and `Notebooks`.
- It defaults to `Chat`.
- `Chat` shows the current project/session conversation bound to the active notebook.
- `Notebooks` lists project notebooks and lets the user switch the active notebook.
- When collapsed, the rail leaves a narrow state affordance for agent activity, approval-needed state, and unsaved notebook state.
- The rail should not become a general file browser; file browsing belongs in the right inspector.

Chat context is explicit:

```text
Context: notebooks/exploration.ipynb · Cell 8
Scope: Selected cell / Notebook / Project
```

- Default scope is the selected cell plus recent outputs.
- If no cell is selected, the default scope is the current notebook summary.
- Users can widen scope to the notebook or project.
- Prompt chips may reference selected cells, variables, artifacts, or files.
- Agent notebook changes leave concise transaction records in chat.

## Notebook Canvas

The center canvas is notebook-first and visually closer to a clean document editor than a dense IDE.

- The active `.ipynb` is the only notebook shown in phase one.
- Notebook cells form a readable vertical document flow.
- Cell outputs appear directly under their source cell.
- Cell controls stay low-noise until hover, focus, running, or error states.
- The canvas should not be used for chat, file trees, workflow dashboards, or global settings.

### Header

The notebook header is compact:

```text
notebooks/exploration.ipynb    Python 3.11 · Idle · Saved    Run all | Interrupt | Restart | ...
```

It shows:

- Notebook path.
- Kernel name.
- Kernel state: idle, busy, restarting, disconnected, missing, or error.
- Save state: saved, unsaved, saving, or save failed.
- Core actions: run all, interrupt, restart.
- Secondary actions in a menu: select kernel, clear all outputs, export, close kernel, reveal file.

Kernel diagnostics should be visible from the header when a kernel is missing or unavailable. Users should not have to search settings to understand why execution is unavailable.

## Cells

Cells have four visual modes:

- `Read`: document-like, low chrome, focused on content and outputs.
- `Hover`: shows run button, cell type, and a compact action menu.
- `Focus/Edit`: shows editing affordances, selected border, cell toolbar, and language or kernel hint.
- `Running/Error`: shows prominent execution state, spinner or progress marker, and error summary.

The visual style should borrow Marimo's calm notebook feel: clean cell surfaces, minimal persistent chrome, natural document flow, and visible runtime context. Phi should not adopt Marimo's reactive execution model in phase one; execution remains standard Jupyter order-based execution.

### Cell Gutter

Each cell has a narrow gutter for:

- Run button.
- Execution count or stale/unexecuted marker.
- Running, success, warning, or error state.
- Agent-modified marker when applicable.

Agent markers are subtle. Hovering or clicking the marker shows the cell-level transaction summary and a path to view before/after changes or undo the latest agent transaction.

### Cell Actions

Phase-one actions:

- Run cell.
- Insert cell above.
- Insert cell below.
- Change cell type between Markdown and code.
- Move cell up/down.
- Delete cell.
- Clear cell output.
- More menu for less common actions.

Deletion should be easy to undo and should require extra care when the cell was human-authored or recently modified.

## Outputs

Cell output handling follows a split between lightweight notebook output and heavy artifacts.

- Short text, small errors, small tables, and small static images render inline.
- Long stdout/stderr is folded by default.
- Large tables render as bounded previews.
- Interactive HTML/JavaScript outputs are saved as artifacts and displayed through a sandboxed artifact viewer.
- Cell output includes an "open in Artifacts" affordance for heavy or interactive outputs.
- Output rendering must not resize surrounding controls or break the notebook flow.

Raw HTML must not be injected into Markdown or the main React tree.

## Right Inspector

The first phase right inspector has exactly three tabs:

- `Files`
- `Variables`
- `Artifacts`

It is collapsible. When collapsed, it leaves a narrow tab rail or icon affordance so users can quickly reopen the last active tab.

### Files Tab

The Files tab is a project file tree with analysis-aware defaults.

- Default view shows analysis-related directories first: `notebooks/`, `data/`, `outputs/`, `reports/`, and `workflows/`.
- Users can switch to the full project tree.
- Common noise is hidden by default: `.git`, `node_modules`, `.nextflow`, cache directories, and bulky tool internals.
- Supported actions: open notebook, preview supported small files, reveal path, copy path.
- Phase one does not include complex Git controls or bulk file operations.

### Variables Tab

The Variables tab shows kernel state summaries.

- It refreshes after cell execution.
- It clears on kernel restart.
- It does not continuously poll.
- It has a manual refresh action.
- Slow inspections show stale state and last refreshed time.

The first implementation supports summary-level inspection:

- Variable name.
- Type/class.
- Shape or length.
- DataFrame/tibble column names and types.
- Missingness summary.
- Bounded head/sample preview.
- Basic summary statistics when cheap.

Data Preview is a subview inside Variables, not a separate top-level tab. It is a preview, not an editor.

### Artifacts Tab

The Artifacts tab is organized by source, not by raw folder structure:

```text
Artifacts
- notebooks/exploration.ipynb
  - Cell 8: pca_plot.html
  - Cell 12: cluster_umap.png
  - Cell 15: qc_table.csv
```

Each artifact item shows:

- Name.
- Type: HTML, image, table, report, or other.
- Source notebook and cell.
- Created time.
- Size when known.
- Preview/open action.
- Reveal and copy path actions.

Remote artifacts can be represented later as remote URIs, but remote artifact browsing is not part of the first UI milestone.

## Chat And Agent Behavior

The chat panel is a collaboration surface for the active notebook.

- It should never obscure the notebook canvas by default.
- It clearly shows the current context and scope.
- Agent actions against notebooks happen through structured notebook APIs.
- Agent changes are recorded as cell-level transactions.
- The UI exposes transaction summaries, diff review, and undo for agent-authored changes.
- If a cell changed after the agent read it, the UI shows a conflict state instead of allowing a silent overwrite.

## Responsiveness

Phi is a desktop app. The first phase does not need a full mobile notebook experience.

- Wide desktop: left rail, notebook canvas, and right inspector can be visible together.
- Medium width: left and right rails are independently collapsible.
- Small windows: notebook canvas wins; side panels become drawers.
- Header controls collapse secondary actions into a menu.
- Text, buttons, cell controls, and outputs must not overlap at narrow widths.

## Keyboard

Do not build a full command palette in phase one.

Phase-one shortcuts:

- `Shift+Enter`: run current cell and select next.
- `Cmd/Ctrl+Enter`: run current cell.
- `Esc`: leave edit mode for command mode.
- `Enter`: enter edit mode from command mode.
- `A`: insert cell above in command mode.
- `B`: insert cell below in command mode.
- `D D`: delete selected cell with undo or lightweight confirmation.

Shortcut hints should appear in menus or tooltips, not as permanent instructional text across the interface.

## Phase-One Non-Goals

- Multi-notebook tabs.
- Side-by-side notebook comparison.
- Remote interactive notebooks.
- Remote Jupyter kernels.
- Nextflow run dashboard.
- Full command palette.
- Full RStudio environment/history/packages panes.
- Editable DataFrame grid.
- Two-way selection bridge from interactive plots back into kernel or agent.
- Specialist omics viewers such as AnnData, Seurat, spatial transcriptomics, mass spectrometry, or IGV panels.

## Acceptance Criteria For Static Shell

Before connecting real Jupyter execution, the static UI shell is acceptable when:

- Analysis appears as a first-class app view.
- The left rail can switch between Chat and Notebooks and can collapse.
- The notebook header shows path, kernel state, save state, and core run controls.
- The notebook canvas renders representative Markdown, code, running, error, and output cells.
- The right inspector switches between Files, Variables, and Artifacts.
- Side panels collapse correctly at constrained widths.
- The UI contains no raw HTML injection path.
- Visual density remains closer to a readable notebook than a dense IDE.

## Implementation Notes

- Implement `AnalysisView` as a separate renderer component rather than extending `ChatView`.
- Keep existing chat components reusable inside the left rail where practical.
- Add typed IPC only when backing main-process services exist or are faked in tests.
- Prefer stable layout dimensions for gutters, headers, tab rails, and action buttons.
- Keep icons in controls and put explanatory text in tooltips or menus.
- Do not add new runtime dependencies for the static shell unless the implementation step explicitly justifies them.
