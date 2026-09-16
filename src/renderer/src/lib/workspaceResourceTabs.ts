import type { WorkspaceSidebarMode } from './workspaceSidebar'

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
  key: string
  kind: WorkspaceResourceKind
  itemId: string
  title: string
  subtitle?: string
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
}

export type WorkspaceTab = WorkspaceSessionTab | WorkspaceResourceTab | WorkspaceFileWorkspaceTab

const resourceLabels: Record<WorkspaceResourceKind, string> = {
  runtime: '运行时',
  plugins: '插件',
  skills: '技能',
  mcp: 'MCP',
  wrappers: 'Wrappers'
}

const tabLabels: Record<WorkspaceTabKind, string> = {
  session: '会话',
  ...resourceLabels,
  file: '文件',
  directory: '文件夹',
  notebook: 'Notebook'
}

export function workspaceSessionTabKey(path: string | null, sessionGeneration: number): string {
  return path ? `session:${path}` : `session:fresh:${sessionGeneration}`
}

export function workspaceResourceTabKey(kind: WorkspaceResourceKind, itemId: string): string {
  return `${kind}:${itemId}`
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
