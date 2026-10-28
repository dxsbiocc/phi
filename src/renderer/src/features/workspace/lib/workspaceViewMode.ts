import type { WorkspaceSidebarMode } from '../../../lib/workspaceSidebar'
import type { WorkspaceViewMode } from '../WorkspaceView'

/** The last open file is gone. Home is the chat surface; the project list stays on Projects. */
export function viewAfterLastFileTab(sidebarMode: WorkspaceSidebarMode): 'chat' | 'projects' {
  return sidebarMode === 'projects' ? 'projects' : 'chat'
}

/**
 * Picks the content slot for the workspace column.
 *
 * The precedence is the whole point: open tabs win over the plain analysis
 * canvas, a file preview in the analysis view wins over the notebook canvas,
 * and the placement screen only appears for an empty chat view.
 */
export function workspaceViewModeFor(input: {
  /** A workspace tab strip is showing (sessions, files or resources). */
  showWorkspaceTabs: boolean
  /** The analysis feature owns the column. */
  isAnalysisWorkspaceView: boolean
  /** The analysis view should show a file preview instead of the canvas. */
  analysisFilePreviewAvailable: boolean
  /** The chat view is selected. */
  chatSelected: boolean
  /** Number of visible workspace tabs. */
  visibleTabCount: number
}): WorkspaceViewMode {
  if (input.showWorkspaceTabs) return 'tabs'
  if (input.isAnalysisWorkspaceView) {
    return input.analysisFilePreviewAvailable ? 'file-preview' : 'analysis'
  }
  if (input.chatSelected && input.visibleTabCount === 0) return 'chat-empty'
  return 'chat'
}
