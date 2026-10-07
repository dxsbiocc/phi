# visualization

Bundled visualization plugin:

- `agents/Visualization.md` — the Visualization specialist
- `skills/omics-visualization/` — figure templates and scripts
- `resources/runtime/environments/phi-r/` — the built-in R/Python environment used by the
  agent and skill (`phi:r@1`)

The plugin declares no private managed environment. Its scripts use the shared built-in
`phi:r@1` environment, which provides both `python` and `Rscript`.
