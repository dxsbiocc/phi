# Phi Internal Beta Implementation Roadmap

Date: 2026-09-05
Updated: 2026-09-29 — content distribution (see [content-distribution decisions](../decisions/content-distribution.md)).

This roadmap turns the internal beta decisions into implementation phases. The beta success criterion is a reliable local desktop workbench for heavy Pi/OMX users: project-bound sessions, multiple concurrent runs, understandable approvals, visible resources, and recoverable local history.

## P0: Data Model And Session Runtime

Goal: replace the single-active-session assumption with stable Phi sessions and per-session runs.

- Introduce a Phi session registry backed by `~/.phi/sessions/{sessionId}/`.
- Create session directories with `manifest.json`, `messages.jsonl`, `tool-outputs/`, and `artifacts/`.
- Give every new ordinary or project session a stable `sessionId` before first send.
- Introduce `runId` for each user submission.
- Make `messages.jsonl` append-oriented and `manifest.json` the mutable summary/state file.
- Store per-session model and thinking level in the session manifest.
- Store project default model/thinking in Phi-owned project state under `~/.phi`, not in project directories.
- Stop relying on `sessionFile` as UI identity. Treat SDK session files as implementation details.
- Allow clean reset of old beta session data. Do not build a broad old-session migration layer.
- Add tests for session creation, stable IDs, manifest persistence, append-only event writing, and unavailable-model handling.

## P0: Multi-Session Execution

Goal: let session switching be navigation while background runs continue.

- Replace global active run state with a session runner registry keyed by `sessionId`.
- Keep one active run per session and allow up to 4 running or approval-blocked sessions globally.
- Block new runs above the soft limit instead of queueing.
- Route SDK/runtime events to the correct session manifest and message stream by `sessionId` and `runId`.
- Keep background sessions receiving, persisting, and summarizing events while not visible.
- Make stop generation target only the selected session's active run.
- Keep app exit behavior simple: stop all running sessions, cancel pending approvals, mark interrupted runs, and close.
- Ensure switching sessions does not abort, dispose, or otherwise interrupt the previous session.
- Add regression tests for switching while streaming, stopping one session without stopping another, and restart-after-interruption state.

## P0: Approval State

Goal: keep project safety clear while supporting background work.

- Keep project conversations defaulting to `ask`; ordinary conversations default to `auto`.
- Continue gating `bash`, `powershell`, `edit`, and `write` in `ask` mode.
- Make project permission mode a live project policy that affects existing sessions on future calls.
- Add durable approval events: `approval_requested`, `approval_approved`, `approval_denied`, and `approval_cancelled`.
- Give approval requests stable `approvalId`s and associate them with `sessionId`, `runId`, and `toolCallId`.
- Keep approval promises in memory only.
- Show a global approval dialog for background requests with session name, project name, cwd, tool name, and command/path summary.
- Provide an "open session" action from approval UI.
- Mark permission denial as failed run state and record the denial in the timeline.
- Do not auto-timeout approvals in the beta.
- Add tests for background approval routing, denial state, stopping with pending approval, and project permission changes affecting existing sessions.

## P0: Sidebar And Timeline State

Goal: make concurrent work legible.

- Add sidebar session states: `idle`, `running`, `needs_approval`, `failed`, and `completed_unread`.
- Persist stable summary state and unread/attention markers in session manifests.
- Sort sessions by recent activity and surface `needs_approval`, `running`, and `failed` within each group.
- Clear completed/failed unread markers when the user opens the session. Do not clear active approval state on open.
- Show distinct state treatments for completed, failed, and permission-requested sessions.
- Keep completed state brief for active sessions and unread for background sessions.
- Add elapsed time display for running sessions.
- Throttle background preview updates; do not update sidebars on every streamed token.
- Add tests for state transitions, unread clearing, failure acknowledgement, and sorting priority.

## P0: Model Scope

Goal: support global providers with project/session-specific model selection.

- Keep provider auth and available provider/model discovery global.
- Add project default model/thinking fields.
- Add session model/thinking fields and make them win over project defaults.
- New project sessions inherit project defaults, then global defaults.
- Ordinary sessions inherit global defaults.
- Place current-session model controls in the chat/session context, not only global settings.
- Disable model/thinking switching while a session is `running` or `needs_approval`.
- Treat model changes as affecting the next run only.
- Show saved unavailable models without silently falling back. Require a valid model before sending.
- Default thinking to `high` when supported, otherwise the highest supported regular level; disable for non-reasoning models.
- Add tests for inheritance, switching rules, unavailable models, and per-session run creation.

## P1: Project Registry And Resource Visibility

Goal: make local project boundaries explicit without polluting repositories.

- Store project state in `~/.phi/projects.json` or an equivalent Phi-owned registry.
- Use `realpath` for project identity while preserving the user-selected display path.
- Prevent duplicate normalized project paths.
- Mark unavailable project paths and block new sessions until relocated or removed.
- Keep relocation optional for P1 if time allows; otherwise show unavailable and allow removal.
- Do not create project `.phi/` directories on add.
- Prefer `.phi` resources while retaining `.pi` and `.omp` compatibility.
- Keep skill and MCP *content* read-only in the app (no in-app editing). Enabling, disabling, and installing units from catalogs is allowed under P1: Content Distribution.
- Display skill source, scope, disabled state, file path, and diagnostics.
- Display MCP configured status, config source, command, args, env keys, and diagnostics.
- Do not actively read or inject project `.env`.
- Add tests for project duplicate detection, unavailable projects, resource precedence, and read-only resource display data.

## P1: Tool Output And Message Rendering

Goal: preserve enough evidence for heavy users without overwhelming the renderer.

- Store raw tool output locally.
- Fold long outputs by default and expose expand/open full output controls.
- Move very large outputs into `tool-outputs/` or artifacts and reference them from timeline events.
- Keep tool calls as independent stored events while grouping visually by run/tool group.
- Add clickable local paths for absolute paths and current-project relative paths.
- Prefer revealing files in the system file manager over executing risky file types.
- Add code block language labels and copy buttons.
- Keep raw HTML disabled in Markdown rendering.
- Save SDK-provided thinking content, folded by default.
- Add tests for output truncation metadata, artifact references, path recognition, Markdown safety, and code block copy controls where practical.

## Deferred: Pi Developer Extension Management

Goal: avoid exposing a global legacy package manager as if it were a project capability.

- Do not show the pi.dev catalog, install/remove controls, or developer-extension references in the internal-beta UI.
- OMP may continue loading externally configured Pi extensions for compatibility.
- Reconsider a Phi surface only after project-scoped enablement, live-session behavior, and an end-to-end callable integration are defined and tested.
- Keep the user-facing word "plugin" reserved for Phi plugins.

## P1: Runtime Foundation And Content Distribution (steps 0–5)

Goal: give Phi its own managed runtime so skills, specialist agents, notebooks, and wrappers stop depending on the host, then make content installable on top of it. Built inside-out; no public distribution in the beta.

Foundation (confirmed 2026-09-29): [phi-runtime-foundation.md](../design/phi-runtime-foundation.md). Distribution design: [phi-content-distribution-design.md](../design/phi-content-distribution-design.md). Decisions: [content-distribution.md](../decisions/content-distribution.md). **Step-by-step plan: [content-distribution-implementation.md](content-distribution-implementation.md)** (中文: [zh-CN](content-distribution-implementation.zh-CN.md)).

- Step 0 — preparation: clean `resources/` leftovers and block new ones; delete the `create-database-connector` skill; commit `scripts/eval/`; dependency inventory for all script content.
- Step 1 — runtime and environment model: bundled micromamba isolated from the user's conda; `~/.phi/runtime`; environments built from explicit locks, read-only, reference-counted.
- Step 2 — execution primitive: `runInEnvironment` with sanitised variables; isolation tests locally and in CI gate everything after.
- Step 3 — skills in environments: `skill_run`, declared script tools, `phi-python`, all script skills migrated.
- Step 4 — agents bound to environments: bash injection for specialist sessions; visualization rewritten as the `scripts/viz.py` CLI with declared script tools (tool names unchanged) running in the shared `phi-r` environment, and removed from the engine; `env_request` for extra packages. Includes the omp delegation spike.
- Step 5 — remaining consumers: Nextflow and Jupyter default to managed environments, with explicit, version-checked host versions for Nextflow and host kernels for notebooks; MCP stdio; environment panel.
- The main agent's bash keeps using the host environment.
- Plugins (step 6), content distribution (step 7), and remote / HPC runtime (step 8) follow after the beta, except the local skill catalog and enablement, which may land in the beta if time allows.

## P1: In-App Terminal (local, manual)

Goal: replace the terminal placeholder in the workspace side panel with a real local shell the user owns, and let the agent draft commands without ever running them.

Plan: [phi-terminal-v1-implementation-plan.md](../design/phi-terminal-v1-implementation-plan.md) (中文). Milestones T0–T5; T1–T3 form the minimum internally usable terminal, T4–T5 complete V1.

Status (2026-10-06): merged into `main` and rendered inside the two-slot workbench; pending human checks in [terminal-v1-manual-checklist.md](../design/terminal-v1-manual-checklist.md), chiefly Chinese IME, real-model drafts/explanations, and drag resize.

- T0 gate first: prove the PTY backend (`pi-natives` `PtySession` in a dedicated Bun worker, or `node-pty` as fallback) works in dev, `out/`, and the unpacked app, including resize, backpressure, and process-group cleanup. No mock-only panel ships if T0 fails.
- macOS local shells only. Terminals are grouped by project (or task directory for ordinary workspaces), survive panel collapse and chat switches, and close with the main window; no PTY restore across app restarts.
- Shell environment is an allowlist; Phi variables such as `PI_CODING_AGENT_DIR` and provider keys never reach the shell. The terminal is the user's own environment, not the runtime foundation's execution primitive.
- Terminal cleanup joins `cleanupMainWindowRuntime()` and fits inside the 2-second app quit budget.
- Bounded output: batching, ACK-based flow control, capped replay buffer and scrollback; terminal output is kept in memory only and is not logged.
- Agent assistance is tool-less: "write a command" and "explain selection" produce editable drafts; only an explicit user "send to terminal" writes to the PTY. No terminal tools are registered for the chat agent.
- Remote projects show "remote terminal comes later" and never fall back to a local shell.
- Add tests for IPC sender/frame checks, workspace resolution, lifecycle and idempotent close, environment allowlist, input transactions, output flow control, and draft-never-executes; verify real PTY behavior with a separate local smoke script.

## P1: Internal Logs

Goal: retain privacy-aware operational evidence without exposing support internals as user settings.

- Do not add a user-facing diagnostics settings page or raw support-summary export.
- Keep explicit full session export separate, with a clear warning that it includes conversation and tool output.
- Write logs to `~/.phi/logs`.
- Retain logs for 14 days by default.
- Avoid duplicating full tool output in ordinary logs.
- Add tests for log redaction and retention cleanup.

## P2: UX Polish And Beta Release Readiness

Goal: make the internal beta comfortable without expanding scope.

- Add minimal shortcuts: new session, focus input/search, and close dialogs.
- Keep search as local list filtering only.
- Continue using SDK/runtime automatic session names and support manual rename.
- Hide or clean up unsent and unrenamed empty sessions.
- Add lightweight read-only Git status: branch and dirty marker.
- Refresh Git status on project enter/switch, run completion, and manual refresh only.
- Show edit/write targets in the timeline and provide external reveal/open actions.
- Do not build a full diff viewer, command palette, drag-and-drop attachments, system notifications, automatic updates, or first-class OMX team/swarm dashboard in the beta.
- Update README with internal beta scope, resettable data model notice, manual update expectations, and macOS security prompt notes.
- Run `bun run test`, `bun run lint`, `bun run typecheck`, and `bun run build` before beta handoff.

## Public Biological Database Access

Status (2026-10-03): the experimental DB Connector core has been removed from this
release. The main agent reads public REST URLs with its existing `read` tool and uses
`download_file` directly for database files. Existing local connector settings are
ignored rather than deleted.

See [data-access-implementation.md](data-access-implementation.md) for the binding
decision and the future MCP-connector direction. Historical design appendices and
decision records remain as rationale, not as current product behavior.

## Deferred Until After Internal Beta

- Public distribution, formal signing/notarization, and automatic updates.
- Full command palette.
- Cross-session full-text search.
- Drag-and-drop file/image attachments.
- In-app editing of AGENTS.md, Skills, or MCP config.
- Runtime / content distribution steps 6–8: Phi plugins (visualization packaged as the first plugin), content distribution (packages, catalogs, wrapper and connector packaging, signed remote registry, installer slimming), remote / HPC runtime; side tracks: data access redesign, multi-agent orchestration on omp.
- Full diff/review UI and Git operations.
- System notifications.
- Dedicated OMX team/swarm dashboard.
- Remembered approval allowlists or path/command rules.
- Project-level provider credential isolation.
- Phi-specific model registry editor.
- Automatic sync or import/export beyond backup-friendly local files.
- Terminal follow-ups: SSH / remote project terminals, Windows and unverified Linux support, viewing or taking over agent-run shells, command completion tracking, split panes, terminal settings page, and using Phi-managed environments inside the terminal.
