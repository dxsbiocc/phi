import { parseFinalGeneratedNotebookCompletion } from '../../../../../shared/notebookCodeGeneration'
import type {
  AnalysisNotebookCodeGenerationResult,
  AnalysisNotebookGeneratedCell
} from '../../../types'

function generatedCellsFromStructuredResultCells(
  cells: AnalysisNotebookGeneratedCell[],
  fallbackLanguage: string
): AnalysisNotebookGeneratedCell[] {
  return parseFinalGeneratedNotebookCompletion(cells, fallbackLanguage)
}

export function notebookAiGeneratedCellsFromResult(
  result: AnalysisNotebookCodeGenerationResult,
  fallbackLanguage: string
): AnalysisNotebookGeneratedCell[] {
  if (result.cells && result.cells.length > 0) {
    return generatedCellsFromStructuredResultCells(
      result.cells,
      result.language || fallbackLanguage
    )
  }

  const source = result.source.trim()
  if (!source) return []
  return parseFinalGeneratedNotebookCompletion(source, result.language || fallbackLanguage)
}
