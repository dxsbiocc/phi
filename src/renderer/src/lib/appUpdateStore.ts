import { useSyncExternalStore } from 'react'

import type { AppUpdateDownloadState } from '../../../shared/appUpdateTypes'
import { errorMessage } from '../../../shared/errorCodes'

const INITIAL_DOWNLOAD_STATE: AppUpdateDownloadState = {
  stage: 'idle',
  downloadedBytes: 0,
  totalBytes: 0,
  percent: null
}

class AppUpdateDownloadStore {
  private state: AppUpdateDownloadState = INITIAL_DOWNLOAD_STATE
  private readonly listeners = new Set<() => void>()
  private started = false

  getSnapshot = (): AppUpdateDownloadState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    this.start()
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly startDownload = async (): Promise<void> => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (typeof api?.downloadAppUpdate !== 'function') return
    try {
      const next = await api.downloadAppUpdate()
      this.setState(next)
    } catch (error) {
      this.setState({
        ...this.state,
        stage: 'error',
        error: errorMessage(error)
      })
    }
  }

  readonly cancelDownload = async (): Promise<void> => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (typeof api?.cancelAppUpdateDownload !== 'function') return
    try {
      const next = await api.cancelAppUpdateDownload()
      this.setState(next)
    } catch {
      // Best-effort cancellation.
    }
  }

  readonly installUpdate = async (): Promise<void> => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (typeof api?.installAppUpdate !== 'function') return
    try {
      await api.installAppUpdate()
    } catch (error) {
      this.setState({
        ...this.state,
        stage: 'error',
        error: errorMessage(error)
      })
    }
  }

  private start(): void {
    if (this.started) return
    this.started = true
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) return
    api.onAppUpdateDownloadState?.((next) => this.setState(next))
    if (typeof api.getAppUpdateDownloadState === 'function') {
      void api
        .getAppUpdateDownloadState()
        .then((next) => {
          if (next) this.setState(next)
        })
        .catch(() => undefined)
    }
  }

  private setState(next: AppUpdateDownloadState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

let sharedStore: AppUpdateDownloadStore | undefined

function getStore(): AppUpdateDownloadStore {
  return (sharedStore ??= new AppUpdateDownloadStore())
}

export function useAppUpdateDownload(): {
  downloadState: AppUpdateDownloadState
  startDownload: () => Promise<void>
  cancelDownload: () => Promise<void>
  installUpdate: () => Promise<void>
} {
  const store = getStore()
  const downloadState = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return {
    downloadState,
    startDownload: store.startDownload,
    cancelDownload: store.cancelDownload,
    installUpdate: store.installUpdate
  }
}
