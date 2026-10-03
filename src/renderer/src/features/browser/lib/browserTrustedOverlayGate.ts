import type { BrowserRendererBridge } from '../../../../../shared/browserTypes'

export type BrowserTrustedOverlayKind = 'auth' | 'approval' | 'interaction' | 'local'

export interface BrowserTrustedOverlayRequest {
  kind: BrowserTrustedOverlayKind
  key: string
  publish(): void
  onCancel?(): void | Promise<void>
}

interface QueuedOverlayRequest extends BrowserTrustedOverlayRequest {
  token: number
  cancelled: boolean
  hideAttempts: number
  fallbackAttempted: boolean
}

export interface BrowserTrustedOverlayGate {
  enqueue(request: BrowserTrustedOverlayRequest): void
  cancel(kind: BrowserTrustedOverlayKind, key?: string, notify?: boolean): void
  dispose(): void
}

export async function hideActiveBrowserViewport(
  bridge: BrowserRendererBridge,
  sessionId: string | null,
  sessionGeneration: number
): Promise<boolean> {
  try {
    const snapshot = await bridge.snapshot()
    const activeTab = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId)
    if (activeTab && !activeTab.restorable) {
      if (!sessionId || snapshot.sessionId !== sessionId) return false
      await bridge.setViewport({
        sessionId,
        sessionGeneration,
        tabId: activeTab.id,
        viewport: null
      })
    }
    return true
  } catch {
    return false
  }
}

export function createBrowserTrustedOverlayGate(options: {
  hide(): Promise<boolean>
  onHideFailure(): void
  onRequestFailure?(kind: BrowserTrustedOverlayKind): void
  onSuspendedChange(suspended: boolean): void
  setTimer(callback: () => void, delayMs: number): number
  clearTimer(id: number): void
  requestFrame(callback: () => void): number
  cancelFrame(id: number): void
  hideTimeoutMs?: number
  retryDelayMs?: number
  maxHideAttempts?: number
}): BrowserTrustedOverlayGate {
  const queue: QueuedOverlayRequest[] = []
  let nextToken = 0
  let disposed = false
  let processing = false
  let retryTimer: number | null = null
  let releaseFrameOne: number | null = null
  let releaseFrameTwo: number | null = null
  let releaseGeneration = 0
  let suspended = false

  const setSuspended = (next: boolean): void => {
    if (suspended === next) return
    suspended = next
    options.onSuspendedChange(next)
  }
  const cancelReleaseFrames = (): void => {
    releaseGeneration += 1
    if (releaseFrameOne !== null) options.cancelFrame(releaseFrameOne)
    if (releaseFrameTwo !== null) options.cancelFrame(releaseFrameTwo)
    releaseFrameOne = null
    releaseFrameTwo = null
  }
  const releaseWhenSettled = (): void => {
    if (disposed || queue.length > 0 || processing || retryTimer !== null) return
    cancelReleaseFrames()
    const generation = releaseGeneration
    releaseFrameOne = options.requestFrame(() => {
      releaseFrameOne = null
      if (disposed || generation !== releaseGeneration || queue.length > 0) return
      releaseFrameTwo = options.requestFrame(() => {
        releaseFrameTwo = null
        if (disposed || generation !== releaseGeneration || queue.length > 0) return
        setSuspended(false)
      })
    })
  }
  const hideWithTimeout = (): Promise<boolean> =>
    new Promise((resolve) => {
      let settled = false
      let timeout: number | null = null
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        if (timeout !== null) options.clearTimer(timeout)
        resolve(value)
      }
      timeout = options.setTimer(() => finish(false), options.hideTimeoutMs ?? 750)
      void options.hide().then(
        (hidden) => finish(hidden),
        () => finish(false)
      )
    })

  const process = async (): Promise<void> => {
    if (disposed || processing || retryTimer !== null) return
    const request = queue[0]
    if (!request) {
      releaseWhenSettled()
      return
    }
    processing = true
    const token = request.token
    const hidden = await hideWithTimeout()
    if (disposed || request.cancelled || queue[0]?.token !== token) {
      processing = false
      void process()
      return
    }
    if (!hidden) {
      request.hideAttempts += 1
      if (!request.fallbackAttempted) {
        request.fallbackAttempted = true
        try {
          options.onHideFailure()
        } catch {
          // Retain the request and continue the bounded retry loop.
        }
      }
      if (disposed || request.cancelled || queue[0]?.token !== token) {
        processing = false
        void process()
        return
      }
      if (request.hideAttempts >= (options.maxHideAttempts ?? 3)) {
        queue.shift()
        processing = false
        try {
          void Promise.resolve(request.onCancel?.()).catch(() => undefined)
        } catch {
          // Infrastructure failure must not strand the rest of the trusted queue.
        }
        try {
          options.onRequestFailure?.(request.kind)
        } catch {
          // Reporting failure cannot block later trusted overlays.
        }
        void process()
        return
      }
      processing = false
      retryTimer = options.setTimer(() => {
        retryTimer = null
        void process()
      }, options.retryDelayMs ?? 250)
      return
    }

    queue.shift()
    processing = false
    try {
      request.publish()
    } catch {
      // A renderer callback cannot break later trusted overlay requests.
    }
    void process()
  }

  const cancel = (kind: BrowserTrustedOverlayKind, key?: string, notify = false): void => {
    const removed = queue.filter(
      (request) => request.kind === kind && (key === undefined || request.key === key)
    )
    for (const request of removed) request.cancelled = true
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (removed.includes(queue[index])) queue.splice(index, 1)
    }
    if (retryTimer !== null) {
      options.clearTimer(retryTimer)
      retryTimer = null
    }
    if (notify) {
      for (const request of removed) {
        try {
          void Promise.resolve(request.onCancel?.()).catch(() => undefined)
        } catch {
          continue
        }
      }
    }
    if (!processing) void process()
  }

  return {
    enqueue: (request) => {
      if (disposed) {
        try {
          void Promise.resolve(request.onCancel?.()).catch(() => undefined)
        } catch {
          return
        }
        return
      }
      cancelReleaseFrames()
      setSuspended(true)
      queue.push({
        ...request,
        token: ++nextToken,
        cancelled: false,
        hideAttempts: 0,
        fallbackAttempted: false
      })
      void process()
    },
    cancel,
    dispose: () => {
      if (disposed) return
      disposed = true
      cancelReleaseFrames()
      if (retryTimer !== null) options.clearTimer(retryTimer)
      retryTimer = null
      const pending = queue.splice(0)
      for (const request of pending) {
        request.cancelled = true
        try {
          void Promise.resolve(request.onCancel?.()).catch(() => undefined)
        } catch {
          continue
        }
      }
      setSuspended(false)
    }
  }
}
