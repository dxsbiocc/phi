import { chatCopy } from '../../features/chat/lib/chatCopy'
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
      return done ? chatCopy.notebooksListed : chatCopy.listNotebooks
    case 'notebook_document':
      return done ? chatCopy.notebookRead : chatCopy.readNotebook
    case 'notebook_cell_inserted':
      return done ? chatCopy.cellInserted : chatCopy.insertCell
    case 'notebook_cell_updated':
      return done ? chatCopy.cellUpdated : chatCopy.updateCell
    case 'notebook_cell_deleted':
      return done ? chatCopy.cellDeleted : chatCopy.deleteCell
    case 'notebook_cell_executed':
      return done ? chatCopy.cellExecuted : chatCopy.runCell
    case 'notebook_saved':
      return done ? chatCopy.notebookSaved : chatCopy.saveNotebook
    default:
      return done ? chatCopy.notebookOperationCompleted : chatCopy.notebookOperation
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
