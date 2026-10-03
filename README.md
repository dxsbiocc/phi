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

The **Connectors** activity-bar entry shows installed MCP services in collapsible
groups. **Discover** opens a directory of common productivity, communication, design,
and life-science services, plus a custom HTTPS MCP URL form. Adding a connector saves
it in Phi's global `~/.phi/mcp.json`; new local conversations load it through the MCP
runtime. **Installed** means the configuration is saved, not that the server is
connected or authorized. The public PubMed, bioRxiv, and Clinical Trials servers can
be added now, and official MCP servers that publish OAuth can be authorized from the
directory. API-key connectors ask for that key first. Google Drive, Gmail, and Slack
stay listed, but their providers require a pre-registered OAuth client that Phi does
not configure, so they cannot be authorized from the directory yet. Remote project
conversations do not load MCP in this beta. For public biological databases, the main
agent reads public REST URLs; database file downloads use `download_file` directly.
The directory reads the current tool list from each public MCP server when its detail
page opens; services awaiting authorization do not display guessed tool lists.

## Internal Beta Scope

This beta is for project-bound agent work: multiple conversations can keep
running, project sessions default to approval mode, resources are visible, and support
diagnostics can be copied without full chat or tool output. It is not a public
distribution build, a full plugin marketplace, a Git client, or a dedicated OMX
team/swarm dashboard.

### Built-in Browser

Ordinary HTTP(S) links in chats open in Phi's built-in browser by default. Hold
Cmd on macOS or Ctrl on Windows/Linux while clicking to use the system browser,
or use the browser toolbar's system-browser action. The built-in browser supports
normal tabs, an address bar, back, forward, reload, stop, localhost pages, and
opening safe popups as new tabs.

Each Phi session has its own tabs. Sessions in the same canonical project share
ephemeral site storage. Switching sessions hides the previous browser without
interrupting background work. After restarting Phi, saved pages appear as restore
choices and do not connect to the network until you restore them. Browser checkpoints
contain stable tab IDs, titles, URLs, order, and the active selection; deleting
`~/.phi` removes them along with the rest of the beta data.

The agent can take screenshots and use bounded coordinate clicks, scrolling,
navigation keys, and ordinary text fields. Every agent input on an external site needs
a new one-time approval. Password, file, and one-time-code fields always require
you to take over. Purchases, account creation, CAPTCHAs, uploads, permission grants,
and destructive actions also require takeover; external POST submissions cannot be
automated. This beta does not provide downloads, a password manager, extensions, or
a persistent browser profile. Quitting Phi clears ephemeral web state.

Local Git sessions show a bounded file-change summary after each run. It compares the
working tree at run start and finish, so earlier edits are excluded; ignored files and
non-Git folders are outside this summary. Existing files in the card open in Phi's
file preview. Small text changes also keep a read-only per-file diff under the Phi
session's artifacts; binary and large files show counts only when available.

For a separate final report, figure, notebook, or data table, the agent can mark up to
four existing local workspace files as deliverables. Phi keeps a delivery card in the
conversation with file descriptions and preview actions. The card points to the
current source files; it does not copy their contents or upload them. This action is
not available for remote project files in the internal beta.

For a task that needs a reviewed plan, select **先计划** in the chat composer before
sending it. The agent can inspect the local workspace and draft a session-local plan,
while this turn's working-tree writes remain blocked. The plan appears in the conversation for
**继续执行** or **修改计划**; Phi records the choice, and approval restores the usual
tools. Remote project conversations do not offer this mode in the beta.

The activity bar's **后台任务** button combines running background Agent tasks and
Wrapper runs, with progress, links back to their conversation or Wrapper page,
and stop actions only where the existing runner supports cancellation. It also
shows a short recent list while those run records remain available; this is a
compact task view rather than an OMX team dashboard.

Use a conversation row's export action to choose a local folder for a complete
session backup. Phi creates a new subfolder containing its timeline, tool outputs,
artifacts, underlying runtime history, and referenced image blobs. This export can
contain secrets and thinking text; it does not copy project files or import back
into Phi. Wait for the conversation to finish before exporting.

Beta data is intentionally resettable. Phi-owned state lives under `~/.phi`, including
sessions, project registry, logs, and tool output references. If the beta data model
changes, removing `~/.phi` is the supported clean reset path; repositories themselves
are not deleted by Phi project removal.

Updates are manual during the internal beta. Pull or receive the next build from the
project owner, install dependencies when needed, and rerun the verification commands
below before handing a build to another tester.

The local agent worker needs Bun 1.3.14 or newer for image reads: the Pi SDK uses
`Bun.Image`, which older Bun versions do not provide. Check with `bun --version`
and `bun -e 'console.log(typeof Bun.Image)'` when a valid local image is reported
as undecodable.

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
The server list's **测试连接** checks SSH connectivity and authentication only.
Use **检查运行环境** in Wrapper settings to inspect the project directory and
Nextflow, Java, Slurm, and the selected runtime. Missing Nextflow offers a
confirmed installation into the SSH account's `~/.local/bin` or the
[official manual steps](https://docs.seqera.io/nextflow/install); Java, Slurm,
and container runtimes remain administrator or user-managed.

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
bun install
bun run dev
```

## Verification

Use Node.js 22.15+ (or 24+) for the regression test loader. Dependencies must already
be installed; the tests use Node's built-in test runner and the existing TypeScript
compiler, without a separate test framework.

```bash
bun run test
bun run lint
bun run typecheck
bun run build
```

Tests isolate external model calls and Electron APIs. They do not verify real provider
authentication, live model responses, or a signed application installer. Before a
release, also check switching conversations during streaming, stopping a response,
closing an approval window, restoring tool output, and switching between projects
with different Skills/MCP configuration.

## Packaging

```bash
bun run build:win
bun run build:mac
bun run build:linux
```

The packaging configuration still contains development identifiers and a placeholder
update URL. Production signing, macOS notarization, and update hosting must be
configured for the intended publisher before distributing a release.
