import type { WorkspaceSidebarMode } from './workspaceSidebar'

export type WorkspaceResourceKind = 'runtime' | 'plugins' | 'skills' | 'mcp' | 'wrappers'
export type WorkspaceTabKind = 'session' | WorkspaceResourceKind

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
  key: string
  kind: WorkspaceResourceKind
  itemId: string
  title: string
  subtitle?: string
}

export type WorkspaceTab = WorkspaceSessionTab | WorkspaceResourceTab

const resourceLabels: Record<WorkspaceResourceKind, string> = {
  runtime: '运行时',
  plugins: '插件',
  skills: '技能',
  mcp: 'MCP',
  wrappers: 'Wrappers'
}

const tabLabels: Record<WorkspaceTabKind, string> = {
  session: '会话',
  ...resourceLabels
}

export function workspaceSessionTabKey(path: string | null, sessionGeneration: number): string {
  return path ? `session:${path}` : `session:fresh:${sessionGeneration}`
}

export function workspaceResourceTabKey(kind: WorkspaceResourceKind, itemId: string): string {
  return `${kind}:${itemId}`
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
