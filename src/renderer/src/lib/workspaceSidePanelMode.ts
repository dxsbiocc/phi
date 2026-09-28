export type WorkspaceSidePanelMode = 'jobs' | 'terminal' | 'browser'

export function toggleWorkspaceSidePanelMode(
  current: WorkspaceSidePanelMode | null,
  requested: WorkspaceSidePanelMode
): WorkspaceSidePanelMode | null {
  return current === requested ? null : requested
}
