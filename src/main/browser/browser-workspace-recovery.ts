import type { BrowserEngine, EngineTabHandle } from './browser-engine'
import type { BrowserTabCollection, BrowserTabRecord } from './browser-tab-collection'
import { beginFreshEngineRevisionEpoch } from './browser-workspace-engine-state'

export type BrowserCrashRecoveryPreparation =
  { ok: false; cancelled: boolean } | { ok: true; cleanupFailed: boolean }

export async function prepareCrashedTabRecovery(options: {
  engine: BrowserEngine
  release(handle: EngineTabHandle): Promise<void>
  tabs: BrowserTabCollection
  tab: BrowserTabRecord
  partition: string
  signal?: AbortSignal
  isDisposed: () => boolean
  exposeInitialDocument?: () => void
}): Promise<BrowserCrashRecoveryPreparation> {
  let freshHandle: EngineTabHandle
  try {
    freshHandle = await options.engine.createTab({ partition: options.partition })
  } catch {
    return { ok: false, cancelled: false }
  }
  if (options.isDisposed() || options.signal?.aborted) {
    try {
      await options.release(freshHandle)
    } catch {
      // Workspace disposal owns any engine cleanup that could not finish here.
    }
    return { ok: false, cancelled: true }
  }

  let oldHandle: EngineTabHandle | null
  try {
    oldHandle = options.tabs.replaceHandle(options.tab, freshHandle)
  } catch {
    try {
      await options.release(freshHandle)
    } catch {
      // The fresh handle was never published and remains engine-owned for final cleanup.
    }
    return { ok: false, cancelled: false }
  }
  beginFreshEngineRevisionEpoch(options.tab)
  if (options.exposeInitialDocument) {
    options.exposeInitialDocument()
    options.tab.engineDocumentRevisionOffset = options.tab.snapshot.documentRevision
  }
  let cleanupFailed = false
  if (oldHandle) {
    try {
      await options.release(oldHandle)
    } catch {
      cleanupFailed = true
    }
  }
  return { ok: true, cleanupFailed }
}
