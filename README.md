# Phi

A local desktop AI workbench for small-circle internal beta users who already rely on
Pi/OMX-style local agent workflows. Phi is built with Electron, React, TypeScript,
and the Pi Coding Agent SDK.

The renderer calls a typed preload API; the main process owns model authentication,
agent sessions, project directories, tool approvals, and package resources. Phi stores
its configuration and conversation history in `~/.phi`, separately from the Pi CLI.
Ordinary conversations use `~/.phi/workspace`; project conversations use the selected
project directory. MCP listings show configuration, not a live connectivity check.

## Internal Beta Scope

This beta is for local project-bound agent work: multiple conversations can keep
running, project sessions default to approval mode, resources are visible, and support
diagnostics can be copied without full chat or tool output. It is not a public
distribution build, a full plugin marketplace, a Git client, or a dedicated OMX
team/swarm dashboard.

Beta data is intentionally resettable. Phi-owned state lives under `~/.phi`, including
sessions, project registry, logs, and tool output references. If the beta data model
changes, removing `~/.phi` is the supported clean reset path; repositories themselves
are not deleted by Phi project removal.

Updates are manual during the internal beta. Pull or receive the next build from the
project owner, install dependencies when needed, and rerun the verification commands
below before handing a build to another tester.

Unsigned or locally built macOS apps may show Gatekeeper/security prompts. For this
beta, formal signing, notarization, and automatic updates are deferred; release notes
should tell testers to expect the standard macOS warning flow for local builds.

## Phi Wrapper (Phase 1)

Phi Wrapper is a reproducible execution layer for bioinformatics and other heavy
command-line tools: fixed, verified wrapper definitions the agent can call instead of
assembling ad hoc shell commands. It has its own sidebar entry ("Wrappers"), its own
storage under `~/.phi/wrappers`, and its own chat-timeline plan/run cards, independent
of ordinary tool calls.

Phase 1 is entirely local — there is no remote/HPC execution, no signed registry, and
no CLI yet; those arrive in later phases. What works today: one bundled demo wrapper
(`phi/ngs/fastq-qc`), asking the agent to prepare a run plan, reviewing and submitting
it from the chat card, and watching a real local Nextflow run execute with live
per-step status. See [`docs/design/phi-wrapper-product-prd.md`](docs/design/phi-wrapper-product-prd.md)
for the full phased scope and [`docs/design/phi-wrapper-authoring-guide.md`](docs/design/phi-wrapper-authoring-guide.md)
for how to point Phi at your own wrapper during development.

Prefer a wrapper over Phi's notebook/Jupyter analysis path when a community- or
lab-standard pipeline already exists for the task and reproducibility or resource cost
matters; prefer the notebook path for exploratory work or custom one-off logic. See the
PRD's "Relationship To Notebook Analysis" section for the full comparison.

## Development

```bash
npm install
npm run dev
```

## Verification

Use Node.js 22.15+ (or 24+) for the regression test loader. Dependencies must already
be installed; the tests use Node's built-in test runner and the existing TypeScript
compiler, without a separate test framework.

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Tests isolate external model calls and Electron APIs. They do not verify real provider
authentication, live model responses, or a signed application installer. Before a
release, also check switching conversations during streaming, stopping a response,
closing an approval window, restoring tool output, and switching between projects
with different Skills/MCP configuration.

## Packaging

```bash
npm run build:win
npm run build:mac
npm run build:linux
```

The packaging configuration still contains development identifiers and a placeholder
update URL. Production signing, macOS notarization, and update hosting must be
configured for the intended publisher before distributing a release.
