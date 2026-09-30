# visualization

Bundled visualization plugin:

- `agents/Visualization.md` — the Visualization specialist
- `skills/omics-visualization/` — figure templates and scripts
- `environments/viz/` — the R and Python environment those scripts run in (`plugin:viz`)

Until the plugin loader lands (implementation plan step 6), Phi loads this directory with the temporary built-in loader: its agents and skills are registered as bundled content, and `plugin:<name>` resolves to the plugin environment directory.
