import type { BrowserError, BrowserScreenshot } from '../../shared/browserTypes'
import type { BrowserEngine, EngineTabHandle } from './browser-engine'
import type { BrowserTabCollection, BrowserTabRecord } from './browser-tab-collection'
import { safeBrowserEngineError } from './browser-workspace-engine-state'

export type BrowserWorkspaceScreenshotResult =
  { ok: true; screenshot: BrowserScreenshot } | { ok: false; error: BrowserError }

export interface CaptureBrowserWorkspaceScreenshotOptions {
  engine: BrowserEngine
  tabs: BrowserTabCollection
  tab: BrowserTabRecord
  screenshotAvailable: boolean
  signal?: AbortSignal
  isDisposed: () => boolean
}

function tabError(
  tabId: string,
  code: BrowserError['code'],
  message: string,
  retryable: boolean
): BrowserWorkspaceScreenshotResult {
  return { ok: false, error: { code, message, retryable, tabId } }
}

function unavailable(tabId: string, message: string): BrowserWorkspaceScreenshotResult {
  return tabError(tabId, 'CAPABILITY_UNAVAILABLE', message, false)
}

function tabCrashed(tab: BrowserTabRecord): boolean {
  return tab.snapshot.phase === 'crashed'
}

export async function captureBrowserWorkspaceScreenshot(
  options: CaptureBrowserWorkspaceScreenshotOptions
): Promise<BrowserWorkspaceScreenshotResult> {
  const { tab } = options
  const tabId = tab.snapshot.id
  if (!options.screenshotAvailable) return unavailable(tabId, 'Browser screenshots are unavailable')
  if (!tab.handle) return unavailable(tabId, 'Restore the page before taking a screenshot')
  if (tabCrashed(tab)) {
    return tabError(tabId, 'RENDERER_CRASHED', 'The browser page stopped unexpectedly', true)
  }

  const handle: EngineTabHandle = tab.handle
  const documentRevision = tab.snapshot.documentRevision
  const result = await options.engine.execute(handle, { type: 'screenshot' }, options.signal)

  if (options.isDisposed()) {
    return tabError(tabId, 'ENGINE_UNAVAILABLE', 'Browser workspace is disposed', false)
  }
  if (options.signal?.aborted) {
    return tabError(tabId, 'ACTION_CANCELLED', 'Browser action was cancelled', false)
  }
  if (!options.tabs.isBound(tab, handle) || tab.handle !== handle) {
    return tabError(
      tabId,
      'STALE_DOCUMENT',
      'The browser page changed before capture completed',
      true
    )
  }
  if (tabCrashed(tab)) {
    return tabError(tabId, 'RENDERER_CRASHED', 'The browser page stopped unexpectedly', true)
  }
  if (!result.ok) {
    const error = safeBrowserEngineError(result.error)
    return { ok: false, error: { ...error, tabId } }
  }
  if (!result.screenshot) return unavailable(tabId, 'Browser screenshots are unavailable')

  const mappedRevision = tab.engineDocumentRevisionOffset + result.screenshot.documentRevision
  if (mappedRevision !== documentRevision || tab.snapshot.documentRevision !== documentRevision) {
    return tabError(
      tabId,
      'STALE_DOCUMENT',
      'The browser page changed before capture completed',
      true
    )
  }

  return {
    ok: true,
    screenshot: {
      ...result.screenshot,
      tabId,
      url: tab.snapshot.url,
      documentRevision: mappedRevision
    }
  }
}
