import { navigationCopy } from './navigationCopy'
import type { WorkspaceSidebarMode } from './workspaceSidebar'
import type { ResourceIconRef } from '../../../shared/resourceIconTypes'
import { resourceUi } from './resourceUi'

export type WorkspaceResourceKind = 'runtime' | 'plugins' | 'skills' | 'mcp' | 'wrappers'
export type WorkspaceFileTabKind = 'file' | 'directory' | 'notebook'
export type WorkspaceTabKind = 'session' | WorkspaceResourceKind | WorkspaceFileTabKind

export type WorkspaceSessionTab = {
  key: string
  kind: 'session'
  itemId: string
  title: string
  subtitle?: string
  sessionPath: string | null
  sessionGeneration: number
  sidebarMode: Extract<WorkspaceSidebarMode, 'conversations' | 'projects'>
}

export type WorkspaceResourceTab = {
  icon?: ResourceIconRef
  key: string
  kind: WorkspaceResourceKind
  itemId: string
  title: string
  subtitle?: string
  connectorId?: string
  connectorUrl?: string
}

export type WorkspaceFileWorkspaceTab = {
  key: string
  kind: WorkspaceFileTabKind
  id: string
  itemId: string
  name: string
  status: string
  title: string
  subtitle?: string
  path: string
  pathKind: 'file' | 'directory'
  absolutePath: string
  dirty?: boolean
}

export type WorkspaceTab = WorkspaceSessionTab | WorkspaceResourceTab | WorkspaceFileWorkspaceTab

export function isWorkspaceFileWorkspaceTab(
  tab: WorkspaceTab | null | undefined
): tab is WorkspaceFileWorkspaceTab {
  return Boolean(tab && isWorkspaceFileTabKind(tab.kind))
}

const resourceLabels: Record<WorkspaceResourceKind, string> = {
  get runtime() {
    return navigationCopy.runtime
  },
  get plugins() {
    return resourceUi.plugins
  },
  get skills() {
    return resourceUi.skills
  },
  get mcp() {
    return resourceUi.connectors
  },
  get wrappers() {
    return resourceUi.wrappers
  }
}

const tabLabels: Record<WorkspaceTabKind, string> = {
  get session() {
    return navigationCopy.conversation
  },
  get runtime() {
    return resourceLabels.runtime
  },
  get plugins() {
    return resourceLabels.plugins
  },
  get skills() {
    return resourceLabels.skills
  },
  get mcp() {
    return resourceLabels.mcp
  },
  get wrappers() {
    return resourceLabels.wrappers
  },
  get file() {
    return navigationCopy.file
  },
  get directory() {
    return navigationCopy.folder
  },
  notebook: 'Notebook'
}

export function workspaceSessionTabKey(path: string | null, sessionGeneration: number): string {
  return path ? `session:${path}` : `session:fresh:${sessionGeneration}`
}

/**
 * A finished prompt moves the active tab to the session's own tab, but only from a session tab. With the
 * conversation docked in the sidebar the user may be viewing a file, Office draft or resource tab, and
 * switching away from it would blank the pane they are watching.
 */
export function activeTabKeyAfterPrompt(currentKey: string | null, sessionTabKey: string): string {
  return currentKey === null || currentKey.startsWith('session:') ? sessionTabKey : currentKey
}

export function visibleWorkspaceTabsForState({
  currentSessionTab,
  workspaceTabs,
  workspaceFileTabs,
  closedSessionTabKeys,
  shouldShowSessionTab,
  sessionTabWasOpened
}: {
  currentSessionTab: WorkspaceSessionTab
  workspaceTabs: WorkspaceTab[]
  workspaceFileTabs: WorkspaceFileWorkspaceTab[]
  closedSessionTabKeys: ReadonlySet<string>
  shouldShowSessionTab: boolean
  sessionTabWasOpened: boolean
}): WorkspaceTab[] {
  const staleFreshSessionKey =
    currentSessionTab.sessionPath === null
      ? null
      : workspaceSessionTabKey(null, currentSessionTab.sessionGeneration)
  const normalizedTabs = workspaceTabs.filter(
    (tab) =>
      tab.key !== staleFreshSessionKey &&
      ((shouldShowSessionTab && sessionTabWasOpened) || tab.kind !== 'session')
  )
  const withFiles = [...normalizedTabs, ...workspaceFileTabs]
  if (
    !shouldShowSessionTab ||
    !sessionTabWasOpened ||
    closedSessionTabKeys.has(currentSessionTab.key)
  ) {
    return withFiles
  }
  const existingIndex = withFiles.findIndex((tab) => tab.key === currentSessionTab.key)
  if (existingIndex === -1) return [currentSessionTab, ...withFiles]
  return withFiles.map((tab, index) =>
    index === existingIndex ? { ...tab, ...currentSessionTab } : tab
  )
}

export function workspaceResourceTabKey(kind: WorkspaceResourceKind): string {
  return kind
}

export function upsertWorkspaceResourceTab(
  tabs: WorkspaceTab[],
  tab: WorkspaceTab
): WorkspaceTab[] {
  if (isWorkspaceResourceKind(tab.kind)) {
    const firstIndex = tabs.findIndex((item) => item.kind === tab.kind)
    const remaining = tabs.filter((item) => item.kind !== tab.kind)
    remaining.splice(firstIndex < 0 ? remaining.length : firstIndex, 0, tab)
    return remaining
  }
  const existingIndex = tabs.findIndex((item) => item.key === tab.key)
  if (existingIndex === -1) return [...tabs, tab]
  return tabs.map((item, index) => (index === existingIndex ? { ...item, ...tab } : item))
}

type ResourceIconMetadata = { id: string; icon?: ResourceIconRef }

/** Open tabs follow current resource metadata, including refreshed process-scoped icon keys. */
export function resolveWorkspaceResourceTabIcons(
  tabs: WorkspaceTab[],
  resources: Record<Exclude<WorkspaceResourceKind, 'runtime'>, readonly ResourceIconMetadata[]>
): WorkspaceTab[] {
  return tabs.map((tab) => {
    if (
      tab.kind !== 'plugins' &&
      tab.kind !== 'skills' &&
      tab.kind !== 'mcp' &&
      tab.kind !== 'wrappers'
    )
      return tab
    const icon = resources[tab.kind].find((resource) => resource.id === tab.itemId)?.icon
    return icon?.key === tab.icon?.key ? tab : { ...tab, icon }
  })
}

export function workspaceFileTabKey(path: string): string {
  return `file:${path}`
}

export function isWorkspaceResourceKind(value: string): value is WorkspaceResourceKind {
  return (
    value === 'runtime' ||
    value === 'plugins' ||
    value === 'skills' ||
    value === 'mcp' ||
    value === 'wrappers'
  )
}

export function isWorkspaceFileTabKind(value: string): value is WorkspaceFileTabKind {
  return value === 'file' || value === 'directory' || value === 'notebook'
}

export function workspaceResourceKindToSidebarMode(
  kind: WorkspaceResourceKind
): WorkspaceSidebarMode {
  return kind
}

export function workspaceResourceKindLabel(kind: WorkspaceResourceKind): string {
  return resourceLabels[kind]
}

export function workspaceTabKindLabel(kind: WorkspaceTabKind): string {
  return tabLabels[kind]
}
