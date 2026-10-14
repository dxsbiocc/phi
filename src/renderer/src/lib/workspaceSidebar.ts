export type WorkspaceSidebarMode =
  'conversations' | 'projects' | 'files' | 'runtime' | 'plugins' | 'skills' | 'mcp' | 'wrappers'

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
  // A docked chat occupies the sidebar, but its conversation list is still collapsed.
  return (
    isSidebarOpen &&
    workspaceSidebarMode === mode &&
    !(activeView === 'analysis' && mode === 'conversations')
  )
}
