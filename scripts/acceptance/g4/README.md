# G4 packaged-app acceptance driver

This directory contains a dependency-free Bun/ESM acceptance driver for the packaged macOS app. It never imports renderer code and never modifies `src/`.

## Run

```sh
bun .phi-acceptance/g4-driver/run.mjs
bun .phi-acceptance/g4-driver/run.mjs --dry-run
```

Each invocation creates `runs/<timestamp>/`, APFS-clones the supplied acceptance HOME and Chromium user-data directories, deletes only top-level `Singleton*` and `DevToolsActivePort` lock files in the user-data clone, and launches the packaged executable in a new process group. The driver owns and terminates only that process group.

The full run has a 45-minute deadline, every model reply has a 4-minute deadline, and the prompt budget is capped at 20 (the current flow uses at most 12). `--dry-run` has a 3-minute deadline, sends no prompts, and makes no model calls.

## Artifacts

Every run writes:

- `results.json` — one structured result per checklist ID (or a `DRY` selector result).
- `summary.md` — Chinese status table with screenshot paths.
- `shots/*.png` — full renderer-window evidence after each step, plus setup/context screenshots.
- `console.log` — renderer warnings/errors and exceptions captured through CDP, with common credential patterns redacted.
- `run-metadata.json` — non-secret launch metadata.

The isolated project is registered through the allowed renderer IPC, `window.api.createProject`, because the native folder picker cannot be automated reliably over renderer CDP. Project-session creation and every checklist interaction are driven through visible UI controls.

## Verdict logic

- F1: three user turns each receive a reply; clicking the second message's fork button must activate a title containing `（分叉）`.
- F2: the fork DOM must contain exactly the first two user messages and omit the third; the captured first two assistant replies must be present and the third absent.
- F3: PASS means a reply arrived without an error; the reply is recorded for human judgment.
- F4: reopening the captured source title must show all three original user messages.
- F5: after a normal remote reply, the remote message's UI fork control must expose the kernel-unavailable notice. Connection failure is BLOCKED. If the current renderer hides the control or substitutes different copy, the driver records FAIL rather than invoking IPC directly or manufacturing success.
- F6: before sending, the driver captures the existing fork button's React UI handler. It clicks Send, proves streaming via the Stop control, then invokes that captured UI handler. It requires `请等待来源会话运行结束后再分叉`; an absent handler or missing notice is FAIL. This React-internal bridge is necessary because the current renderer unmounts fork controls as soon as a run becomes busy.
- M1: a child-run card must appear and the final assistant output—not the prompt—must contain the random README marker.
- M2: the driver first opens and screenshots context usage. The current source has no compaction action in that popover, so it follows the visible Settings → General manual-compaction control, requires the success notice, then requires a normal follow-up reply.
- M3: the alternate model option must be selected while the Stop control still proves streaming is active. The original reply and a subsequent `你好` reply must finish without an error; the composer model shown for the latter is recorded. One available model is BLOCKED.
- M4: the remote session must return a normal reply.
- M5: a child-run UI element and a reply without an error are both required; reply content is recorded for human judgment.

Every step baselines persistent timeline errors and assistant-error message identities. A renderer-side `MutationObserver` captures transient snackbars/alerts during the step, including notices that auto-hide before a model reply finishes. Any new visible error or new assistant `stopReason: "error"` makes the step FAIL, except the explicitly allowed F5 connection BLOCKED case.

## Stable UI contracts

The driver uses these renderer contracts rather than CSS ancestry:

| Purpose | Selector / label | Source |
| --- | --- | --- |
| Home/new conversation | `data-phi-home-prompt="true"`, `aria-label="对话"`, button text `新对话` | `features/home/components/HomePrompt.tsx`, `AppActivityBar.tsx`, `components/SessionSidebar.tsx` |
| Project/session rows | `data-phi-project-row`, `data-phi-session-row` | `components/session-sidebar/ProjectRow.tsx`, `SessionRow.tsx` |
| New project session | `aria-label="新建项目对话"` | `components/session-sidebar/ProjectRow.tsx`, `lib/navigationCopy.ts` |
| Message editor | `data-phi-composer-editor="codemirror"` | `components/chat/ComposerTextEditor.tsx` |
| Send/stop state | `data-phi-composer-action="send|stop"` | `components/chat/ChatComposer.tsx` |
| User-message fork | `aria-label="从此消息分叉会话"` | `components/chat/ChatUserMessage.tsx`, `features/chat/lib/chatCopy.zh-CN.ts` |
| Model control | `data-phi-model-thinking="true"` | `components/chat/ChatComposerControls.tsx` |
| Context usage | `data-phi-context-usage`, `data-phi-context-breakdown-panel` | `features/chat/components/ContextUsageIndicator.tsx`, `ContextUsageBreakdownPanel.tsx` |
| Manual compaction | `aria-label="压缩当前会话上下文"` | `features/chat/components/AutoCompactionSettingsSection.tsx` |
| Child run | `data-agent-card-id` or the live `Agent 运行中` overview control | `components/AgentExecutionCard.tsx`, `components/chat/AgentRunsOverview.tsx` |
| Timeline error | `data-notice-level="error"` | `components/chat/NoticeRow.tsx` |
| Transient notice | `.PhiSnackbar-card` and its severity icon label | `components/AppSnackbarCard.tsx` |

Message text is also cross-checked through `window.api.getCurrentSession()` so assistant `stopReason: "error"` cannot be missed when a transient UI notice disappears. The driver does not read session, credential, auth, keychain, or database files itself.

Architecture judgment: `run.mjs` and `lib/ui.mjs` are over 600 lines and are intentionally kept cohesive. The former is one ordered checklist coordinator, keeping cross-step session identities, prompt budget, dependency BLOCKED states, and cleanup auditable in one place. The latter is the single renderer-UI boundary; splitting its small stateful workflows would add client/run plumbing without creating an independent test boundary. CDP transport, renderer contracts, argument parsing, and process/runtime isolation are already separate focused modules; neither file approaches the 1000-line debt threshold.
