<div align="center">
  <img src="build/icon.png" alt="Phi app icon" width="104" />
  <h1>Phi</h1>
  <p><strong>A desktop AI workbench for scientific research.</strong></p>
  <p><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>
  <p>
    <a href="https://phi.omicsagent.cn/">Website</a> ·
    <a href="https://phi.omicsagent.cn/docs">Documentation</a> ·
    <a href="https://github.com/dxsbiocc/phi-packages">Packages</a> ·
    <a href="https://github.com/dxsbiocc/phi/issues">Issues</a>
  </p>
  <p>
    <a href="#availability"><img alt="Internal beta" src="https://img.shields.io/badge/status-internal%20beta-0f766e" /></a>
    <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue" /></a>
  </p>
</div>

Phi connects an AI agent to the tools research work runs on: project files, Jupyter notebooks, managed Python and R environments, command-line pipelines, and remote servers. You ask for an analysis; the agent writes and runs it in your project, and the code and results stay there as ordinary files.

## See it work

The agent was asked to run a PCA on the Wisconsin Diagnostic Breast Cancer dataset bundled with scikit-learn. It wrote the notebook cells, ran them on Phi's managed Python kernel, and saved the notebook with its outputs.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/notebook-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/notebook-light.png">
  <img alt="A Phi notebook showing an executed PCA cell with its scatter plot of benign and malignant samples" src="assets/readme/notebook-light.png" width="100%">
</picture>

The conversation then lists what it produced, and each file opens in place. The Chinese line and tab title below are as the app produced them in this run.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/delivery-en-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/delivery-en-light.png">
  <img alt="A Phi conversation ending with the PCA plot and cards for the delivered notebook and image" src="assets/readme/delivery-en-light.png" width="100%">
</picture>

<sub>Captures from the Phi 0.1.0 desktop app, resized but otherwise unedited, with the model set to DeepSeek V4 Flash.</sub>

## What Phi does

- **Notebooks the agent can operate.** The agent reads a `.ipynb`, inserts and edits cells, runs them through Jupyter, checks the outputs, and saves. You see the same cells in the editor. Python and R kernels are managed by Phi; a host kernel must be selected explicitly.
- **Managed environments.** Versioned Python, R, Jupyter, and Nextflow environments are built on demand, so work does not depend on what the host has installed. Settings can rebuild, remove, or clean them. The first build downloads packages.
- **Conversations with explicit control.** Each conversation can be bound to a project and uses a mode: Auto, Ask, Plan, Plan and execute, or Full access. Plan modes wait for your approval before acting. Conversations keep running in the background when you switch away, and can be forked from an earlier message.
- **Plugins, Skills, connectors, and Wrappers.** A plugin bundles a specialist agent with its Skills and environment. Skills give task guidance, MCP connectors reach external services, and Wrappers describe reproducible command-line tools and pipelines. The official [Phi Packages](https://github.com/dxsbiocc/phi-packages) catalog supplies installable content.
- **Remote projects over SSH.** Files and commands in a remote project run on the host you selected and never fall back to the desktop. Wrappers can submit to Slurm. Check each host before relying on it.
- **A workbench around the conversation.** A terminal, in-app browser, file previews, and a background-jobs panel sit beside the conversation.

### Figures you can keep editing

The Visualization plugin picks a template from the catalog, writes an editable `plot.R` into your project, and renders it in the managed R environment. This heatmap came from that flow.

<p align="center"><img src="assets/readme/visualization-heatmap.png" alt="Clustered heatmap of ten mean nuclear features across twenty samples, annotated by diagnosis" width="72%"></p>

<sub>Twenty samples (ten benign, ten malignant) from the same scikit-learn dataset, chosen to demonstrate the plot rather than to support a finding. The legend title was shortened by hand in `plot.R` and the figure re-rendered.</sub>

## Your data

Settings, conversations, approvals, logs, and package state live in `~/.phi`. Project files stay in the folder you chose, and Phi does not store its application data there.

Phi is not offline. Model requests go to the provider you configure, and an enabled connector may contact its service. Exported sessions can contain tool output and sensitive conversation content, so handle them as private data.

## Availability

Phi is an **internal beta**. macOS on Apple Silicon is the primary target. Linux x64 packaging is configured but has not passed clean-machine acceptance, and Windows is not validated. Updates are manual: Settings → General → Check for updates tells you when a newer release exists.

Builds are not yet signed or notarized. Preview builds, when published, appear on the [Releases](https://github.com/dxsbiocc/phi/releases) page; none is available yet, so for now build from source. Upgrades keep your data in `~/.phi`.

- **macOS** (`.dmg`, `.zip`): drag Phi to Applications. macOS blocks the first launch with "Apple could not verify Phi". Open **System Settings → Privacy & Security** and click **Open Anyway**; you do this once per installed version.
- **Linux** (`.AppImage`, `.deb`): run `sudo apt install ./phi_*.deb`, or `chmod +x Phi-*.AppImage` and run the AppImage.

## Build from source

You need [Bun](https://bun.sh) 1.3.14 or later. The first launch fetches pinned runtime assets.

```bash
bun install
bun run dev
```

Configure a model provider in Settings, then choose a project.

To check a source checkout the way CI does, also install Node.js 24:

```bash
bun run helper:fetch-go && bun run build:helper
bun run lint
bun run typecheck
bun run test:gate
```

`bun run build:mac` and `bun run build:linux` produce packages. Maintainers publish releases from a `v*` tag; see [release-signing-update.md](docs/roadmap/release-signing-update.md).

## License

The source is licensed under [MIT](LICENSE). Third-party attributions are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Report bugs and request features in [GitHub Issues](https://github.com/dxsbiocc/phi/issues).
