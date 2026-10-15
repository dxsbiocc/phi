import type { NotebookDocument } from '../../../../../shared/notebookDocument'
import type { AnalysisNotebookFile } from '../../../types'

export type NotebookSaveResult = AnalysisNotebookFile | boolean | void
export type NotebookSaveState = 'saved' | 'pending' | 'saving' | 'error'
export type NotebookSaveHandler = (
  file: AnalysisNotebookFile,
  document: NotebookDocument
) => NotebookSaveResult | Promise<NotebookSaveResult>
export type NotebookAutosave = {
  observe: (file: AnalysisNotebookFile, document: NotebookDocument) => void
  flush: (path: string) => void
  flushAll: () => void
  saveNow: (file: AnalysisNotebookFile, document: NotebookDocument) => Promise<boolean>
  isLocalSaveRevision: (path: string, revision: string, contentHash?: string) => boolean
  state: (path: string | null | undefined) => NotebookSaveState
  error: (path: string | null | undefined) => string | undefined
  subscribe: (listener: () => void) => () => void
  snapshot: () => number
  setSaveHandler: (handler: NotebookSaveHandler) => void
}
type Timer = ReturnType<typeof setTimeout> | number
type SaveEntry = {
  file: AnalysisNotebookFile
  document: NotebookDocument
  version: number
  savedVersion: number
  localRevisions: Set<string>
  localHashes: Set<string>
  lastLocalSave?: { revision: string; contentHash?: string }
  timer?: Timer
  inFlight?: NotebookDocument
  ready: boolean
  blocked: boolean
  error?: string
  waiters: { version: number; resolve: (saved: boolean) => void }[]
}

export function shouldPreserveNotebookDraftOnSave(
  current: NotebookDocument | null,
  incoming: NotebookDocument | null,
  localSaveAcknowledgement: boolean
): boolean {
  return Boolean(
    current && incoming && current.revision !== incoming.revision && localSaveAcknowledgement
  )
}

// One queue owns automatic and explicit saves. A second write must use the
// revision/hash returned by the first write, even while React still has its old file props.
export function createNotebookAutosave({
  save,
  delay = 900,
  setTimer = (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimer = (timer) => clearTimeout(timer)
}: {
  save: NotebookSaveHandler
  delay?: number
  setTimer?: (callback: () => void, milliseconds: number) => Timer
  clearTimer?: (timer: Timer) => void
}): NotebookAutosave {
  const entries = new Map<string, SaveEntry>()
  const listeners = new Set<() => void>()
  let snapshot = 0
  const notify = (): void => {
    snapshot += 1
    listeners.forEach((listener) => listener())
  }
  const cancelTimer = (entry: SaveEntry): void => {
    if (entry.timer !== undefined) clearTimer(entry.timer)
    entry.timer = undefined
  }
  const settle = (entry: SaveEntry, saved: boolean): void => {
    entry.waiters = entry.waiters.filter((waiter) => {
      if (!saved || waiter.version <= entry.savedVersion) {
        waiter.resolve(saved)
        return false
      }
      return true
    })
  }

  const drain = async (entry: SaveEntry): Promise<void> => {
    if (entry.inFlight || entry.blocked || !entry.ready) return
    if (entry.document.revision === entry.file.savedRevision) {
      entry.ready = false
      entry.savedVersion = entry.version
      cancelTimer(entry)
      settle(entry, true)
      notify()
      return
    }
    const document = entry.document
    const version = entry.version
    entry.ready = false
    entry.inFlight = document
    entry.localRevisions.add(document.revision)
    notify()
    try {
      const result = await save(entry.file, document)
      if (result === false) throw new Error('自动保存失败，请检查错误后手动重试保存。')
      entry.file =
        typeof result === 'object' && result !== null
          ? result
          : { ...entry.file, document, savedRevision: document.revision, contentHash: undefined }
      entry.localRevisions.add(entry.file.savedRevision)
      if (entry.file.contentHash) entry.localHashes.add(entry.file.contentHash)
      entry.lastLocalSave = {
        revision: entry.file.savedRevision,
        contentHash: entry.file.contentHash
      }
      entry.savedVersion = version
      entry.error = undefined
      settle(entry, true)
    } catch (error) {
      // An external revision conflict is never retried silently. Keep the local
      // document and require an explicit retry with a deliberately chosen baseline.
      entry.blocked = true
      entry.error = error instanceof Error ? error.message : '无法自动保存 notebook'
      entry.ready = false
      cancelTimer(entry)
      settle(entry, false)
    } finally {
      entry.inFlight = undefined
      notify()
    }
    if (entry.ready) void drain(entry)
  }

  const observe = (file: AnalysisNotebookFile, document: NotebookDocument): SaveEntry => {
    let entry = entries.get(file.path)
    let changed = false
    if (!entry) {
      changed = true
      entry = {
        file,
        document,
        version: 0,
        savedVersion: 0,
        localRevisions: new Set([file.savedRevision]),
        localHashes: new Set(file.contentHash ? [file.contentHash] : []),
        ready: false,
        blocked: false,
        waiters: []
      }
      entries.set(file.path, entry)
    } else {
      const clean = !entry.inFlight && entry.document.revision === entry.file.savedRevision
      const changedRevision = file.savedRevision !== entry.file.savedRevision
      const changedHash =
        file.contentHash &&
        file.contentHash !== entry.file.contentHash &&
        !entry.localHashes.has(file.contentHash)
      if (
        (changedRevision &&
          (clean || document.revision === file.savedRevision) &&
          (!entry.localRevisions.has(file.savedRevision) ||
            document.revision === file.savedRevision)) ||
        (clean && changedHash)
      ) {
        changed = true
        entry.file = file
        entry.lastLocalSave = undefined
        entry.blocked = false
        entry.error = undefined
      }
      if (document.revision !== entry.document.revision) {
        changed = true
        entry.document = document
        entry.version += 1
        cancelTimer(entry)
      }
    }
    if (document.revision === entry.file.savedRevision && !entry.inFlight) {
      cancelTimer(entry)
      entry.savedVersion = entry.version
      settle(entry, true)
    } else if (
      !entry.blocked &&
      entry.timer === undefined &&
      !entry.ready &&
      entry.inFlight?.revision !== document.revision
    ) {
      changed = true
      entry.timer = setTimer(() => {
        entry!.timer = undefined
        entry!.ready = true
        void drain(entry!)
      }, delay)
    }
    if (changed) notify()
    return entry
  }

  const flush = (path: string): void => {
    const entry = entries.get(path)
    if (!entry || entry.blocked) return
    cancelTimer(entry)
    entry.ready = true
    void drain(entry)
  }

  return {
    observe,
    flush,
    flushAll: (): void => entries.forEach((entry) => flush(entry.file.path)),
    saveNow: (file: AnalysisNotebookFile, document: NotebookDocument): Promise<boolean> => {
      const entry = observe(file, document)
      entry.blocked = false
      entry.error = undefined
      const completion = new Promise<boolean>((resolve) => {
        entry.waiters.push({ version: entry.version, resolve })
      })
      flush(file.path)
      return completion
    },
    isLocalSaveRevision: (path: string, revision: string, contentHash?: string): boolean => {
      const entry = entries.get(path)
      return Boolean(
        entry &&
        (entry.inFlight?.revision === revision ||
          (entry.lastLocalSave?.revision === revision &&
            (contentHash === undefined || entry.lastLocalSave.contentHash === contentHash)))
      )
    },
    state: (path: string | null | undefined): NotebookSaveState => {
      const entry = path ? entries.get(path) : undefined
      if (!entry) return 'saved'
      if (entry.blocked) return 'error'
      if (entry.inFlight) return 'saving'
      return entry.document.revision === entry.file.savedRevision ? 'saved' : 'pending'
    },
    error: (path: string | null | undefined): string | undefined =>
      path ? entries.get(path)?.error : undefined,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot: (): number => snapshot,
    setSaveHandler: (handler: NotebookSaveHandler): void => {
      save = handler
    }
  }
}
