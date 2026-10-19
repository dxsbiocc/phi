import { useCallback } from 'react'

import { resourceUi } from '../../../lib/resourceUi'
import {
  isWorkspaceFileTabKind,
  upsertWorkspaceResourceTab,
  workspaceResourceKindToSidebarMode,
  workspaceResourceTabKey,
  type WorkspaceFileWorkspaceTab,
  type WorkspaceResourceTab,
  type WorkspaceTab
} from '../../../lib/workspaceResourceTabs'
import type { WorkspaceSidebarMode } from '../../../lib/workspaceSidebar'

/**
 * Tab navigation semantics for the workspace tab strip.
 *
 * These callbacks all answer the same question — "what does choosing, opening
 * or closing a tab mean?" — and they share the invariants that make the strip
 * behave: a session tab moves the navigation view, a file tab hands off to the
 * file workspace, a resource tab also selects the matching sidebar item, and
 * closing the active tab falls back to its neighbour.
 *
 * The tab list itself is owned by the caller, because the same list is built
 * from session data the workspace does not own.
 */

/** Views a workspace tab can navigate to. A subset of the app's view union. */
export type WorkspaceNavigationTarget =
  'chat' | 'skills' | 'mcp' | 'wrappers' | 'plugins' | 'runtime'

export type WorkspaceTabNavigationDeps = {
  workspaceTabs: WorkspaceTab[]
  setWorkspaceTabs: (update: WorkspaceTab[] | ((tabs: WorkspaceTab[]) => WorkspaceTab[])) => void
  activeWorkspaceTabKey: string | null
  setActiveWorkspaceTabKey: (key: string | null) => void
  /** Tabs actually shown; closing works on this list, not the stored one. */
  visibleWorkspaceTabs: WorkspaceTab[]
  effectiveActiveWorkspaceTabKey: string | null
  activeSkillId: string | null
  activeMcpServerId: string | null
  selectedWrapperId: string | null
  setWorkspaceSidebarMode: (mode: WorkspaceSidebarMode) => void
  setActiveSkillId: (id: string | null) => void
  setActiveMcpServerId: (id: string | null) => void
  setSelectedWrapperId: (id: string | null) => void
  setSessionTabWasOpened: (value: boolean) => void
  setClosedWorkspaceSessionTabKeys: (update: (keys: Set<string>) => Set<string>) => void
  navigateToView: (view: WorkspaceNavigationTarget) => void
  onSelectSession: (sessionPath: string) => Promise<unknown>
  acknowledgeActiveSession: (options: { force: boolean }) => Promise<unknown>
  onSelectWorkspaceFileTab: (tab: WorkspaceFileWorkspaceTab) => void
  onCloseWorkspaceFileTab: (tab: WorkspaceFileWorkspaceTab) => void
  /** Closes the sidebar hover preview so a click is not stolen by it. */
  closeWorkspaceSidebarPreview: () => void
  /** Reads the session currently shown, to avoid re-selecting it. */
  activeSessionPath: string | null
}

export type WorkspaceTabNavigation = {
  upsertTab: (tab: WorkspaceTab) => void
  selectTab: (tab: WorkspaceTab) => void
  /** Header/strip entry point: drops the sidebar preview before selecting. */
  selectTabFromChrome: (tab: WorkspaceTab) => void
  closeTab: (tab: WorkspaceTab) => void
  openResourceTab: (tab: Omit<WorkspaceResourceTab, 'key'>) => void
  openPluginsTab: () => void
  openPluginTab: (plugin: {
    id: string
    title: string
    icon?: WorkspaceResourceTab['icon']
    directory?: string
  }) => void
  openSkillTab: (skill: {
    id: string
    name: string
    icon?: WorkspaceResourceTab['icon']
    filePath: string
  }) => void
}

function isWorkspaceFileWorkspaceTab(
  tab: WorkspaceTab | null | undefined
): tab is WorkspaceFileWorkspaceTab {
  return Boolean(tab && isWorkspaceFileTabKind(tab.kind))
}

type SelectionContext = Pick<
  WorkspaceTabNavigationDeps,
  | 'setActiveWorkspaceTabKey'
  | 'setWorkspaceSidebarMode'
  | 'setActiveSkillId'
  | 'setActiveMcpServerId'
  | 'setSelectedWrapperId'
  | 'setSessionTabWasOpened'
  | 'setClosedWorkspaceSessionTabKeys'
  | 'navigateToView'
  | 'onSelectSession'
  | 'acknowledgeActiveSession'
  | 'onSelectWorkspaceFileTab'
  | 'activeSessionPath'
>

/** Applies the side effects of choosing a tab. */
function applySelectTab(context: SelectionContext, tab: WorkspaceTab): void {
  context.setActiveWorkspaceTabKey(tab.key)
  if (tab.kind === 'session') {
    context.setSessionTabWasOpened(true)
    context.setClosedWorkspaceSessionTabKeys((keys) => {
      if (!keys.has(tab.key)) return keys
      const nextKeys = new Set(keys)
      nextKeys.delete(tab.key)
      return nextKeys
    })
    context.setWorkspaceSidebarMode(tab.sidebarMode)
    context.navigateToView('chat')
    if (tab.sessionPath && tab.sessionPath !== context.activeSessionPath) {
      void context.onSelectSession(tab.sessionPath)
    } else {
      void context.acknowledgeActiveSession({ force: true })
    }
    return
  }

  if (isWorkspaceFileWorkspaceTab(tab)) {
    context.onSelectWorkspaceFileTab(tab)
    return
  }

  context.setWorkspaceSidebarMode(workspaceResourceKindToSidebarMode(tab.kind))
  if (tab.kind === 'skills') {
    context.setActiveSkillId(tab.itemId)
  } else if (tab.kind === 'mcp') {
    context.setActiveMcpServerId(tab.itemId)
  } else if (tab.kind === 'wrappers') {
    context.setSelectedWrapperId(tab.itemId)
  }
  context.navigateToView(tab.kind)
}

type ClosingContext = Pick<
  WorkspaceTabNavigationDeps,
  | 'visibleWorkspaceTabs'
  | 'effectiveActiveWorkspaceTabKey'
  | 'activeSkillId'
  | 'activeMcpServerId'
  | 'selectedWrapperId'
  | 'setWorkspaceTabs'
  | 'setActiveWorkspaceTabKey'
  | 'setActiveSkillId'
  | 'setActiveMcpServerId'
  | 'setSelectedWrapperId'
  | 'setSessionTabWasOpened'
  | 'setClosedWorkspaceSessionTabKeys'
  | 'navigateToView'
  | 'onCloseWorkspaceFileTab'
> & { selectTab: (tab: WorkspaceTab) => void }

/** Applies the side effects of closing a tab, including the fallback selection. */
function applyCloseTab(context: ClosingContext, tab: WorkspaceTab): void {
  const closingIndex = context.visibleWorkspaceTabs.findIndex((item) => item.key === tab.key)
  if (closingIndex === -1) return
  const remainingTabs = context.visibleWorkspaceTabs.filter((item) => item.key !== tab.key)
  if (tab.kind === 'session') {
    context.setSessionTabWasOpened(false)
    context.setClosedWorkspaceSessionTabKeys((keys) => {
      if (keys.has(tab.key)) return keys
      const nextKeys = new Set(keys)
      nextKeys.add(tab.key)
      return nextKeys
    })
  } else if (isWorkspaceFileWorkspaceTab(tab)) {
    context.onCloseWorkspaceFileTab(tab)
  } else {
    context.setWorkspaceTabs((tabs) => tabs.filter((item) => item.key !== tab.key))
  }

  // A resource tab also owns the sidebar highlight, and the sidebar's selection
  // is independent of which tab is active: clicking a resource icon switches
  // the sidebar mode without touching the active tab. So closing the tab has to
  // clear the highlight itself, otherwise the sidebar keeps showing a selection
  // whose tab is gone.
  if (tab.kind === 'skills' && context.activeSkillId === tab.itemId) {
    context.setActiveSkillId(null)
  } else if (tab.kind === 'mcp' && context.activeMcpServerId === tab.itemId) {
    context.setActiveMcpServerId(null)
  } else if (tab.kind === 'wrappers' && context.selectedWrapperId === tab.itemId) {
    context.setSelectedWrapperId(null)
  }

  if (tab.key !== context.effectiveActiveWorkspaceTabKey) return

  const nextTab = remainingTabs[Math.min(closingIndex, remainingTabs.length - 1)] ?? null
  if (nextTab) {
    context.selectTab(nextTab)
    return
  }
  context.setActiveWorkspaceTabKey(null)
  context.navigateToView('chat')
}

function useWorkspaceResourceTabOpening({
  upsertTab,
  selectTab,
  setActiveSkillId
}: {
  upsertTab: (tab: WorkspaceTab) => void
  selectTab: (tab: WorkspaceTab) => void
  setActiveSkillId: (id: string | null) => void
}): Pick<
  WorkspaceTabNavigation,
  'openResourceTab' | 'openPluginsTab' | 'openPluginTab' | 'openSkillTab'
> {
  const openResourceTab = useCallback(
    (tab: Omit<WorkspaceResourceTab, 'key'>): void => {
      const nextTab: WorkspaceResourceTab = { ...tab, key: workspaceResourceTabKey(tab.kind) }
      upsertTab(nextTab)
      selectTab(nextTab)
    },
    [selectTab, upsertTab]
  )

  const openPluginsTab = useCallback((): void => {
    openResourceTab({ kind: 'plugins', itemId: 'installed', title: resourceUi.plugins })
  }, [openResourceTab])

  const openPluginTab = useCallback(
    (plugin: {
      id: string
      title: string
      icon?: WorkspaceResourceTab['icon']
      directory?: string
    }): void => {
      openResourceTab({
        kind: 'plugins',
        itemId: plugin.id,
        title: plugin.title,
        icon: plugin.icon,
        subtitle: plugin.directory
      })
    },
    [openResourceTab]
  )

  const openSkillTab = useCallback(
    (skill: {
      id: string
      name: string
      icon?: WorkspaceResourceTab['icon']
      filePath: string
    }): void => {
      setActiveSkillId(skill.id)
      openResourceTab({
        kind: 'skills',
        itemId: skill.id,
        title: skill.name,
        icon: skill.icon,
        subtitle: skill.filePath
      })
    },
    [openResourceTab, setActiveSkillId]
  )

  return { openResourceTab, openPluginsTab, openPluginTab, openSkillTab }
}

export function useWorkspaceTabNavigation(
  deps: WorkspaceTabNavigationDeps
): WorkspaceTabNavigation {
  const {
    setWorkspaceTabs,
    visibleWorkspaceTabs,
    effectiveActiveWorkspaceTabKey,
    activeSkillId,
    activeMcpServerId,
    selectedWrapperId,
    setActiveSkillId,
    closeWorkspaceSidebarPreview
  } = deps

  const upsertTab = useCallback(
    (tab: WorkspaceTab): void => {
      setWorkspaceTabs((tabs) => upsertWorkspaceResourceTab(tabs, tab))
    },
    [setWorkspaceTabs]
  )

  // Callers pass a fresh deps object each render, so the memoized callbacks
  // list the individual fields they read instead of the object itself.
  const selectTab = useCallback(
    (tab: WorkspaceTab): void => {
      applySelectTab(deps, tab)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      deps.activeSessionPath,
      deps.acknowledgeActiveSession,
      deps.navigateToView,
      deps.onSelectSession,
      deps.onSelectWorkspaceFileTab,
      deps.setActiveMcpServerId,
      deps.setActiveSkillId,
      deps.setActiveWorkspaceTabKey,
      deps.setClosedWorkspaceSessionTabKeys,
      deps.setSelectedWrapperId,
      deps.setSessionTabWasOpened,
      deps.setWorkspaceSidebarMode
    ]
  )

  const selectTabFromChrome = useCallback(
    (tab: WorkspaceTab): void => {
      closeWorkspaceSidebarPreview()
      selectTab(tab)
    },
    [closeWorkspaceSidebarPreview, selectTab]
  )

  const closeTab = useCallback(
    (tab: WorkspaceTab): void => {
      applyCloseTab({ ...deps, selectTab }, tab)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeMcpServerId,
      activeSkillId,
      deps.navigateToView,
      deps.onCloseWorkspaceFileTab,
      deps.setActiveMcpServerId,
      deps.setActiveSkillId,
      deps.setActiveWorkspaceTabKey,
      deps.setClosedWorkspaceSessionTabKeys,
      deps.setSelectedWrapperId,
      deps.setSessionTabWasOpened,
      deps.setWorkspaceTabs,
      effectiveActiveWorkspaceTabKey,
      selectTab,
      selectedWrapperId,
      visibleWorkspaceTabs
    ]
  )

  const { openResourceTab, openPluginsTab, openPluginTab, openSkillTab } =
    useWorkspaceResourceTabOpening({ upsertTab, selectTab, setActiveSkillId })

  return {
    upsertTab,
    selectTab,
    selectTabFromChrome,
    closeTab,
    openResourceTab,
    openPluginsTab,
    openPluginTab,
    openSkillTab
  }
}
