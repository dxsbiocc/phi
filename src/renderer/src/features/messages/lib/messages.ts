import type { AppUpdateCheck } from '../../../../../shared/appUpdateTypes'
import type { PackageUpdateView } from '../../../../../shared/packageManagerTypes'
import { settingsUi } from '../../settings/lib/settingsUi'
import { messagesCopy } from './messagesCopy'

export type MessageKind = 'package-updates' | 'app-update'

export interface Message {
  /** Stable while the message content is unchanged. */
  id: string
  kind: MessageKind
  title: string
  subtitle: string
  status: string
  packageUpdates?: readonly PackageUpdateView[]
  releasesUrl?: string
}

/** The package keys whose set defines the package-update message identity. */
export function packageUpdateKeys(updates: readonly PackageUpdateView[]): string[] {
  return updates.map((update) => `${update.type}:${update.id}@${update.newVersion}`).sort()
}

export function packageUpdatesMessageId(updates: readonly PackageUpdateView[]): string {
  return packageUpdateKeys(updates).join('|')
}

export function appUpdateMessageId(version: string): string {
  return `app@${version}`
}

/** Message identities only; resolved sources contribute no id. */
export function messageIdsForContent(
  updates: readonly PackageUpdateView[],
  appUpdate: AppUpdateCheck | null
): string[] {
  const ids: string[] = []
  if (updates.length > 0) ids.push(packageUpdatesMessageId(updates))
  if (appUpdate?.status === 'available' && appUpdate.latestVersion) {
    ids.push(appUpdateMessageId(appUpdate.latestVersion))
  }
  return ids
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
  const messages: Message[] = []
  if (updates.length > 0) {
    messages.push({
      id: packageUpdatesMessageId(updates),
      kind: 'package-updates',
      title: settingsUi.valueContentPackageUpdatesAvailable(updates.length),
      subtitle: messagesCopy.packageNames(updates.map((update) => update.title)),
      status: messagesCopy.packageUpdatesStatus,
      packageUpdates: updates
    })
  }
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
