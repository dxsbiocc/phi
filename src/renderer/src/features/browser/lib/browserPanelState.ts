import type {
  BrowserError,
  BrowserOutcome,
  BrowserRendererBridge,
  BrowserTabSnapshot,
  BrowserUiCommand,
  BrowserWorkspaceSnapshot
} from '../../../../../shared/browserTypes'

export interface BrowserWorkspaceViewState {
  snapshot: BrowserWorkspaceSnapshot | null
  loading: boolean
  busy: boolean
  error: string | null
}

export interface BrowserWorkspaceController {
  start(): void
  execute(command: BrowserUiCommand): Promise<BrowserOutcome | null>
  dispose(): void
}

export function browserErrorMessage(error?: BrowserError): string {
  switch (error?.code) {
    case 'NAVIGATION_FAILED':
      return '页面加载失败，请重试。'
    case 'RENDERER_CRASHED':
      return '页面停止响应，请重试。'
    case 'INVALID_URL':
    case 'SCHEME_BLOCKED':
      return '这个网址无法在应用内打开。'
    case 'TAB_NOT_FOUND':
      return '当前页面已经关闭。'
    case 'ACTION_CANCELLED':
      return '浏览操作已取消。'
    default:
      return '浏览器暂时不可用，请稍后重试。'
  }
}

function snapshotHasTabRecovery(snapshot: BrowserWorkspaceSnapshot): boolean {
  const activeTab = activeBrowserTab(snapshot)
  return activeTab?.phase === 'failed' || activeTab?.phase === 'crashed'
}

export function createBrowserWorkspaceController(options: {
  bridge: BrowserRendererBridge
  sessionId: string
  onState: (state: BrowserWorkspaceViewState) => void
}): BrowserWorkspaceController {
  let state: BrowserWorkspaceViewState = {
    snapshot: null,
    loading: true,
    busy: false,
    error: null
  }
  let disposed = false
  let started = false
  let pendingCommands = 0
  let nextSequence = 0
  let highestObservedRevision = -1
  let acceptedSnapshotRevision = -1
  let acceptedFeedback = { revision: -1, sequence: -1 }
  let unsubscribe: (() => void) | null = null

  const publish = (patch: Partial<BrowserWorkspaceViewState>): void => {
    if (disposed) return
    state = { ...state, ...patch }
    options.onState({ ...state })
  }
  const acceptSnapshot = (
    snapshot: BrowserWorkspaceSnapshot
  ): 'newer' | 'same' | 'older' | 'foreign' => {
    if (snapshot.sessionId !== options.sessionId) return 'foreign'
    if (snapshot.revision < highestObservedRevision) return 'older'
    highestObservedRevision = Math.max(highestObservedRevision, snapshot.revision)
    if (snapshot.revision < acceptedSnapshotRevision) return 'older'
    if (snapshot.revision === acceptedSnapshotRevision) return 'same'
    acceptedSnapshotRevision = snapshot.revision
    publish({ snapshot, loading: false })
    return 'newer'
  }
  const acceptFeedback = (revision: number, sequence: number, error: string | null): void => {
    if (revision < highestObservedRevision) return
    highestObservedRevision = Math.max(highestObservedRevision, revision)
    if (
      revision < acceptedFeedback.revision ||
      (revision === acceptedFeedback.revision && sequence < acceptedFeedback.sequence)
    ) {
      return
    }
    acceptedFeedback = { revision, sequence }
    publish({ error, loading: false })
  }

  return {
    start: () => {
      if (started || disposed) return
      started = true
      try {
        unsubscribe = options.bridge.onEvent((envelope) => {
          if (disposed || envelope.sessionId !== options.sessionId) return
          const sequence = ++nextSequence
          if (envelope.event.type === 'snapshotChanged') {
            const relation = acceptSnapshot(envelope.event.snapshot)
            if (relation === 'newer' || relation === 'same') {
              acceptFeedback(envelope.event.snapshot.revision, sequence, null)
            }
          } else {
            acceptFeedback(
              envelope.event.revision,
              sequence,
              browserErrorMessage(envelope.event.error)
            )
          }
        })
      } catch {
        publish({ error: browserErrorMessage(), loading: false })
      }
      const sequence = ++nextSequence
      void options.bridge
        .snapshot()
        .then((snapshot) => {
          const relation = acceptSnapshot(snapshot)
          if (relation === 'foreign' && !disposed) {
            publish({ error: browserErrorMessage(), loading: false })
          } else if (relation === 'newer' || relation === 'same') {
            acceptFeedback(snapshot.revision, sequence, null)
          }
        })
        .catch(() => {
          if (!state.snapshot) acceptFeedback(0, sequence, browserErrorMessage())
        })
    },
    execute: async (command) => {
      if (disposed) return null
      const sequence = ++nextSequence
      const startedAtRevision = highestObservedRevision
      pendingCommands += 1
      publish({ busy: true, error: null })
      try {
        const outcome = await options.bridge.execute(command)
        if (disposed) return outcome
        const relation = acceptSnapshot(outcome.snapshot)
        if (relation === 'foreign') {
          publish({ error: browserErrorMessage() })
        } else if (relation !== 'older') {
          const authoritativeSnapshot =
            relation === 'same' && state.snapshot ? state.snapshot : outcome.snapshot
          acceptFeedback(
            outcome.snapshot.revision,
            sequence,
            outcome.ok || snapshotHasTabRecovery(authoritativeSnapshot)
              ? null
              : browserErrorMessage(outcome.error)
          )
        }
        return outcome
      } catch {
        acceptFeedback(Math.max(0, startedAtRevision), sequence, browserErrorMessage())
        return null
      } finally {
        pendingCommands = Math.max(0, pendingCommands - 1)
        if (pendingCommands === 0) publish({ busy: false })
      }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      try {
        unsubscribe?.()
      } catch {
        // Renderer cleanup must remain stable even if a bridge implementation is already gone.
      }
      unsubscribe = null
    }
  }
}

export function activeBrowserTab(
  snapshot: BrowserWorkspaceSnapshot | null
): BrowserTabSnapshot | null {
  if (!snapshot?.activeTabId) return null
  return snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId) ?? null
}

export function browserSubmitCommand(
  snapshot: BrowserWorkspaceSnapshot | null,
  address: string,
  requestId: string
): BrowserUiCommand | null {
  const url = address.trim()
  if (!url) return null
  const activeTab = activeBrowserTab(snapshot)
  if (!activeTab) return { type: 'open', requestId, url }
  return {
    type: 'navigate',
    requestId,
    tabId: activeTab.id,
    url,
    expectedDocumentRevision: activeTab.documentRevision
  }
}

export function browserHistoryCommand(
  snapshot: BrowserWorkspaceSnapshot | null,
  direction: 'back' | 'forward',
  requestId: string
): BrowserUiCommand | null {
  const activeTab = activeBrowserTab(snapshot)
  if (!activeTab) return null
  if (direction === 'back' ? !activeTab.canGoBack : !activeTab.canGoForward) return null
  return { type: 'history', requestId, tabId: activeTab.id, direction }
}

export function browserReloadCommand(
  snapshot: BrowserWorkspaceSnapshot | null,
  requestId: string
): BrowserUiCommand | null {
  const activeTab = activeBrowserTab(snapshot)
  if (!activeTab) return null
  return {
    type: activeTab.phase === 'loading' ? 'stop' : 'reload',
    requestId,
    tabId: activeTab.id
  }
}

export function browserRestoreCommand(
  snapshot: BrowserWorkspaceSnapshot | null,
  requestId: string
): BrowserUiCommand | null {
  const activeTab = activeBrowserTab(snapshot)
  return activeTab?.restorable ? { type: 'restore', requestId, tabId: activeTab.id } : null
}

export function browserRetryCommand(
  snapshot: BrowserWorkspaceSnapshot | null,
  requestId: string
): BrowserUiCommand | null {
  const activeTab = activeBrowserTab(snapshot)
  if (!activeTab || (activeTab.phase !== 'failed' && activeTab.phase !== 'crashed')) return null
  if (activeTab.phase === 'crashed') {
    return { type: 'reload', requestId, tabId: activeTab.id }
  }
  if (!activeTab.url || activeTab.url === 'about:blank') {
    return { type: 'reload', requestId, tabId: activeTab.id }
  }
  return {
    type: 'navigate',
    requestId,
    tabId: activeTab.id,
    url: activeTab.url,
    expectedDocumentRevision: activeTab.documentRevision
  }
}

export function canPresentNativeBrowser(
  activeTab: BrowserTabSnapshot | null,
  visible: boolean
): boolean {
  return Boolean(
    visible &&
    activeTab &&
    !activeTab.restorable &&
    activeTab.phase !== 'failed' &&
    activeTab.phase !== 'crashed'
  )
}

export function createBrowserRequestIdFactory(now: () => number = Date.now): () => string {
  let sequence = 0
  return () => `browser-ui-${now().toString(36)}-${(++sequence).toString(36)}`.slice(0, 128)
}
