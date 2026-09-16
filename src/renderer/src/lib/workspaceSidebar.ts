export type WorkspaceSidebarMode =
  'conversations' | 'projects' | 'runtime' | 'plugins' | 'skills' | 'mcp' | 'wrappers'

export function workspaceSidebarModeIsExpanded({
  isSidebarOpen,
  workspaceSidebarMode,
  mode
}: {
  activeView: string
  isSidebarOpen: boolean
  workspaceSidebarMode: WorkspaceSidebarMode
  mode: WorkspaceSidebarMode
}): boolean {
  return isSidebarOpen && workspaceSidebarMode === mode
}
