import type {
  BrowserCapabilities,
  BrowserErrorCode,
  BrowserViewport
} from '../../shared/browserTypes'

declare const engineTabHandleBrand: unique symbol

export const MAX_BROWSER_SCREENSHOT_BYTES = 8 * 1024 * 1024

export type EngineTabHandle = string & {
  readonly [engineTabHandleBrand]: 'EngineTabHandle'
}

export interface EngineTabInput {
  partition: string
}

export interface EngineTabState {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  documentRevision: number
  navigationRevision: number
}

export interface EngineTargetDescriptor {
  tagName: string
  inputType?: string
  role?: string
  accessibleLabel?: string
  formMethod?: string
  formAction?: string
  editable: boolean
  submitsForm: boolean
}

export interface EngineScreenshot {
  mediaType: 'image/png'
  data: string
  width: number
  height: number
  documentRevision: number
}

export type EngineCommand =
  | { type: 'navigate'; url: string }
  | { type: 'history'; direction: 'back' | 'forward' }
  | { type: 'reload' | 'stop' | 'screenshot' }
  | { type: 'click'; x: number; y: number }
  | { type: 'typeText'; text: string }
  | { type: 'keypress'; key: string }
  | { type: 'scroll'; deltaX: number; deltaY: number }
  | { type: 'describeTarget'; x: number; y: number }

export interface EngineError {
  code: BrowserErrorCode
  message: string
}

export type EngineResult =
  | {
      ok: true
      state: EngineTabState
      screenshot?: EngineScreenshot
      target?: EngineTargetDescriptor
    }
  | {
      ok: false
      error: EngineError
    }

interface EngineEventBase {
  handle: EngineTabHandle
  at: number
}

export type EngineEvent =
  | (EngineEventBase & {
      type: 'loadingChanged'
      isLoading: boolean
      navigationRevision: number
    })
  | (EngineEventBase & {
      type: 'navigationCommitted'
      url: string
      documentRevision: number
      navigationRevision: number
      canGoBack: boolean
      canGoForward: boolean
    })
  | (EngineEventBase & {
      type: 'titleChanged'
      title: string
      navigationRevision: number
    })
  | (EngineEventBase & {
      type: 'loadFailed'
      url: string
      errorCode: string
      message: string
      navigationRevision: number
    })
  | (EngineEventBase & {
      type: 'crashed'
      reason: string
    })
  | (EngineEventBase & {
      type: 'popupRequested'
      url: string
      method: 'GET' | 'POST' | 'other'
    })

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
