# Phi

A local desktop AI workbench for small-circle internal beta users who already rely on
Pi/OMX-style local agent workflows. Phi is built with Electron, React, TypeScript,
and the Pi Coding Agent SDK.

The renderer calls a typed preload API; the main process owns model authentication,
agent sessions, project directories, tool approvals, and package resources. Phi stores
its configuration and conversation history in `~/.phi`, separately from the Pi CLI.
Ordinary conversations use `~/.phi/workspace`; local project conversations use the
selected directory. Remote project conversations keep their history locally while
project file and command operations use the selected SSH server. MCP listings show
configuration, not a live connectivity check.

## Internal Beta Scope

This beta is for project-bound agent work: multiple conversations can keep
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

## Remote Projects (Internal Beta)

**Settings → 远程** lists hosts discovered from `~/.ssh/config` alongside older
Phi server records. Discovered hosts are immediately available when creating a remote
project. **添加服务器** writes a new `Host` entry to `~/.ssh/config`; editing a
discovered host updates its entry there. Phi validates the resulting OpenSSH
configuration before atomically replacing it and keeps a private backup next to the
file. The form contains only alias, address, user, port and local private-key path;
blank optional fields keep OpenSSH defaults. Phi stores the key **path**, not the key
itself. Password login is not yet supported: use non-interactive key or
`ssh-agent` authentication and a trusted host key in `known_hosts`. Then create a
project with **Remote server** and an absolute, readable and writable directory
on that server. Testing a project connection checks its directory and reports
missing server tools. A remote project always runs its Wrappers on its bound
server and project path; its Wrapper page offers Slurm and runtime settings.

The remote settings page manages servers only. A local project stays local even
when it has a saved server compute target. The target can be configured from the
Wrapper page or a run plan, and is used only when remote execution is explicitly
requested. Local inputs must already exist at mapped server paths; Phi does not
upload project data automatically.

In a remote project, the usual `read`, `glob`, `grep`, `write`, `edit`, and `bash` agent
tools operate on the server. File browsing and small result previews also read from
the server; downloading a result requires an explicit save action. File edits and
commands still follow the project's approval setting. The window, conversations,
model calls, approval history, and run records remain on this computer in `~/.phi`.
The local session directory is metadata storage, never a copy of the remote project.

If the network or server is unavailable, Phi reports the connection problem and
keeps the local conversation and draft. It does not execute the operation locally.
After an uncertain write, command, or submission, check the server or run record
before retrying; Phi does not automatically repeat it. Closing Phi detaches a remote
Wrapper run. A submitted Slurm job remains managed by Slurm; use an explicit cancel
action to stop it. Remote Notebook/Jupyter, project Skills/MCP, and Git operations
are outside this beta's remote project support.

The remote workflow has automated coverage and a local SSH identity check. Acceptance
on a user-managed SSH host and a real Slurm cluster is still pending. See the
[E01 validation record](docs/roadmap/remote-e01-validation.md) before treating this
as a verified remote beta release.

## Phi Wrapper

Phi Wrapper is a reproducible execution layer for bioinformatics and other heavy
command-line tools: fixed, verified wrapper definitions the agent can call instead of
assembling ad hoc shell commands. It has its own sidebar entry ("Wrappers"), its own
storage under `~/.phi/wrappers`, and its own chat-timeline plan/run cards, independent
of ordinary tool calls.

Wrapper runs can target the local computer or a configured SSH server. On a remote
target, the Nextflow controller can run detached on the login host or as a Slurm
head job. Phi records status and logs for reattachment after the app reopens. It
also offers remote result browsing, bounded previews, and explicit downloads.
Real external-host and Slurm acceptance remains pending as noted above. See
[`docs/design/phi-wrapper-product-prd.md`](docs/design/phi-wrapper-product-prd.md)
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
