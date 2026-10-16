<div align="center">
  <img src="build/icon.png" alt="Phi app icon" width="104" />
  <h1>Phi</h1>
  <p>A local-first desktop workbench for scientific AI workflows.</p>
  <p><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>
  <p>
    <a href="#quick-start">Quick start</a> ·
    <a href="#capabilities">Capabilities</a> ·
    <a href="#documentation">Documentation</a> ·
    <a href="https://github.com/dxsbiocc/phi/issues">Issues</a> ·
    <a href="LICENSE">License</a>
  </p>
  <p>
    <a href="#project-status"><img alt="Status: internal beta" src="https://img.shields.io/badge/status-internal%20beta-0f766e" /></a>
    <a href="package.json"><img alt="Version: 0.1.0" src="https://img.shields.io/badge/version-0.1.0-526579" /></a>
    <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue" /></a>
  </p>
</div>

Phi brings project-aware AI conversations, files, notebooks, terminals, browsers, and reproducible tool runs into one Electron app. The desktop owns credentials, approvals, and session history; local projects stay in their chosen directories, while remote project file and command work is directed to the selected SSH host.

## Capabilities

| Area              | What is available                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversations     | Multiple project-bound sessions, background runs, per-session model choices, approval controls, recoverable history, and session export.                                                |
| Project workspace | Local and SSH projects with file browsing, previews, editing, and explicit remote downloads.                                                                                            |
| Analysis          | `.ipynb` notebooks with cell editing, Jupyter execution, outputs, and AI-assisted notebook work. Remote Jupyter support is implemented but still needs full live-host acceptance.       |
| Tools and content | Skills, specialist agents, MCP connectors, Phi plugins, and Wrappers. Official domain packages come from the separate [phi-packages catalog](https://github.com/dxsbiocc/phi-packages). |
| Workbench         | An integrated terminal, in-app browser, background-task panel, and file previews beside conversations.                                                                                  |
| Reproducible runs | Wrapper plans and runs, including Nextflow and remote/Slurm paths where the host is configured.                                                                                         |

Phi uses React and TypeScript in the renderer, a typed preload bridge, and an Electron main process for privileged operations. Its agent engine integrates `@oh-my-pi/pi-coding-agent`; local and remote execution have different runtime boundaries. User state, including conversation history and settings, lives under `~/.phi`. Removing a project from Phi does not delete its source directory.

## Quick start

This repository is currently aimed at internal development and testing. Use **Bun 1.3.14 or newer**; the test runner requires **Node.js 22.15+ or 24+**. The first development launch may download the pinned runtime assets.

```bash
bun install
bun run dev
```

Add a model provider in Phi's settings after launch, then open an ordinary conversation or choose a local project. For an SSH project, configure a host and a writable absolute project path first. The app does not copy a remote project's data into the local session directory.

To build and preview the desktop app locally:

```bash
bun run build
bun run start
```

## Project status

Phi is an **internal beta**, not a signed public release. The macOS build is not notarized, Linux x64 AppImage/deb packaging is configured but still needs clean-machine verification, and Windows distribution is not yet validated. Updates are manual. Remote capabilities also require real-host acceptance in addition to automated tests; consult the [remote validation plan](docs/roadmap/remote-parity-implementation.md) before relying on a specific SSH or Slurm setup.

The app stores its own sessions, credentials, logs, runtime data, and package state under `~/.phi`. Treat that directory as private. Deleting it is a full beta-data reset, not an ordinary update step. Session exports can include tool output and sensitive conversation content.

## Development checks

```bash
bun run test
bun run lint
bun run typecheck
bun run build
```

Tests use local fixtures for external model and Electron behavior. They do not establish live provider authentication, real SSH/Slurm acceptance, or signed-installer readiness.

## Documentation

- [Internal beta roadmap](docs/roadmap/internal-beta-implementation.md) — original product scope and priorities.
- [Current agent-engine plan](docs/roadmap/omp-decoupling-upgrade-plan.md) and [upgrade runbook](docs/runtime/omp-upgrade-runbook.md) — OMP integration and verification boundaries.
- [Remote parity plan](docs/roadmap/remote-parity-implementation.md) and [manual checklist](docs/roadmap/remote-parity-manual-checklist.md) — SSH features and remaining acceptance work.
- [Official content source](docs/decisions/official-content-source.md) and [package contract](docs/contracts/package.md) — where installable domain content comes from.
- [Wrapper authoring guide](docs/design/phi-wrapper-authoring-guide.md) and [terminal guide](docs/design/terminal-v1-usage.md).

Some design and roadmap files record decisions at a specific date. The current source code and the latest acceptance record take precedence over older implementation sketches.

## License

Phi is licensed under [MIT](LICENSE). Adapted third-party code and its notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
