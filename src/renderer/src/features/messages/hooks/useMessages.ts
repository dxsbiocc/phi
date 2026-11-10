import { useSyncExternalStore } from 'react'

import type { AppUpdateCheck } from '../../../../../shared/appUpdateTypes'
import type { PackageUpdateView } from '../../../../../shared/packageManagerTypes'
import {
  markMessageRead,
  readMessageReadIds,
  unreadMessageCount,
  writeMessageReadIds
} from '../lib/messageReadState'
import { messageIdsForContent } from '../lib/messages'

/** A few seconds after startup, once the window and preload bridge are ready. */
const APP_UPDATE_CHECK_DELAY_MS = 3000

type MessagesSnapshot = {
  packageUpdates: readonly PackageUpdateView[]
  appUpdate: AppUpdateCheck | null
  readIds: ReadonlySet<string>
  loaded: boolean
}

const EMPTY_SNAPSHOT: MessagesSnapshot = {
  packageUpdates: [],
  appUpdate: null,
  readIds: new Set(),
  loaded: false
}

class MessagesStore {
  private state: MessagesSnapshot = {
    ...EMPTY_SNAPSHOT,
    readIds: readMessageReadIds()
  }
  private readonly listeners = new Set<() => void>()
  private started = false
  private appCheckStarted = false

  getSnapshot = (): MessagesSnapshot => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    this.start()
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * A message becomes read only when the user opens it. The stored ids are
   * pruned to the messages that still exist on every write.
   */
  markRead = (messageId: string): void => {
    const messageIds = messageIdsForContent(this.state.packageUpdates, this.state.appUpdate)
    const readIds = markMessageRead(this.state.readIds, messageIds, messageId)
    this.state = { ...this.state, readIds }
    writeMessageReadIds(readIds)
    this.emit()
  }

  readonly refreshPackageUpdates = async (): Promise<void> => {
    try {
      const api = typeof window === 'undefined' ? undefined : window.api
      if (typeof api?.listPackageUpdates !== 'function') return
      const next = await api.listPackageUpdates()
      if (Array.isArray(next)) this.setPackageUpdates(next)
    } catch {
      this.setLoaded()
    }
  }

  private readonly setPackageUpdates = (packageUpdates: readonly PackageUpdateView[]): void => {
    this.state = { ...this.state, packageUpdates, loaded: true }
    this.emit()
  }

  private readonly setLoaded = (): void => {
    if (this.state.loaded) return
    this.state = { ...this.state, loaded: true }
    this.emit()
  }

  private start(): void {
    if (this.started) return
    this.started = true
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) return
    api.onPackageUpdatesAvailable?.((next) => this.setPackageUpdates(next))
    void this.refreshPackageUpdates()
    window.setTimeout(() => {
      void this.checkAppUpdate()
    }, APP_UPDATE_CHECK_DELAY_MS)
  }

  private readonly checkAppUpdate = async (): Promise<void> => {
    if (this.appCheckStarted) return
    this.appCheckStarted = true
    try {
      const api = typeof window === 'undefined' ? undefined : window.api
      if (typeof api?.checkForAppUpdates !== 'function') return
      const result = await api.checkForAppUpdates()
      this.state = {
        ...this.state,
        appUpdate: result.status === 'available' ? result : null
      }
      this.emit()
    } catch {
      // Update checks stay silent; no message is better than a stale error notice.
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

let shared: MessagesStore | undefined

function messagesStore(): MessagesStore {
  return (shared ??= new MessagesStore())
}

/** The toolbar subscribes only to the count, not to every message list change. */
export function useUnreadMessageCount(): number {
  const store = messagesStore()
  return useSyncExternalStore(
    store.subscribe,
    () => {
      const snapshot = store.getSnapshot()
      return unreadMessageCount(
        messageIdsForContent(snapshot.packageUpdates, snapshot.appUpdate),
        snapshot.readIds
      )
    },
    () => 0
  )
}

export function useMessages(): MessagesSnapshot & {
  markRead: (messageId: string) => void
  refreshPackageUpdates: () => Promise<void>
} {
  const store = messagesStore()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return {
    ...snapshot,
    markRead: store.markRead,
    refreshPackageUpdates: store.refreshPackageUpdates
  }
}
