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

export interface BrowserError {
  code: BrowserErrorCode
  message: string
  retryable: boolean
  tabId?: string
  url?: string
}

export interface BrowserViewport {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserCapabilities {
  presentation: 'native' | 'stream'
  screenshot: boolean
  coordinateInput: boolean
  semanticInspection: boolean
  downloads: boolean
  recording: boolean
  persistentProfile: boolean
}

export type BrowserTabPhase = 'idle' | 'loading' | 'ready' | 'failed' | 'crashed'

export interface BrowserTabSnapshot {
  id: string
  title: string
  url: string
  origin: string | null
  phase: BrowserTabPhase
  canGoBack: boolean
  canGoForward: boolean
  isAgentControlled: boolean
  documentRevision: number
  error?: BrowserError
}

export interface BrowserWorkspaceSnapshot {
  sessionId: string
  activeTabId: string | null
  tabs: BrowserTabSnapshot[]
  capabilities: BrowserCapabilities
  revision: number
}

export type BrowserActor =
  | { kind: 'human' }
  | {
      kind: 'agent'
      sessionId: string
      runId: string
      toolCallId: string
    }

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
  | {
      type: 'history'
      requestId: string
      tabId: string
      direction: 'back' | 'forward'
    }
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

export interface BrowserScreenshot {
  mediaType: 'image/png'
  data: string
  documentRevision: number
}

export type BrowserOutcome =
  | {
      ok: true
      snapshot: BrowserWorkspaceSnapshot
      screenshot?: BrowserScreenshot
    }
  | {
      ok: false
      error: BrowserError
      snapshot: BrowserWorkspaceSnapshot
    }

export type BrowserWorkspaceEvent =
  | {
      type: 'snapshotChanged'
      snapshot: BrowserWorkspaceSnapshot
    }
  | {
      type: 'error'
      error: BrowserError
      revision: number
    }
