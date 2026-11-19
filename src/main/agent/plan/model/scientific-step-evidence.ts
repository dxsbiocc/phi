import { isRecord } from '../../../../shared/guards'
import type { PlanStepState } from '../../../../shared/planRunTypes'
import { failedResearchReport, readScientificHandoff } from '../../agents/research-handoff'

/** Only canonical fields from this run's approved question may survive recovery. */
export function scientificStepEvidence(
  value: { report?: unknown; error?: unknown },
  question: string,
  promptBudget?: number
): Pick<PlanStepState, 'report' | 'error'> {
  const result: Pick<PlanStepState, 'report' | 'error'> = {}
  if (value.report !== undefined) {
    const entry = isRecord(value.report) ? value.report : {}
    const { status, text, missingInputs } = readScientificHandoff(
      typeof entry.text === 'string' ? entry.text : undefined,
      question,
      entry.status ?? null
    )
    result.report = { status, text: withinBudget(text, promptBudget), missingInputs }
  }
  if (value.error !== undefined) {
    const error = readScientificHandoff(
      typeof value.error === 'string' ? value.error : undefined,
      question,
      'failed'
    )
    const text = error.status === 'failed' ? error.text : failedResearchReport(question, false).text
    result.error = withinBudget(text, promptBudget)
  }
  return result
}

// These callers supply canonical JSON only. With a small prompt budget, omit
// the entire scientific claim and retain a reference so a retry can inspect it.
function withinBudget(text: string, maxBytes?: number): string {
  if (maxBytes === undefined || Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const firstRef = JSON.parse(text).evidence?.[0] as string | undefined
  const note = '[Scientific handoff omitted: prompt budget exhausted.]'
  return firstRef ? `${note} Evidence: ${firstRef}` : note
}
