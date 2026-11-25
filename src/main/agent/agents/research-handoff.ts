import { isRecord } from '../../../shared/guards'
import {
  HYPOTHESIS_VERDICTS,
  PLAN_MAX_HYPOTHESES,
  PLAN_MAX_REPORT_SUMMARY_BYTES,
  PLAN_MAX_STEP_ID_LENGTH,
  PLAN_STEP_REPORT_STATUSES,
  type HypothesisVerdictRecord,
  type HypothesisVerdictStatus,
  type ScientificKeyMetricRecord
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

const HYPOTHESIS_ID_PATTERN = new RegExp(`^[a-z0-9-]{1,${PLAN_MAX_STEP_ID_LENGTH}}$`)
const ALLOWED_HYPOTHESIS_VERDICTS = new Set<string>(HYPOTHESIS_VERDICTS)
const MAX_KEY_METRICS = 8
const MAX_CONFOUNDERS_CHECKED = 6

export interface StructuredScientificHandoffPayload {
  subquestion: string
  answer: string
  interpretation: string
  rationale: string
  evidence: string[]
  hypothesisVerdicts?: HypothesisVerdictRecord[]
  keyMetrics?: ScientificKeyMetricRecord[]
  confoundersChecked?: string[]
  missingInputs: string[]
}

function isSafeRelativeArtifactPath(value: unknown): value is string {
  if (!isSummary(value, 256)) return false
  const trimmed = value.trim()
  if (trimmed.startsWith('/') || /^[a-z]:/i.test(trimmed)) return false
  return !trimmed.split(/[\\/]+/).includes('..')
}

function isValidVerdictItem(item: unknown, seen: Set<string>): item is HypothesisVerdictRecord {
  return (
    isRecord(item) &&
    typeof item.hypothesisId === 'string' &&
    HYPOTHESIS_ID_PATTERN.test(item.hypothesisId) &&
    typeof item.verdict === 'string' &&
    ALLOWED_HYPOTHESIS_VERDICTS.has(item.verdict) &&
    !seen.has(item.hypothesisId)
  )
}

function parseHypothesisVerdicts(value: unknown): HypothesisVerdictRecord[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > PLAN_MAX_HYPOTHESES) {
    return undefined
  }
  const seen = new Set<string>()
  const records: HypothesisVerdictRecord[] = []
  for (const item of value) {
    if (!isValidVerdictItem(item, seen)) return undefined
    seen.add(item.hypothesisId)
    records.push({
      hypothesisId: item.hypothesisId,
      verdict: item.verdict as HypothesisVerdictStatus
    })
  }
  return records
}

function parseSingleKeyMetric(item: unknown): ScientificKeyMetricRecord | undefined {
  if (
    !isRecord(item) ||
    !isNarrative(item.name, 80) ||
    typeof item.value !== 'number' ||
    !Number.isFinite(item.value) ||
    !isSafeRelativeArtifactPath(item.sourcePath)
  ) {
    return undefined
  }
  if (item.column !== undefined && !isNarrative(item.column, 80)) return undefined
  return {
    name: item.name.trim(),
    value: item.value,
    sourcePath: item.sourcePath.trim(),
    ...(typeof item.column === 'string' ? { column: item.column.trim() } : {})
  }
}

function parseKeyMetrics(value: unknown): ScientificKeyMetricRecord[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_KEY_METRICS) {
    return undefined
  }
  const out: ScientificKeyMetricRecord[] = []
  for (const item of value) {
    const parsed = parseSingleKeyMetric(item)
    if (!parsed) return undefined
    out.push(parsed)
  }
  return out
}

function parseConfoundersChecked(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CONFOUNDERS_CHECKED) {
    return undefined
  }
  if (!value.every((item): item is string => isNarrative(item, 160))) return undefined
  return value.map((item) => item.trim())
}

function hasValidCoreResearchFields(
  research: Record<string, unknown>,
  status: AgentReportStatus,
  missing: unknown
): missing is string[] {
  return (
    isNarrative(research.subquestion, 320) &&
    isNarrative(research.answer, 480) &&
    isNarrative(research.interpretation, 320) &&
    isNarrative(research.rationale, 320) &&
    stringList(research.evidence, isEvidenceRef) &&
    (status !== 'completed' || research.evidence.length > 0) &&
    stringList(missing, (item): item is string => isNarrative(item, 160))
  )
}

function parseOptionalScientificExtensions(research: Record<string, unknown>):
  | {
      ok: true
      fields: {
        hypothesisVerdicts?: HypothesisVerdictRecord[]
        keyMetrics?: ScientificKeyMetricRecord[]
        confoundersChecked?: string[]
      }
    }
  | { ok: false } {
  const hypothesisVerdicts = parseHypothesisVerdicts(research.hypothesisVerdicts)
  if (research.hypothesisVerdicts !== undefined && !hypothesisVerdicts) return { ok: false }
  const keyMetrics = parseKeyMetrics(research.keyMetrics)
  if (research.keyMetrics !== undefined && !keyMetrics) return { ok: false }
  const confoundersChecked = parseConfoundersChecked(research.confoundersChecked)
  if (research.confoundersChecked !== undefined && !confoundersChecked) return { ok: false }
  return {
    ok: true,
    fields: {
      ...(hypothesisVerdicts ? { hypothesisVerdicts } : {}),
      ...(keyMetrics ? { keyMetrics } : {}),
      ...(confoundersChecked ? { confoundersChecked } : {})
    }
  }
}

function serializeBoundedHandoff(
  handoff: Record<string, unknown>,
  userQuestion: ResearchUserQuestion | undefined
): string | undefined {
  let text = JSON.stringify(userQuestion ? { ...handoff, question: userQuestion } : handoff)
  if (userQuestion && Buffer.byteLength(text, 'utf8') > PLAN_MAX_REPORT_SUMMARY_BYTES) {
    text = JSON.stringify(handoff)
  }
  return Buffer.byteLength(text, 'utf8') <= PLAN_MAX_REPORT_SUMMARY_BYTES ? text : undefined
}

export function scientificReport(
  originalQuestion: string,
  status: AgentReportStatus,
  metadata?: Record<string, unknown>
): AgentReport {
  const research = metadata?.research
  const missing = metadata?.missingInputs ?? []
  if (!isRecord(research) || !hasValidCoreResearchFields(research, status, missing)) {
    return unavailableResearchReport(originalQuestion)
  }
  const extensions = parseOptionalScientificExtensions(research)
  if (!extensions.ok) return unavailableResearchReport(originalQuestion)

  const eligibleForQuestion = (status === 'blocked' || status === 'partial') && missing.length > 0
  const userQuestion = eligibleForQuestion ? researchUserQuestion(research.question) : undefined
  const handoff = {
    originalQuestion,
    status,
    subquestion: research.subquestion,
    answer: research.answer,
    interpretation: research.interpretation,
    rationale: research.rationale,
    evidence: research.evidence as string[],
    ...extensions.fields,
    missingInputs: missing
  }
  const text = serializeBoundedHandoff(handoff, userQuestion)
  return text
    ? { status, text, missingInputs: missing, structured: true }
    : unavailableResearchReport(originalQuestion)
}

function parseJsonObjectCandidate(rawText: string): Record<string, unknown> | undefined {
  const blockMatch = /<phi_agent_result>\s*([\s\S]*?)\s*<\/phi_agent_result>/i.exec(rawText)
  const jsonCandidate = blockMatch ? blockMatch[1] : rawText.trim()
  if (!jsonCandidate.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(jsonCandidate)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function projectTextFields(
  research: Record<string, unknown>
): Partial<StructuredScientificHandoffPayload> {
  const out: Partial<StructuredScientificHandoffPayload> = {}
  if (typeof research.subquestion === 'string') out.subquestion = research.subquestion
  if (typeof research.answer === 'string') out.answer = research.answer
  if (typeof research.interpretation === 'string') out.interpretation = research.interpretation
  if (typeof research.rationale === 'string') out.rationale = research.rationale
  if (Array.isArray(research.evidence)) {
    out.evidence = research.evidence.filter((e): e is string => typeof e === 'string')
  }
  return out
}

/**
 * Extracts validated structured scientific fields from a serialized step or specialist report,
 * supporting both stored scientific handoff JSON and `<phi_agent_result>` blocks.
 */
export function extractStructuredScientificPayload(
  rawText: string | undefined
): Partial<StructuredScientificHandoffPayload> | undefined {
  if (typeof rawText !== 'string' || !rawText.trim()) return undefined
  const parsed = parseJsonObjectCandidate(rawText)
  if (!parsed) return undefined
  const research = isRecord(parsed.research) ? parsed.research : parsed
  const extensions = parseOptionalScientificExtensions(research)
  if (!extensions.ok) return undefined
  const baseFields = projectTextFields(research)
  if (!baseFields.subquestion && Object.keys(extensions.fields).length === 0) return undefined
  return { ...baseFields, ...extensions.fields }
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
{"status":"completed|partial|not_found|blocked|failed","missingInputs":[],"research":{"subquestion":"the specific question you investigated","answer":"the direct finding, including a valid zero or missing evidence","interpretation":"what it supports and where the evidence stops","rationale":"why this branch can end or what an additional analysis could resolve","evidence":["exact result file path or source identifier"],"hypothesisVerdicts":[{"hypothesisId":"h1","verdict":"supported|refuted|inconclusive|blocked_by_qc"}],"keyMetrics":[{"name":"significant_genes","value":42,"sourcePath":"results/de.deseq2.qc.tsv","column":"hits"}],"confoundersChecked":["batch","donor"]}}.
Use one short plain-text line per field (subquestion, interpretation and rationale up to 320 characters each; answer up to 480). Cite up to four evidence references (256 characters each); a completed finding requires a reference. Include "hypothesisVerdicts" when testing explicit hypothesis IDs, "keyMetrics" (up to 8 host-verifiable numbers bound to workspace files) when reporting quantitative counts or effect sizes, and "confoundersChecked" when controlling covariates; omit them otherwise. Cite exact existing workspace files (use ./ for an extensionless file), or the actual run receipt for an accepted background job. Pending jobs do not yet support a result claim. List only necessary missing inputs (up to four, 160 characters each). When status is "blocked" or "partial" and missingInputs is non-empty, you may add "question" inside research: {"header":"chip up to 16 characters","question":"the single user decision needed, up to 320 characters","options":[{"label":"choice up to 60 characters","description":"its consequence or trade-off, up to 320 characters"}]}. Offer 2-4 distinct choices in the user's language, one plain-text line per field, and never the reserved labels "Other", "Type something." or "Next" because a custom answer is always available. Request only inputs the user must supply, such as donor identity or experimental design; the parent relays this question with ask_user_question before dependent analysis. Invalid or ineligible questions are ignored. Keep the complete handoff including the original question within 8 KiB. Keep tables, logs and full data in the workspace and give references so the parent can inspect them. Distinguish the result of this subtask from the whole research question. The main agent decides the next action from the original user request, approved scope and these findings.`
