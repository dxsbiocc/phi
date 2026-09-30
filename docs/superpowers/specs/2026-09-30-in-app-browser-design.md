# Phi In-App Browser Design

**Date:** 2026-09-30

**Status:** Approved design

**Scope:** Internal-beta browser surface with shared human/agent control and an upgrade-safe engine seam

## Summary

Phi will add a conventional, lightweight browser to the existing Browser side panel. Ordinary HTTP(S) links from chat open in Phi by default instead of being sent directly to the system browser. The first delivery includes tabs, an address bar, navigation controls, localhost support, popup/OAuth tab handling, screenshots, and coordinate-based agent control of the same visible page.

The feature is intentionally small at the product surface, but its implementation is organized around one deep module, `BrowserWorkspace`. Renderer UI, agent tools, and link routing use the same stable interface. Electron `WebContentsView` is the first production adapter, while an in-memory adapter makes the interface the primary test surface. Browser Use, Playwright, streaming, semantic inspection, persistent profiles, and remote browsers can be added behind the engine seam without changing the browser UI or agent-facing entry point.

## Goals

1. Open ordinary chat HTTP(S) links in Phi's built-in browser by default.
2. Provide familiar browser behavior: new tab, close tab, address entry, back, forward, reload, stop, title, loading state, and explicit open-in-system-browser.
3. Support HTTPS pages and loopback HTTP development servers.
4. Let a user and an agent observe and control the same browser tab.
5. Let agents capture the page and perform basic click, typing, keypress, and scroll actions.
6. Keep browser pages isolated from the Phi renderer, preload, application session, and filesystem.
7. Preserve an implementation seam for future Browser Use, Playwright, CDP, semantic inspection, recordings, persistent profiles, and remote browsers.
8. Make browser ownership unambiguous across Phi's concurrent sessions and runs.

## Non-goals

The initial delivery does not include bookmarks, a browsing-history UI, extensions, a password manager, automatic file uploads, general download management, full Chrome DevTools Protocol access, page annotations, video recording, a cloud browser, a remote browser, or a provider/plugin marketplace.

It also does not attempt to reproduce Chrome. The browser exists to keep web context beside a Phi conversation and to let an agent verify or interact with a page under the user's supervision.

## Product Behavior

### Opening links

- A normal click on an HTTP(S) chat link opens it in the current Phi session's Browser panel.
- `Cmd`-click on macOS and `Ctrl`-click on Windows/Linux opens the link in the system browser.
- The browser toolbar includes an explicit **Open in default browser** action.
- Application-owned OAuth and MCP authorization flows continue to call `shell.openExternal`; they are not captured by the general chat-link route.
- A hostname entered without a scheme is normalized to HTTPS.
- Loopback development addresses may use HTTP.

### Tabs

- Each Phi session owns its own list of browser tabs.
- Opening a chat link creates and activates a new tab.
- Ordinary same-tab navigation remains in the tab.
- An allowed `target="_blank"` or `window.open()` HTTP(S) request becomes a new in-app tab rather than a native popup window.
- Closing the active tab selects a deterministic adjacent tab.
- Browser tabs remain alive while their Phi session is hidden so background agent work and page state are not lost.

### User and agent control

- Manual browsing never requires approval.
- A normal agent browser task creates a dedicated tab in the current Phi session.
- When the user explicitly refers to “this page” or the current browser context, the agent may request control of the active tab.
- Control is visible in the toolbar and can be stopped by the user at any time.
- Agent actions execute serially per tab.
- The result of each observation or action includes an updated snapshot so the agent does not act repeatedly against stale pixels.

### Login state

- Tab ownership is per Phi session.
- Browser storage ownership is per canonical project path, so sessions in the same project can share cookies and local storage while their tabs remain separate.
- Ordinary sessions without a project receive their own isolated storage account.
- The initial Electron partition is non-persistent: state survives tab and session switching during the app process but is removed when Phi exits.
- Browser checkpoints save tab URL, title, order, and active selection, but a restored checkpoint does not automatically contact the website. The user or agent must explicitly restore it.

## Architecture

```text
Chat links / BrowserPanel / Agent browser tool
                    |
                    v
          BrowserWorkspace interface
                    |
       +------------+-------------+
       |            |             |
 BrowserPolicy  TabRegistry  BrowserApproval
                    |
                    v
            BrowserEngine seam
                    |
        +-----------+------------+
        |                        |
 ElectronWebContentsView   InMemoryBrowser
       adapter                 adapter
```

`BrowserWorkspace` is the external module. It owns normalized state, command ordering, stable IDs, ownership, policy decisions, approval state, error mapping, and lifecycle. Electron objects stay inside the production adapter.

## External Interface

The external interface is shared by renderer callers, internal agent tools, and tests:

```ts
export interface BrowserWorkspace {
  execute(
    actor: BrowserActor,
    command: BrowserCommand,
    signal?: AbortSignal
  ): Promise<BrowserOutcome>

  snapshot(): BrowserWorkspaceSnapshot

  subscribe(listener: (event: BrowserWorkspaceEvent) => void): () => void

  dispose(): Promise<void>
}

export type BrowserActor =
  | { kind: 'human' }
  | {
      kind: 'agent'
      sessionId: string
      runId: string
      toolCallId: string
    }
```

The current main-process run supplies the agent identity. Renderer input is never trusted to choose an arbitrary agent, run, session, project, engine, or capability.

### Commands

```ts
export type BrowserCommand =
  | { type: 'open'; requestId: string; url: string }
  | { type: 'newTab'; requestId: string; url?: string }
  | { type: 'activate'; requestId: string; tabId: string }
  | { type: 'close'; requestId: string; tabId: string }
  | {
      type: 'navigate'
      requestId: string
      tabId: string
      url: string
      expectedDocumentRevision?: number
    }
  | { type: 'history'; requestId: string; tabId: string; direction: 'back' | 'forward' }
  | { type: 'reload' | 'stop'; requestId: string; tabId: string }
  | { type: 'snapshot'; requestId: string; tabId: string }
  | {
      type: 'click'
      requestId: string
      tabId: string
      x: number
      y: number
      expectedDocumentRevision: number
      consequence: 'read' | 'write' | 'irreversible'
    }
  | {
      type: 'typeText'
      requestId: string
      tabId: string
      text: string
      expectedDocumentRevision: number
      consequence: 'read' | 'write' | 'irreversible'
    }
  | {
      type: 'keypress'
      requestId: string
      tabId: string
      key: string
      expectedDocumentRevision: number
    }
  | {
      type: 'scroll'
      requestId: string
      tabId: string
      deltaX: number
      deltaY: number
      expectedDocumentRevision: number
    }
```

`requestId` makes retry behavior explicit. A workspace records a bounded set of recent request outcomes and returns the earlier outcome when the same request is retried. Coordinates are CSS-pixel coordinates in the captured viewport, not raw device pixels.

### Snapshot

```ts
export interface BrowserWorkspaceSnapshot {
  sessionId: string
  activeTabId: string | null
  tabs: BrowserTabSnapshot[]
  capabilities: BrowserCapabilities
  revision: number
}

export interface BrowserTabSnapshot {
  id: string
  title: string
  url: string
  origin: string | null
  phase: 'idle' | 'loading' | 'ready' | 'failed' | 'crashed'
  canGoBack: boolean
  canGoForward: boolean
  isAgentControlled: boolean
  documentRevision: number
  error?: BrowserError
}
```

Snapshots never contain Electron objects, `webContents.id`, adapter handles, cookies, DOM values, authorization headers, or request bodies.

## Engine Seam

```ts
export interface BrowserEngine {
  capabilities(): BrowserCapabilities

  createTab(input: EngineTabInput): Promise<EngineTabHandle>

  execute(
    handle: EngineTabHandle,
    command: EngineCommand,
    signal?: AbortSignal
  ): Promise<EngineResult>

  setViewport(handle: EngineTabHandle, viewport: BrowserViewport | null): Promise<void>

  subscribe(listener: (event: EngineEvent) => void): () => void

  disposeTab(handle: EngineTabHandle): Promise<void>

  dispose(): Promise<void>
}
```

The first two adapters make this a real seam:

- `ElectronWebContentsViewAdapter` is the production implementation.
- `InMemoryBrowserAdapter` drives interface tests without Electron.

Future adapters may use Browser Use, Playwright, a screenshot stream, or a remote browser. They must still publish the normalized workspace snapshot and errors.

### Capabilities

```ts
export interface BrowserCapabilities {
  presentation: 'native' | 'stream'
  screenshot: boolean
  coordinateInput: boolean
  semanticInspection: boolean
  downloads: boolean
  recording: boolean
  persistentProfile: boolean
}
```

The initial Electron adapter reports native presentation, screenshot, and coordinate input. Semantic inspection, downloads, recording, and persistent profiles are false. A future adapter may add those capabilities without changing the basic browser commands or renderer state model.

## Renderer and Preload

The renderer feature lives under:

```text
src/renderer/src/features/browser/
  BrowserPanel.tsx
  components/BrowserToolbar.tsx
  components/BrowserTabs.tsx
  hooks/useBrowserWorkspace.ts
  hooks/useBrowserViewport.ts
  lib/browserState.ts
```

`App.tsx` mounts the feature and routes link activations; it does not own browser state or Electron behavior.

The preload exposes a namespaced bridge:

```ts
export interface BrowserRendererBridge {
  execute(command: BrowserUiCommand): Promise<BrowserOutcome>
  snapshot(): Promise<BrowserWorkspaceSnapshot>
  setViewport(input: { tabId: string; viewport: BrowserViewport | null }): Promise<void>
  onEvent(listener: (event: BrowserWorkspaceEvent) => void): () => void
}
```

Main-process IPC handlers derive the current window and Phi session from trusted application state. They validate the sender, command shape, string lengths, URL, bounds, numeric ranges, and tab ownership.

`BrowserPanel` uses `ResizeObserver` and animation-frame coalescing to report the page rectangle. A native browser view is hidden by sending `viewport: null` whenever the panel is hidden, a different session is active, the tab is inactive, the window is minimized, or a trusted modal/approval UI is displayed. CSS `z-index` is never treated as protection against a native child view.

## Link Routing

Renderer Markdown delegates normal HTTP(S) activation to the application browser route. Modifier clicks retain native external-browser behavior.

The main window's generic `setWindowOpenHandler` no longer sends every URL to `shell.openExternal`. App-shell HTTP(S) requests are routed to the current `BrowserWorkspace`; unsafe protocols are denied. Explicit authorization workflows continue to call `shell.openExternal` directly after their existing origin validation.

Guest pages receive their own window-open handler. Allowed credential-free HTTP(S) popup requests become tabs in the same Phi session and project storage partition. Native guest windows are denied. POST popups, custom protocols, HTTP authentication prompts, and attempts to open the Phi application origin are denied in the initial delivery.

## Agent Tool

Phi registers one model-facing `browser` tool with an action-discriminated input rather than many unrelated tools. The wrapper translates model input into `BrowserCommand` and converts `BrowserOutcome` into normal tool content.

The tool supports:

- open or create a tab;
- observe the current URL, title, loading state, navigation availability, and screenshot;
- click coordinates from the latest screenshot;
- type into the currently focused element;
- send an allowed keypress;
- scroll;
- go back, go forward, reload, stop, activate, or close.

A normal task creates a dedicated tab. A request that explicitly names the current page may request the active human tab. Agent control is tied to `sessionId`, `runId`, `toolCallId`, `tabId`, origin, and document revision. It ends when the run finishes, the tab closes, the origin changes, the document revision becomes stale, the user stops control, or the workspace is disposed.

## Approval and Sensitive Actions

Manual browsing is not gated by agent approvals.

Agent observation and input on project loopback pages are allowed without a site prompt. The first agent action on an external origin requests **Allow once** or **Deny**. The initial delivery does not save permanent site allowlists.

Before coordinate click or typing, the Electron adapter obtains a bounded target descriptor using fixed internal inspection code. It may return tag name, input type, role, accessible label, form method/action, and whether the target is editable or submits a form. It never returns field values, surrounding DOM, cookies, or credentials.

`BrowserApproval` combines the target descriptor with the command's declared consequence:

- Password, one-time-code, and file inputs require user takeover.
- Form submission and commands declared `irreversible` require explicit confirmation.
- Ordinary read actions and non-submitting input on an approved origin proceed.
- If classification cannot safely establish a target, the action is rejected with a structured handoff result rather than silently executed.

Purchases, account creation, CAPTCHA bypass, destructive actions, uploads, permission grants, certificate exceptions, HTTP authentication, and password entry are not automated in the initial delivery.

The approval surface always hides the native browser view before displaying trusted UI.

## Security Configuration

Every remote browser page is created with:

```ts
{
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  allowRunningInsecureContent: false,
  navigateOnDragDrop: false
}
```

Browser pages do not receive the Phi preload or application protocol privileges. Browser sessions are separate from the main renderer and provider-auth sessions.

URL policy accepts credential-free HTTPS and explicitly supported loopback HTTP. It rejects `file:`, `javascript:`, `data:`, `blob:`, `devtools:`, `chrome:`, application origins, malformed URLs, and embedded usernames/passwords. Initial navigation, redirects, history changes, and popup requests are all re-evaluated.

Both Electron permission-check and permission-request handlers default to deny. Camera, microphone, geolocation, notifications, display capture, MIDI, USB, serial, Bluetooth, clipboard read, downloads, file uploads, nested webviews, native popups, and guest DevTools are unavailable in the initial delivery.

## Error Model and Recovery

```ts
export type BrowserErrorCode =
  | 'INVALID_URL'
  | 'SCHEME_BLOCKED'
  | 'TAB_NOT_FOUND'
  | 'STALE_DOCUMENT'
  | 'CAPABILITY_UNAVAILABLE'
  | 'NAVIGATION_FAILED'
  | 'RENDERER_CRASHED'
  | 'PERMISSION_DENIED'
  | 'USER_HANDOFF_REQUIRED'
  | 'ACTION_TIMEOUT'
  | 'ACTION_CANCELLED'
  | 'ENGINE_UNAVAILABLE'
```

Errors contain only `code`, a safe user-facing message, `retryable`, and optional `tabId`/URL. Raw Electron exceptions, response bodies, headers, cookies, and form values are not transported to renderer or model.

- Invalid navigation leaves the current page unchanged.
- Load failure retains the attempted URL and exposes retry.
- Renderer crash changes the tab to `crashed`; retry creates a fresh engine page and never replays POST state.
- A coordinate action with an old document revision returns `STALE_DOCUMENT` and requires a fresh snapshot.
- Missing capabilities return `CAPABILITY_UNAVAILABLE`; they do not silently fall back.
- Hiding or switching a Phi session does not cancel a running browser action.
- Deleting a session, stopping its controlling run, or exiting the app cancels pending commands and disposes owned pages.
- Workspace and document revisions increase monotonically; renderer ignores older events.

## Persistence and Lifecycle

Browser checkpoints are stored as schema-versioned Phi-owned state under the existing session directory, for example `~/.phi/sessions/{sessionId}/browser.json`. A checkpoint contains stable tab IDs, order, title, last URL, and active tab ID. It contains no cookies, DOM data, screenshots, form values, or engine handles.

Closing a tab removes its checkpoint. Restoring a Phi session presents an idle restoration offer and does not create a browser page or issue a network request until the user or agent explicitly restores it.

Browser pages remain live while the application is running and their owning session still exists. An idle-eviction policy can be added behind `BrowserWorkspace` after usage data shows a need; it will convert an inactive page to its existing checkpoint without changing renderer or agent interfaces.

## Proposed File Ownership

```text
src/shared/browserTypes.ts

src/main/browser/
  browser-workspace.ts             # external module implementation
  browser-engine.ts                # internal engine seam
  browser-policy.ts                # URL and permission decisions
  browser-approval.ts              # agent site/action gating
  browser-checkpoints.ts           # browser.json persistence
  browser-workspace-registry.ts    # session -> workspace ownership
  browser-ipc.ts                   # validated renderer transport
  electron-browser-engine.ts       # WebContentsView adapter
  in-memory-browser-engine.ts      # deterministic test adapter

src/main/agent/browser/
  browser-tool.ts                  # model-facing browser tool

src/renderer/src/features/browser/
  BrowserPanel.tsx
  components/BrowserToolbar.tsx
  components/BrowserTabs.tsx
  hooks/useBrowserWorkspace.ts
  hooks/useBrowserViewport.ts
  lib/browserState.ts
```

Substantial browser logic must not be added to `App.tsx`, `WorkspaceSidePanel.tsx`, the generic preload object, or the main `index.ts`. Those files only compose or register the focused modules.

## Verification Strategy

### BrowserWorkspace interface tests

Tests use `InMemoryBrowserAdapter` and cover:

- open, activate, close, and deterministic active-tab selection;
- navigation, history, reload, and stop;
- popup-to-tab routing;
- workspace and document revisions;
- request idempotency;
- stale coordinate action rejection;
- agent dedicated-tab and current-tab rules;
- per-session tab isolation and per-project storage keys;
- approval, denial, user handoff, cancellation, crash, retry, and disposal;
- capability-unavailable outcomes;
- checkpoint save, explicit restoration, and removal.

### Electron adapter tests

Tests verify secure web preferences, partition selection, permission denial, URL revalidation, popup routing, viewport clamping, hiding, screenshot capture, input-event translation, renderer crash mapping, and destruction of owned `webContents`.

A local HTTP fixture covers navigation, redirects, title updates, history, popup creation, focus/input, scrolling, and load failure without relying on public network access.

### Renderer tests

Tests cover toolbar state, address submission, tab selection/close, loading/failure/crash UI, restoration offers, modifier-click behavior, Browser panel activation, viewport reporting, modal hiding, and stale event suppression.

### End-to-end acceptance

1. Clicking a chat HTTPS link opens a selected tab in Phi.
2. Modifier-click opens the same link in the default browser.
3. A loopback development page loads over HTTP.
4. An allowed popup becomes a new tab and shares project login state.
5. Switching Phi sessions preserves each session's independent tabs.
6. An agent captures the active page and successfully clicks, types, scrolls, and navigates.
7. Stale agent coordinates are rejected after navigation.
8. The user can stop agent control and continue manually.
9. An external-origin agent action requests one-time approval.
10. Password, file, and unsafe targets require user handoff.
11. Browser crash recovery does not interrupt chat or other sessions.
12. Existing application OAuth and MCP authorization continue opening in the system browser.

The delivery is verified with `npm test`, `npm run check:architecture`, `npm run lint`, `npm run typecheck`, and `npm run build`.

## Evolution Path

The stable interface supports incremental depth without changing callers:

1. Conventional tabs, link routing, native presentation, screenshots, and coordinate input.
2. Bounded semantic inspection and element references through new capabilities.
3. Persistent browser profiles and controlled download handling.
4. `BrowserUseAdapter` or `PlaywrightAdapter` with streamed presentation and provider-owned semantic actions.
5. Remote browser adapters, recordings, and opt-in developer CDP access.

Each stage adds internal capability or a new adapter. Renderer tabs, chat link routing, Phi session ownership, normalized snapshots, error codes, and the model-facing `browser` tool remain intact.

## Alternatives Rejected

### Direct Electron IPC methods

Exposing a flat list such as `browserOpen`, `browserBack`, `browserClick`, and `browserScreenshot` would mirror the Electron implementation and spread policy across main, preload, renderer, and agent code. Replacing the engine later would require editing every caller.

### Complete provider framework in the first delivery

A plugin registry, cloud browser, remote transport, and provider configuration UI would add scope before a second production adapter exists. The engine seam and capability model preserve the necessary options without shipping that product surface now.

### Browser Use as the initial required runtime

Browser Use already offers strong automation, but requiring its Python or cloud runtime would complicate local setup, localhost access, lifecycle, and in-app presentation. It remains a future adapter rather than a first-delivery dependency.

### Renderer `<webview>`

DeepSeek Harness demonstrates that `<webview>` can be secured with leases and strict guest policy, but Electron recommends `WebContentsView` for new work. Main-process ownership also places Phi's engine seam and policy in the correct location.

### System browser only

This preserves the smallest implementation but loses the chat/browser workspace, shared user-agent page, local preview workflow, and deterministic agent observation required by the feature.
