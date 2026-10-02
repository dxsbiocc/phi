import type { BrowserError, BrowserTabSnapshot } from '../../shared/browserTypes'
import type { EngineError, EngineEvent, EngineResult, EngineTabState } from './browser-engine'
import { browserOriginOf, type BrowserTabRecord } from './browser-tab-collection'

export function safeBrowserEngineError(error: EngineError): BrowserError {
  const messages: Record<EngineError['code'], string> = {
    INVALID_URL: 'The browser URL is invalid',
    SCHEME_BLOCKED: 'Browser navigation was blocked',
    TAB_NOT_FOUND: 'Browser tab was not found',
    STALE_DOCUMENT: 'The browser page changed before the action could run',
    CAPABILITY_UNAVAILABLE: 'Browser capability is unavailable',
    NAVIGATION_FAILED: 'Page failed to load',
    RENDERER_CRASHED: 'The browser page stopped unexpectedly',
    PERMISSION_DENIED: 'Browser action was not permitted',
    USER_HANDOFF_REQUIRED: 'Browser action requires user control',
    ACTION_TIMEOUT: 'Browser action timed out',
    ACTION_CANCELLED: 'Browser action was cancelled',
    ENGINE_UNAVAILABLE: 'Browser engine is unavailable'
  }
  return {
    code: error.code,
    message: messages[error.code],
    retryable:
      error.code === 'NAVIGATION_FAILED' ||
      error.code === 'ENGINE_UNAVAILABLE' ||
      error.code === 'ACTION_TIMEOUT'
  }
}

export function beginFreshEngineRevisionEpoch(tab: BrowserTabRecord): void {
  tab.engineNavigationRevisionOffset = tab.navigationRevision
  tab.engineDocumentRevisionOffset = tab.snapshot.documentRevision
}

function workspaceEngineState(tab: BrowserTabRecord, state: EngineTabState): EngineTabState {
  return {
    ...state,
    navigationRevision: tab.engineNavigationRevisionOffset + state.navigationRevision,
    documentRevision: tab.engineDocumentRevisionOffset + state.documentRevision
  }
}

export function workspaceEngineResult(tab: BrowserTabRecord, result: EngineResult): EngineResult {
  return result.ok ? { ...result, state: workspaceEngineState(tab, result.state) } : result
}

function workspaceEngineEvent(tab: BrowserTabRecord, event: EngineEvent): EngineEvent {
  switch (event.type) {
    case 'loadingChanged':
    case 'titleChanged':
    case 'loadFailed':
      return {
        ...event,
        navigationRevision: tab.engineNavigationRevisionOffset + event.navigationRevision
      }
    case 'navigationCommitted':
      return {
        ...event,
        navigationRevision: tab.engineNavigationRevisionOffset + event.navigationRevision,
        documentRevision: tab.engineDocumentRevisionOffset + event.documentRevision
      }
    case 'crashed':
    case 'popupRequested':
      return event
  }
}

function applyEngineState(snapshot: BrowserTabSnapshot, state: EngineTabState): void {
  snapshot.url = state.url
  snapshot.origin = browserOriginOf(state.url)
  snapshot.title = state.title
  snapshot.phase = state.isLoading ? 'loading' : 'ready'
  snapshot.canGoBack = state.canGoBack
  snapshot.canGoForward = state.canGoForward
  snapshot.documentRevision = Math.max(snapshot.documentRevision, state.documentRevision)
}

export function reconcileEngineResult(
  tab: BrowserTabRecord,
  result: Extract<EngineResult, { ok: true }>
): boolean {
  if (result.state.navigationRevision < tab.navigationRevision) return false
  if (
    result.state.navigationRevision === tab.navigationRevision &&
    result.state.documentRevision <= tab.snapshot.documentRevision
  ) {
    return false
  }
  tab.navigationRevision = result.state.navigationRevision
  if (result.state.documentRevision < tab.snapshot.documentRevision) return false
  const before = JSON.stringify(tab.snapshot)
  applyEngineState(tab.snapshot, result.state)
  tab.snapshot.error = undefined
  return JSON.stringify(tab.snapshot) !== before
}

function acceptNavigationEvent(tab: BrowserTabRecord, navigationRevision: number): boolean {
  if (navigationRevision < tab.navigationRevision) return false
  tab.navigationRevision = navigationRevision
  return true
}

export type BrowserEngineEventReduction =
  { changed: boolean } | { changed: false; popup: Extract<EngineEvent, { type: 'popupRequested' }> }

export function reduceBrowserEngineEvent(
  tab: BrowserTabRecord,
  rawEvent: EngineEvent
): BrowserEngineEventReduction {
  const event = workspaceEngineEvent(tab, rawEvent)
  if (event.type === 'popupRequested') return { changed: false, popup: event }
  const before = JSON.stringify(tab.snapshot)
  switch (event.type) {
    case 'loadingChanged':
      if (!acceptNavigationEvent(tab, event.navigationRevision)) return { changed: false }
      if (event.isLoading) {
        tab.snapshot.phase = 'loading'
        tab.snapshot.error = undefined
      } else if (tab.snapshot.phase === 'loading') {
        tab.snapshot.phase = 'ready'
      }
      break
    case 'navigationCommitted':
      if (event.navigationRevision < tab.navigationRevision) return { changed: false }
      if (event.navigationRevision > tab.navigationRevision) {
        tab.navigationRevision = event.navigationRevision
      }
      if (event.documentRevision <= tab.snapshot.documentRevision) return { changed: false }
      tab.snapshot.url = event.url
      tab.snapshot.origin = browserOriginOf(event.url)
      tab.snapshot.documentRevision = event.documentRevision
      tab.snapshot.canGoBack = event.canGoBack
      tab.snapshot.canGoForward = event.canGoForward
      tab.snapshot.error = undefined
      break
    case 'titleChanged':
      if (!acceptNavigationEvent(tab, event.navigationRevision)) return { changed: false }
      tab.snapshot.title = event.title
      break
    case 'loadFailed':
      if (!acceptNavigationEvent(tab, event.navigationRevision)) return { changed: false }
      tab.snapshot.url = event.url
      tab.snapshot.origin = browserOriginOf(event.url)
      tab.snapshot.phase = 'failed'
      tab.snapshot.error = {
        code: 'NAVIGATION_FAILED',
        message: 'Page failed to load',
        retryable: true,
        tabId: tab.snapshot.id
      }
      break
    case 'crashed':
      tab.snapshot.phase = 'crashed'
      tab.snapshot.error = {
        code: 'RENDERER_CRASHED',
        message: 'The browser page stopped unexpectedly',
        retryable: true,
        tabId: tab.snapshot.id
      }
      break
  }
  return { changed: JSON.stringify(tab.snapshot) !== before }
}
