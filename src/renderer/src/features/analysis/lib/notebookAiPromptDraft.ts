import {
  insertNotebookCell,
  updateNotebookCell,
  type NotebookDocument
} from '../../../../../shared/notebookDocument'
import type {
  AnalysisNotebookContextReference,
  AnalysisNotebookGeneratedCell,
  ModelOption
} from '../../../types'
import type { SyntaxLanguage } from '../../../lib/syntaxHighlight'
import { notebookOutputPreview, truncateContextPreview, type CanvasCell } from './notebookViewModel'

export type NotebookAiPromptDraft = {
  id: string
  mode: 'insert' | 'refactor'
  afterCellId: string | null
  targetCellId: string | null
  prompt: string
  language: SyntaxLanguage
  model: ModelOption | null
  references: AnalysisNotebookContextReference[]
  stagedCells: NotebookAiStagedCell[]
  isGenerating: boolean
  error: string | null
  errorDetail: string | null
}

export type NotebookAiStagedCell = AnalysisNotebookGeneratedCell & {
  previewId: string
  afterCellId: string | null
}

const supportedSyntaxLanguages = new Set<SyntaxLanguage>([
  'css',
  'javascript',
  'json',
  'markdown',
  'python',
  'r',
  'shell',
  'toml',
  'typescript',
  'yaml',
  'plain'
])

function generatedCellLanguage(
  cell: AnalysisNotebookGeneratedCell,
  fallbackLanguage: SyntaxLanguage
): SyntaxLanguage | undefined {
  if (cell.cellType !== 'code') return undefined
  const language = (cell.language ?? fallbackLanguage).trim().toLowerCase()
  return supportedSyntaxLanguages.has(language as SyntaxLanguage)
    ? (language as SyntaxLanguage)
    : fallbackLanguage
}

function generatedCellPreviewId(draftId: string, index: number): string {
  return `${draftId}:preview-${index}`
}

function generatedCellToCanvasCell(
  cell: NotebookAiStagedCell,
  fallbackLanguage: SyntaxLanguage
): CanvasCell {
  return {
    id: cell.previewId,
    count: null,
    type: cell.cellType,
    language: generatedCellLanguage(cell, fallbackLanguage),
    state: 'idle',
    source: cell.source,
    outputs: []
  }
}

export function notebookAiPreviewCellIds(draft: NotebookAiPromptDraft): string[] {
  return draft.stagedCells.map((cell) => cell.previewId)
}

export function isNotebookAiPreviewCell(
  cellId: string,
  draft: NotebookAiPromptDraft | null
): boolean {
  return Boolean(draft && notebookAiPreviewCellIds(draft).includes(cellId))
}

export function notebookCellsWithAiPreview(
  cells: CanvasCell[],
  draft: NotebookAiPromptDraft | null,
  fallbackLanguage: SyntaxLanguage
): CanvasCell[] {
  if (!draft || draft.stagedCells.length === 0) return cells

  const baseCells =
    draft.mode === 'refactor' && draft.targetCellId
      ? cells.filter((cell) => cell.id !== draft.targetCellId)
      : cells
  return draft.stagedCells.reduce<CanvasCell[]>((displayCells, cell) => {
    const previewCell = generatedCellToCanvasCell(cell, fallbackLanguage)
    const insertIndex =
      cell.afterCellId === null
        ? 0
        : displayCells.findIndex((displayCell) => displayCell.id === cell.afterCellId) + 1
    if (insertIndex <= 0 && cell.afterCellId !== null) {
      return [...displayCells, previewCell]
    }
    return [...displayCells.slice(0, insertIndex), previewCell, ...displayCells.slice(insertIndex)]
  }, baseCells)
}

export function stageGeneratedNotebookCells(
  document: NotebookDocument,
  draft: NotebookAiPromptDraft,
  generatedCells: AnalysisNotebookGeneratedCell[]
): NotebookAiStagedCell[] {
  const targetIndex = draft.targetCellId
    ? document.cells.findIndex((cell) => cell.id === draft.targetCellId)
    : -1
  const firstAfterCellId =
    draft.mode === 'refactor'
      ? targetIndex > 0
        ? document.cells[targetIndex - 1].id
        : null
      : draft.afterCellId

  return generatedCells.map((cell, index) => ({
    ...cell,
    previewId: generatedCellPreviewId(draft.id, index),
    afterCellId: index === 0 ? firstAfterCellId : generatedCellPreviewId(draft.id, index - 1)
  }))
}

function generatedCellInput(cell: AnalysisNotebookGeneratedCell): {
  cellType: AnalysisNotebookGeneratedCell['cellType']
  source: string
} {
  return {
    cellType: cell.cellType,
    source: cell.source
  }
}

function notebookCellIdsWithAiPreview(
  document: NotebookDocument,
  draft: NotebookAiPromptDraft
): string[] {
  const baseIds =
    draft.mode === 'refactor' && draft.targetCellId
      ? document.cells.map((cell) => cell.id).filter((id) => id !== draft.targetCellId)
      : document.cells.map((cell) => cell.id)

  return draft.stagedCells.reduce<string[]>((displayIds, cell) => {
    const insertIndex =
      cell.afterCellId === null ? 0 : displayIds.findIndex((id) => id === cell.afterCellId) + 1
    if (insertIndex <= 0 && cell.afterCellId !== null) {
      return [...displayIds, cell.previewId]
    }
    return [...displayIds.slice(0, insertIndex), cell.previewId, ...displayIds.slice(insertIndex)]
  }, baseIds)
}

function notebookInsertionIndexForPreview(
  document: NotebookDocument,
  draft: NotebookAiPromptDraft,
  previewId: string
): number {
  const displayIds = notebookCellIdsWithAiPreview(document, draft)
  const previewIndex = displayIds.indexOf(previewId)
  if (previewIndex < 0) return document.cells.length

  const documentCellIds = new Set(document.cells.map((cell) => cell.id))
  return displayIds.slice(0, previewIndex).filter((id) => documentCellIds.has(id)).length
}

function removeStagedNotebookCell(
  draft: NotebookAiPromptDraft,
  previewId: string,
  nextAfterCellId: string | null,
  options: { mode?: NotebookAiPromptDraft['mode']; targetCellId?: string | null } = {}
): NotebookAiPromptDraft | null {
  const stagedCell = draft.stagedCells.find((cell) => cell.previewId === previewId)
  if (!stagedCell) return draft
  const stagedCells = draft.stagedCells
    .filter((cell) => cell.previewId !== previewId)
    .map((cell) =>
      cell.afterCellId === previewId ? { ...cell, afterCellId: nextAfterCellId } : cell
    )

  if (stagedCells.length === 0) return null
  return {
    ...draft,
    mode: options.mode ?? draft.mode,
    targetCellId: 'targetCellId' in options ? (options.targetCellId ?? null) : draft.targetCellId,
    stagedCells
  }
}

export function acceptStagedNotebookCell(
  document: NotebookDocument,
  draft: NotebookAiPromptDraft,
  previewId: string
): { document: NotebookDocument; draft: NotebookAiPromptDraft | null } {
  const stagedCell = draft.stagedCells.find((cell) => cell.previewId === previewId)
  if (!stagedCell) return { document, draft }

  if (draft.mode === 'refactor' && draft.targetCellId) {
    const hasTargetCell = document.cells.some((cell) => cell.id === draft.targetCellId)
    if (hasTargetCell) {
      const nextDocument = updateNotebookCell(document, draft.targetCellId, {
        ...generatedCellInput(stagedCell),
        executionCount: null,
        outputs: []
      })
      return {
        document: nextDocument,
        draft: removeStagedNotebookCell(draft, previewId, draft.targetCellId, {
          mode: 'insert',
          targetCellId: null
        })
      }
    }
  }

  const insertIndex = notebookInsertionIndexForPreview(document, draft, previewId)
  const boundedIndex = Math.max(0, Math.min(insertIndex, document.cells.length))
  const nextDocument = insertNotebookCell(document, boundedIndex, generatedCellInput(stagedCell))
  const insertedCellId = nextDocument.cells[boundedIndex]?.id ?? null
  return {
    document: nextDocument,
    draft: removeStagedNotebookCell(draft, previewId, insertedCellId)
  }
}

export function rejectStagedNotebookCell(
  draft: NotebookAiPromptDraft,
  previewId: string
): NotebookAiPromptDraft | null {
  const stagedCell = draft.stagedCells.find((cell) => cell.previewId === previewId)
  if (!stagedCell) return draft
  return removeStagedNotebookCell(draft, previewId, stagedCell.afterCellId)
}

export function contextReferenceForSelectedCell(
  cell: CanvasCell,
  index: number
): AnalysisNotebookContextReference {
  const output = cell.outputs.length > 0 ? notebookOutputPreview(cell.outputs) : undefined
  return {
    id: `selected_cell:${cell.id}`,
    kind: 'cell_output',
    name: `cell-${index + 1}`,
    detail: 'selected cell',
    cellId: cell.id,
    preview: {
      code: truncateContextPreview(cell.source, 900),
      output
    }
  }
}

export function shouldIgnoreNotebookAiRefactorShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('input, textarea, [contenteditable="true"], [role="textbox"]'))
}
