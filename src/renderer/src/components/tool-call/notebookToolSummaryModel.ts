import type { NotebookCellJumpTarget, NotebookToolSummary, ToolCallItem } from '../../types'

export function notebookTargetLabel(notebook: NotebookToolSummary): string {
  return notebook.relativePath ?? notebook.path ?? 'notebook'
}

export function notebookCellLabel(notebook: NotebookToolSummary): string {
  if (typeof notebook.cellNumber === 'number' && Number.isFinite(notebook.cellNumber)) {
    return `Cell ${Math.trunc(notebook.cellNumber)}`
  }
  return notebook.cellId ?? ''
}

export function notebookVerb(kind: string, status: ToolCallItem['status']): string {
  const done = status !== 'running'
  switch (kind) {
    case 'notebook_list':
      return done ? '已列出 Notebook' : '列出 Notebook'
    case 'notebook_document':
      return done ? '已读取 Notebook' : '读取 Notebook'
    case 'notebook_cell_inserted':
      return done ? '已插入 Cell' : '插入 Cell'
    case 'notebook_cell_updated':
      return done ? '已更新 Cell' : '更新 Cell'
    case 'notebook_cell_deleted':
      return done ? '已删除 Cell' : '删除 Cell'
    case 'notebook_cell_executed':
      return done ? '已运行 Cell' : '运行 Cell'
    case 'notebook_saved':
      return done ? '已保存 Notebook' : '保存 Notebook'
    default:
      return done ? '已操作 Notebook' : '操作 Notebook'
  }
}

export function notebookHeadline(item: ToolCallItem): string | undefined {
  if (!item.notebook) return undefined
  const target = notebookTargetLabel(item.notebook)
  const cellLabel = notebookCellLabel(item.notebook)
  const cell = cellLabel ? ` · ${cellLabel}` : ''
  return `${notebookVerb(item.notebook.kind, item.status)} · ${target}${cell}`
}

export function notebookJumpTarget(notebook?: NotebookToolSummary): NotebookCellJumpTarget | null {
  if (!notebook?.cellId) return null
  if (!notebook.path && !notebook.relativePath) return null
  return {
    path: notebook.path,
    relativePath: notebook.relativePath,
    cellId: notebook.cellId
  }
}
