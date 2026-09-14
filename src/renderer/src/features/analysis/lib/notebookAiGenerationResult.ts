import { parseGeneratedNotebookCells } from '../../../../../shared/notebookCodeGeneration'
import type {
  AnalysisNotebookCodeGenerationResult,
  AnalysisNotebookGeneratedCell
} from '../../../types'

export function notebookAiGeneratedCellsFromResult(
  result: AnalysisNotebookCodeGenerationResult,
  fallbackLanguage: string
): AnalysisNotebookGeneratedCell[] {
  if (result.cells && result.cells.length > 0) {
    return result.cells
  }

  const source = result.source.trim()
  if (!source) return []
  return parseGeneratedNotebookCells(source, result.language || fallbackLanguage)
}
