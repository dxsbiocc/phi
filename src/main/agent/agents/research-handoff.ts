import { isRecord } from '../../../shared/guards'
import {
  PLAN_MAX_REPORT_SUMMARY_BYTES,
  PLAN_STEP_REPORT_STATUSES
} from '../../../shared/planRunTypes'
import type { AgentReport, AgentReportStatus } from './report'

export {
  isResearchQuestion,
  MAX_RESEARCH_QUESTION_LENGTH
} from '../../../shared/kernel-protocol/research-question'

// A bound form is safer than truncating free-form output, which could drop a
// negation, the reference group or a critical limitation midway through a claim.
function isSummary(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= limit &&
    !/[\r\n\t\u2028\u2029]|```|<\/?phi_agent_result>/i.test(value) &&
    !value.trim().startsWith('|')
  )
}

function isNarrative(value: unknown, limit: number): value is string {
  return isSummary(value, limit) && !/\\(?:[nrt]|u(?:000[9ad]|202[89]))/i.test(value)
}

function isEvidenceRef(value: unknown): value is string {
  if (!isSummary(value, 256)) return false
  // Allow paths (including spaces), URLs, DOIs and database/run accessions.
  if (/^wrun_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) return true
  if (value.includes('\\')) return /^(?:[a-z]:\\|\\\\)[^/]*$/i.test(value)
  return /\/|\.[\w-]+$|^(?:PMID: *\d+|PMCID: *PMC\d+|run_[\w-]+|[A-Z]{2,}\d+)$/i.test(value)
}

function stringList(
  value: unknown,
  validate: (item: unknown) => item is string
): value is string[] {
  return Array.isArray(value) && value.length <= 4 && value.every(validate)
}

// Bounds and reserved labels mirror the ask_user_question contract. An
// ineligible or invalid question is omitted, never allowed to fail or leak
// into an otherwise valid handoff.
const RESERVED_QUESTION_LABELS = new Set(['Other', 'Type something.', 'Next'])

export type ResearchUserQuestion = {
  header: string
  question: string
  options: Array<{ label: string; description: string }>
}

export function researchUserQuestion(value: unknown): ResearchUserQuestion | undefined {
  if (!isRecord(value) || !isNarrative(value.header, 16) || !isNarrative(value.question, 320))
    return undefined
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 4)
    return undefined
  const labels = new Set<string>()
  const options: ResearchUserQuestion['options'] = []
  for (const option of value.options) {
    if (
      !isRecord(option) ||
      !isNarrative(option.label, 60) ||
      !isNarrative(option.description, 320) ||
      RESERVED_QUESTION_LABELS.has(option.label) ||
      labels.has(option.label)
    )
      return undefined
    labels.add(option.label)
    options.push({ label: option.label, description: option.description })
  }
  return { header: value.header, question: value.question, options }
}

function unavailableResearchReport(originalQuestion: string): AgentReport {
  return {
    status: 'partial',
    text: JSON.stringify({
      originalQuestion,
      status: 'partial',
      missingInputs: [],
      answer: 'Insufficient evidence: the specialist did not return a valid research handoff.'
    }),
    missingInputs: [],
    structured: false
  }
}

export function failedResearchReport(originalQuestion: string, cancelled: boolean): AgentReport {
  const answer = cancelled
    ? 'The specialist was cancelled before a scientific answer could be returned.'
    : 'The specialist failed before a scientific answer could be returned.'
  return {
    status: 'failed',
    text: JSON.stringify({ originalQuestion, status: 'failed', missingInputs: [], answer }),
    missingInputs: [],
    structured: false
  }
}

export function scientificReport(
  originalQuestion: string,
  status: AgentReportStatus,
  metadata?: Record<string, unknown>
): AgentReport {
  const research = metadata?.research
  const missing = metadata?.missingInputs ?? []
  if (
    !isRecord(research) ||
    !isNarrative(research.subquestion, 320) ||
    !isNarrative(research.answer, 480) ||
    !isNarrative(research.interpretation, 320) ||
    !isNarrative(research.rationale, 320) ||
    !stringList(research.evidence, isEvidenceRef) ||
    (status === 'completed' && research.evidence.length === 0) ||
    !stringList(missing, (item): item is string => isNarrative(item, 160))
  ) {
    return unavailableResearchReport(originalQuestion)
  }

  const userQuestion =
    (status === 'blocked' || status === 'partial') && missing.length > 0
      ? researchUserQuestion(research.question)
      : undefined
  const handoff = {
    originalQuestion,
    status,
    subquestion: research.subquestion,
    answer: research.answer,
    interpretation: research.interpretation,
    rationale: research.rationale,
    evidence: research.evidence,
    missingInputs: missing
  }
  let text = JSON.stringify(userQuestion ? { ...handoff, question: userQuestion } : handoff)
  // Match the plan's stored report allowance, including multibyte responses.
  if (userQuestion && Buffer.byteLength(text, 'utf8') > PLAN_MAX_REPORT_SUMMARY_BYTES)
    text = JSON.stringify(handoff)
  if (Buffer.byteLength(text, 'utf8') > PLAN_MAX_REPORT_SUMMARY_BYTES)
    return unavailableResearchReport(originalQuestion)
  return { status, text, missingInputs: missing, structured: true }
}

/** Revalidate stored evidence at the parent boundary, including restored/replayed runs. */
export function readScientificHandoff(
  text: string | undefined,
  question: string,
  expectedStatus?: unknown
): AgentReport {
  const unavailable = unavailableResearchReport(question)
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > PLAN_MAX_REPORT_SUMMARY_BYTES)
    return unavailable
  let stored: unknown
  try {
    stored = JSON.parse(text)
  } catch {
    return unavailable
  }
  if (!isRecord(stored) || stored.originalQuestion !== question) return unavailable
  const status = stored.status as AgentReportStatus
  if (
    !PLAN_STEP_REPORT_STATUSES.includes(status) ||
    (expectedStatus !== undefined && status !== expectedStatus)
  )
    return unavailable
  // Error and cancellation summaries carry no domain payload. Only replay our
  // own exact terminal forms; a bare "failed" plus arbitrary stderr is untrusted.
  if (status === 'failed' && stored.subquestion === undefined) {
    const cancelled = failedResearchReport(question, true)
    if (cancelled.text === text) return cancelled
    const failed = failedResearchReport(question, false)
    if (failed.text === text) return failed
    return unavailable
  }
  if (!Array.isArray(stored.missingInputs)) return unavailable
  return scientificReport(question, status, {
    research: stored,
    missingInputs: stored.missingInputs
  })
}

export const RESEARCH_HANDOFF_PROTOCOL = `First carry out the delegated task using the authorized tools and inputs. New measurements, fitted results and computational conclusions require actual tool results. For conceptual synthesis you may reason from evidence already supplied. Only after the work or a verified blocker, format the final report by including "research" inside the existing <phi_agent_result> JSON:
{"status":"completed|partial|not_found|blocked|failed","missingInputs":[],"research":{"subquestion":"the specific question you investigated","answer":"the direct finding, including a valid zero or missing evidence","interpretation":"what it supports and where the evidence stops","rationale":"why this branch can end or what an additional analysis could resolve","evidence":["exact result file path or source identifier"]}}.
Use one short plain-text line per field (subquestion, interpretation and rationale up to 320 characters each; answer up to 480). Cite up to four evidence references (256 characters each); a completed finding requires a reference. Cite exact existing workspace files (use ./ for an extensionless file), or the actual run receipt for an accepted background job. Pending jobs do not yet support a result claim. List only necessary missing inputs (up to four, 160 characters each). When status is "blocked" or "partial" and missingInputs is non-empty, you may add "question" inside research: {"header":"chip up to 16 characters","question":"the single user decision needed, up to 320 characters","options":[{"label":"choice up to 60 characters","description":"its consequence or trade-off, up to 320 characters"}]}. Offer 2-4 distinct choices in the user's language, one plain-text line per field, and never the reserved labels "Other", "Type something." or "Next" because a custom answer is always available. Request only inputs the user must supply, such as donor identity or experimental design; the parent relays this question with ask_user_question before dependent analysis. Invalid or ineligible questions are ignored. Keep the complete handoff including the original question within 8 KiB. Keep tables, logs and full data in the workspace and give references so the parent can inspect them. Distinguish the result of this subtask from the whole research question. The main agent decides the next action from the original user request, approved scope and these findings.`
