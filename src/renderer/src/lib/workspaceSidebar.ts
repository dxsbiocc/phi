export type WorkspaceSidebarMode = 'conversations' | 'projects'

export function workspaceSidebarModeIsExpanded({
  activeView,
  isSidebarOpen,
  workspaceSidebarMode,
  mode
}: {
  activeView: string
  isSidebarOpen: boolean
  workspaceSidebarMode: WorkspaceSidebarMode
  mode: WorkspaceSidebarMode
}): boolean {
  return (
    isSidebarOpen &&
    (activeView === 'chat' || activeView === 'projects') &&
    workspaceSidebarMode === mode
  )
}
