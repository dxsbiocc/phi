# Phi Internal Beta Workbench Decisions

Date: 2026-09-05

Phi's internal beta is a local desktop workbench for heavy Pi/OMX users. The goal is not a general chat app, a public plugin marketplace, or a polished public distribution channel. The beta should prove that real project-bound agent work can run locally with clear state, recoverable history, visible resources, and understandable approval boundaries.

## Product Scope

- Target audience: local small-circle beta users who already understand Pi/OMX workflows.
- Primary path: add a project directory, confirm provider/model readiness, start a project conversation, let the agent read project context, approve high-risk tool calls, and recover conversation history, cwd, permission mode, and run state.
- OMX is treated as a transparent execution layer in the beta. Skills such as `$team`, `$ralph`, and `$grill-me` should run through the normal chat and tool timeline. Dedicated team/swarm dashboards are out of scope for the first beta.
- The UI should feel like an independent Phi workbench while following familiar Codex/ChatGPT interaction patterns: left-side conversations/projects, main timeline, readable tool cards, and clear approval surfaces.
- Chinese is the beta language. Do not bind logic to Chinese display strings, and do not introduce a full i18n framework yet.

## Distribution

- Distribution target: local small-circle beta, not public release.
- No automatic updates in the beta. Show the app version and provide manual update instructions.
- Formal signing and notarization are not required for the small-circle beta, but release notes must explain expected macOS security prompts.
- Current packaging identifiers and update URL may remain development placeholders until the public distribution phase.

## Project Model

- Ordinary conversations use `~/.phi/workspace` and cannot choose an arbitrary cwd.
- Real cwd access requires creating a project.
- Adding a project should not create a project `.phi/` directory. Project `.phi/` content is written only after an explicit project-resource action exists.
- Phi-owned project state lives under `~/.phi`; project-level resource discovery prefers project `.phi` and remains compatible with `.pi` and `.omp`.
- Do not actively read or inject project `.env` files. Environment loading belongs to user commands, shell setup, or the underlying runtime.
- Project deletion means removing the Phi shortcut only. It must not delete the real project directory or historical session data.
- Use `realpath` as project identity for duplicate detection and safety boundaries, while preserving the user's chosen display path.
- Duplicate normalized project paths are not allowed. Re-adding an existing path should focus or reveal the existing project.
- If a project path is unavailable, keep the project record, mark it unavailable, block new sessions, and allow removal or future relocation. Relocation is useful but not a beta-critical path.

## Permissions And Safety

- Ordinary conversations default to `auto`.
- Project conversations default to `ask`.
- `ask` mode approves or rejects each high-risk local tool call individually. Do not add remembered allowlists in the beta.
- High-risk tool calls for beta approval are `bash`, `powershell`, `edit`, and `write`.
- MCP calls are displayed in the timeline but are not uniformly intercepted unless the SDK exposes reliable risk categories.
- Plugin install/remove actions are explicit UI actions and require concise confirmation.
- `auto` only skips Phi's per-tool UI approval. It does not grant unlimited filesystem or process permissions and remains subject to lower-level sandbox/runtime boundaries.
- Project permission mode is the current project policy and affects existing sessions on future tool calls.
- Refusing a permission request ends the current run as `failed` and records the rejection in the timeline.
- Approval requests do not auto-timeout while the app is open. Exiting the app stops running sessions and cancels pending approvals.

## Sessions And Runs

- Phi must support multiple sessions running at the same time.
- Switching sessions is UI navigation only and must not stop the background process.
- Stopping generation stops only the target session's active run.
- Exiting the app stops all running sessions. No daemon, tray background mode, or process restoration is in scope for the beta.
- Each session receives a stable Phi `sessionId` at creation time, before the first message is sent.
- Each user submission creates a stable `runId`; assistant text, tool calls, approvals, status events, and errors all carry that run ID.
- Each session may have at most one active run. Parallelism is achieved by running multiple sessions.
- Waiting for approval blocks new sends in that session but still allows editing the input draft.
- Beta concurrent running-session soft limit: 4. Do not queue beyond the limit; block new runs and ask the user to wait or stop another running session.
- Warn once when starting a new run in a project that already has running or approval-blocked sessions. Do not automatically prevent same-project parallel work.
- Runtime sessions are per Phi session. Provider credentials and the model runtime are shared globally.

## Session Storage

- Do not prioritize compatibility with existing beta session files. A clean session data model switch is acceptable.
- Store sessions in a global pool: `~/.phi/sessions/{sessionId}/`.
- Each session directory contains `manifest.json`, `messages.jsonl`, and optional `artifacts/` and `tool-outputs/` directories.
- The manifest records project/session metadata such as `projectId`, cwd display path, cwd realpath, model selection, thinking level, stable summary state, unread/attention state, last activity time, and last run outcome.
- Phi maintains its own normalized `messages.jsonl`; SDK session files are implementation details.
- Keep `messages.jsonl` mostly append-only. Update `manifest.json` for current summaries and stable state.
- Assistant streaming is displayed live in memory. Persist lifecycle events such as started, throttled or chunked delta, and finalized. The finalized event stores full assistant text.
- If there is no finalized assistant event after an interruption, recover from available deltas and mark the draft interrupted.
- Tool calls are stored as independent timeline events and may be visually grouped by run/tool group in the UI.
- Tool output should be saved locally. The renderer defaults to folded/truncated previews and can lazy-load or open full output.
- Very large tool output may be stored as a separate artifact referenced by the message stream.
- Save SDK-provided thinking/reasoning content when available, but fold it by default in the UI.
- Thinking content is excluded from lightweight diagnostic copy by default and included only in explicit full session export.

## Session State

- First beta sidebar states: `idle`, `running`, `needs_approval`, `failed`, and `completed_unread`.
- `interrupted` is a timeline event and last-run outcome, not a long-lived sidebar state.
- Active run objects, AbortControllers, and pending approval promises live in memory.
- The manifest stores the latest stable summary state and unread/attention markers.
- On restart, sessions interrupted by app exit should be shown as idle with an interrupted/stopped timeline record.
- Opened sessions clear completed and failed unread markers. Opening does not clear `needs_approval`.
- Failure badges remain until the user opens the session or sends again.
- Completed status is brief for the active session. Background sessions keep a subtle unread completed marker until opened.
- Session lists sort by recent activity. Within each group, `needs_approval`, `running`, and `failed` should surface above idle/completed items.

## Models And Providers

- Provider credentials and provider availability are global.
- Multiple providers can be configured globally.
- Projects and sessions can choose different models.
- Session model selection wins. Project model selection is only the default for new project sessions.
- Thinking/reasoning level is saved per session. Projects may also define a default thinking level for new sessions.
- New project sessions inherit the project default model/thinking level, or the global default when the project has no override.
- Ordinary new sessions inherit the global default model/thinking level.
- Users may override model/thinking when creating a new session, but the default path should stay lightweight.
- Current-session model controls should live in the current-session context, such as the input area or session header, and clearly show provider/model/thinking scope.
- Switching model is allowed when a session is idle, failed, or completed. Disable switching during `running` or `needs_approval`; changes apply to the next run.
- If a saved model is unavailable, keep showing it as unavailable. Browsing history is allowed, but sending requires choosing an available model. Do not silently fall back.
- Model definitions and provider customization should use the Pi SDK/runtime's existing configuration. Phi lists and selects models; it does not invent a separate model registry UI in the beta.
- Default thinking level prefers `high`; if unsupported, choose the highest supported regular level. Non-reasoning models have thinking disabled.

## Timeline And UI

- Tool display defaults to a user-readable timeline. Each tool card keeps expandable raw parameters and output.
- Background sessions continue receiving and saving all events even when not open.
- Current open sessions can stream text live. Background sidebar previews update on important events or throttled intervals, not every token.
- Background completion, failure, and approval requests each have distinct sidebar states.
- Background approval requests can be approved or rejected from a global lightweight dialog that shows session name, project name, cwd, tool name, and command/path summary. It must also offer an option to open the session for context.
- No system notifications in the beta. Use in-app status and prompts only.
- Code blocks need language labels and copy buttons. Full syntax highlighting can wait.
- Markdown should use safe `react-markdown` and GFM behavior. Raw HTML is not allowed in the beta.
- Tool output paths should be clickable for clear local absolute paths and current-project relative paths. Prefer revealing the path in the system file manager over executing/opening risky file types.
- Do not build a full diff/review viewer for the first beta. Show edit/write targets in the timeline and provide external open/reveal actions.
- Show lightweight read-only Git status for projects: current branch and dirty marker. Do not add commit/stage/diff operations.
- Refresh Git status on project enter/switch, after an agent run completes, and on manual refresh. Do not poll continuously.
- Use only minimal beta shortcuts, such as new session, focus input/search, and close dialogs. Do not build a full command palette yet.
- First-stage search is local UI filtering for visible lists. Cross-session full-text search is out of scope.
- Session naming follows SDK/runtime automatic naming where available. Phi supports manual rename.
- Empty sessions can exist with stable IDs, but unsent and unrenamed empty sessions may be hidden or cleaned up.
- Drag-and-drop file/image attachments are out of scope for the beta.

## Resources And Plugins

- Skills and MCP pages are read-only observation panels in the beta.
- Skills/MCP panels should show source, scope, disabled state, configuration source, command/args/env key summaries, and runtime diagnostics when available.
- Plugin install/remove remains available as an internal beta capability.
- Plugin source formats are whatever the SDK/runtime supports. Phi should not add arbitrary URL download or local zip install support in the beta.
- Plugin install requires confirming the source. Plugin removal requires confirming the target.
- Plugin operation failures should stay visible in the UI until refresh or the next plugin operation attempt.

## Diagnostics And Logs

- Add an explicit "copy diagnostics" action for internal beta support.
- Lightweight diagnostics exclude secrets, full chat content, full tool output, and thinking text by default.
- Diagnostics should include app version, platform, Node/Electron versions, session ID, project/cwd, provider/model ID, thinking level, permission mode, resource/plugin summaries, and recent error summaries.
- Full session export should be a separate explicit action that warns it includes conversation and tool output.
- App logs go under `~/.phi/logs`.
- Default log retention is 14 days.
- Logs record app/runtime status, IPC/SDK key events, approval outcomes, and error summaries. Do not duplicate full tool output in ordinary app logs.
