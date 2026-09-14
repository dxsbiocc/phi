import { parseFinalGeneratedNotebookCompletion } from '../../../../../shared/notebookCodeGeneration'
import type {
  AnalysisNotebookCodeGenerationResult,
  AnalysisNotebookGeneratedCell
} from '../../../types'

export function notebookAiGeneratedCellsFromResult(
  result: AnalysisNotebookCodeGenerationResult,
  fallbackLanguage: string
): AnalysisNotebookGeneratedCell[] {
  if (result.cells && result.cells.length > 0) {
    const parsedCells = parseFinalGeneratedNotebookCompletion(
      result.cells.map((cell) => cell.source).join('\n\n'),
      result.language || fallbackLanguage
    )
    if (parsedCells.length > 0) return parsedCells
    return result.cells
  }

  const source = result.source.trim()
  if (!source) return []
  return parseFinalGeneratedNotebookCompletion(source, result.language || fallbackLanguage)
}
