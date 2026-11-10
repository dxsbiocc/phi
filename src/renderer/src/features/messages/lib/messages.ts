import type { AppUpdateCheck } from '../../../../../shared/appUpdateTypes'
import type {
  PackageManagerType,
  PackageUpdateView
} from '../../../../../shared/packageManagerTypes'
import { phiPluginDisplayTitle } from '../../phi-plugin/lib/phiPlugins'
import { messagesCopy } from './messagesCopy'

export type MessageKind = 'package-update' | 'app-update'

export interface Message {
  /** Stable while the message content is unchanged. */
  id: string
  kind: MessageKind
  title: string
  subtitle: string
  status: string
  /** Set on content package messages; each one opens its own update dialog. */
  packageType?: PackageManagerType
  packageUpdate?: PackageUpdateView
  releasesUrl?: string
}

/** A newer package version produces a new id, so the message returns as unread. */
export function packageUpdateMessageId(update: PackageUpdateView): string {
  return `package:${update.type}:${update.id}@${update.newVersion}`
}

export function appUpdateMessageId(version: string): string {
  return `app@${version}`
}

/** Message identities only; resolved sources contribute no id. */
export function messageIdsForContent(
  updates: readonly PackageUpdateView[],
  appUpdate: AppUpdateCheck | null
): string[] {
  const ids = updates.map(packageUpdateMessageId)
  if (appUpdate?.status === 'available' && appUpdate.latestVersion) {
    ids.push(appUpdateMessageId(appUpdate.latestVersion))
  }
  return ids
}

/** Unread messages first, then read ones; each group keeps the build order. */
export function orderMessagesByReadState(
  messages: readonly Message[],
  readIds: ReadonlySet<string>
): Message[] {
  const unread: Message[] = []
  const read: Message[] = []
  for (const message of messages) {
    const group = readIds.has(message.id) ? read : unread
    group.push(message)
  }
  return [...unread, ...read]
}

/**
 * Builds display copy at render time, so a language switch refreshes titles
 * without changing the stable ids or the read state.
 */
export function buildMessages({
  updates,
  appUpdate
}: {
  updates: readonly PackageUpdateView[]
  appUpdate: AppUpdateCheck | null
}): Message[] {
  const messages: Message[] = updates.map((update) => ({
    id: packageUpdateMessageId(update),
    kind: 'package-update',
    title:
      update.type === 'plugin'
        ? phiPluginDisplayTitle({ id: update.id, title: update.title })
        : update.title,
    subtitle: messagesCopy.versionChange(update.currentVersion, update.newVersion),
    status: messagesCopy.packageUpdateStatus,
    packageType: update.type,
    packageUpdate: update
  }))
  if (appUpdate?.status === 'available' && appUpdate.latestVersion) {
    messages.push({
      id: appUpdateMessageId(appUpdate.latestVersion),
      kind: 'app-update',
      title: messagesCopy.appUpdateAvailable(appUpdate.latestVersion),
      subtitle: messagesCopy.currentVersion(appUpdate.currentVersion),
      status: messagesCopy.appUpdateStatus,
      releasesUrl: appUpdate.releasesUrl
    })
  }
  return messages
}
