import type { NotebookAiGenerationJob } from '../../../../../shared/notebookAiJobTypes'
import type { AnalysisNotebookGeneratedCell } from '../../../../../shared/notebookCodeGeneration'

/** Older jobs only have a flattened source string; newer jobs retain cell types. */
export function notebookJobPreviewCells(
  job: Pick<NotebookAiGenerationJob, 'previewCells' | 'sourcePreview'>
): AnalysisNotebookGeneratedCell[] {
  if (job.previewCells?.length) return job.previewCells
  const source = job.sourcePreview
  if (!source?.trim()) return []

  const markdown =
    /^\s{0,3}(?:#{2,6}\s|```|~~~)/m.test(source) ||
    /\*\*[^*\n]+\*\*/.test(source) ||
    /`[^`\n]+`[\s\S]*\n\n/.test(source)
  return [{ cellType: markdown ? 'markdown' : 'code', source }]
}
