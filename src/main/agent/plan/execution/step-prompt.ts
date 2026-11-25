import {
  PLAN_STEP_PROMPT_MAX_BYTES,
  type PlanRunState,
  type PlanStep
} from '../../../../shared/planRunTypes'
import { AGENT_REPORT_PROTOCOL } from '../../agents/report'
import { scientificStepEvidence } from '../model/scientific-step-evidence'
import { truncateUtf8 } from '../model/utf8-truncate'

const UPSTREAM_REPORT_MAX_BYTES = 4 * 1024
const TRUNCATION_MARKER = '\n[truncated to 4 KiB]'
const BUDGET_TRUNCATION_MARKER = '\n[truncated to prompt budget]'
const OMITTED_REPORT = '[report omitted: prompt budget exhausted]'
const MIN_REPORT_SHARE_BYTES = 512
const STEP_STATUS_RULE =
  'For this plan step, report "completed" only when you verified every acceptance criterion above. If any criterion is unmet or unverified, report "partial" or "failed" and name that criterion in the report.'
const encoder = new TextEncoder()

function byteLength(value: string): number {
  return encoder.encode(value).byteLength
}

function truncateReport(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text)
  if (bytes.byteLength <= maxBytes) return text
  const marker =
    maxBytes === UPSTREAM_REPORT_MAX_BYTES ? TRUNCATION_MARKER : BUDGET_TRUNCATION_MARKER
  const markerBytes = byteLength(marker)
  const prefix = truncateUtf8(text, maxBytes - markerBytes)
  return prefix + marker
}

function planOverview(state: PlanRunState): string {
  return state.spec.steps
    .map((step) => `- [${state.steps[step.id]?.status ?? 'unknown'}] ${step.id}: ${step.title}`)
    .join('\n')
}

function upstreamReport(state: PlanRunState, step: PlanStep, body?: string): string {
  const report = state.steps[step.id]?.report
  const heading = `### ${step.id}: ${step.title}`
  if (!report) return `${heading}\nNo report was recorded for this upstream step.`
  const missing = report.missingInputs.length ? report.missingInputs.join(', ') : 'none'
  return [
    heading,
    `Status: ${report.status}`,
    `Missing inputs: ${missing}`,
    'Report summary:',
    body ?? ''
  ].join('\n')
}

function dependencySteps(state: PlanRunState, step: PlanStep): PlanStep[] {
  const byId = new Map(state.spec.steps.map((candidate) => [candidate.id, candidate]))
  return step.dependsOn
    .map((id) => byId.get(id))
    .filter((candidate): candidate is PlanStep => candidate !== undefined)
}

const PREVIOUS_ATTEMPT_MAX_BYTES = 2 * 1024
const PREVIOUS_ATTEMPT_RULE =
  'Do not redo work that is already done. Check what the previous attempt produced against the acceptance criteria, finish only what is missing, and end with the required report block below. A report without that block is not accepted.'

/** A retried step learns why its last attempt was not accepted instead of starting blind. */
function previousAttempt(state: PlanRunState, step: PlanStep): string[] {
  const current = state.steps[step.id]
  if (!current || current.attempts < 1 || (!current.report && !current.error)) return []
  const evidence = state.spec.researchQuestion
    ? scientificStepEvidence(current, state.spec.researchQuestion, PREVIOUS_ATTEMPT_MAX_BYTES)
    : current
  const lines = ['## Previous attempt', 'This step already ran and its result was not accepted.']
  if (evidence.report) {
    lines.push(`Reported status: ${evidence.report.status}`)
    if (evidence.report.text.trim())
      lines.push(
        'Previous report:',
        truncateReport(evidence.report.text, PREVIOUS_ATTEMPT_MAX_BYTES)
      )
  }
  if (evidence.error)
    lines.push(`Error: ${truncateReport(evidence.error, PREVIOUS_ATTEMPT_MAX_BYTES)}`)
  lines.push(PREVIOUS_ATTEMPT_RULE)
  return [lines.join('\n')]
}

function hypothesisContext(state: PlanRunState, step: PlanStep): string[] {
  if (!state.spec.hypotheses?.length) return []
  const byId = new Map(state.spec.hypotheses.map((item) => [item.id, item]))
  const linked = step.hypothesisIds?.length
    ? step.hypothesisIds
        .map((id) => byId.get(id))
        .filter((item): item is NonNullable<typeof item> => item !== undefined)
    : state.spec.hypotheses.filter((item) => item.selected)
  if (!linked.length) return []
  const lines = linked.map((item) => {
    const details: string[] = []
    if (item.statisticalUnit) details.push(`Statistical unit: ${item.statisticalUnit}`)
    if (item.mechanism) details.push(`Mechanism: ${item.mechanism}`)
    if (item.prediction) details.push(`Prediction: ${item.prediction}`)
    if (item.testCriteria) details.push(`Test criteria: ${item.testCriteria}`)
    if (item.falsificationCriteria) details.push(`Falsification: ${item.falsificationCriteria}`)
    if (item.confounders?.length)
      details.push(`Confounders/controls: ${item.confounders.join(', ')}`)
    return details.length > 0
      ? `- [${item.id}] ${item.statement} (${details.join('; ')})`
      : `- [${item.id}] ${item.statement}`
  })
  return [
    '## Hypotheses under test',
    [
      ...lines,
      'Evaluate these hypotheses with actual tool outputs. Separate observed data from interpretation, account for listed confounders/replication level (avoid pseudoreplication), and report clearly whether verified evidence supports, refutes, or leaves each hypothesis inconclusive.'
    ].join('\n')
  ]
}

function promptParts(state: PlanRunState, step: PlanStep, upstream: string): string[] {
  return [
    '## Overall goal',
    state.spec.goal,
    ...hypothesisContext(state, step),
    '## Plan overview',
    planOverview(state),
    `## Current step: ${step.id}: ${step.title}`,
    'Instructions:',
    step.instructions,
    'Acceptance criteria:',
    step.acceptance,
    '## Upstream reports',
    upstream,
    ...previousAttempt(state, step),
    ...(state.spec.researchQuestion
      ? [
          'This is one independent scientific subquestion. Report the result and limitations to the main agent. Any further analysis that depends on this result waits for parent review.'
        ]
      : []),
    '## Required final report protocol',
    AGENT_REPORT_PROTOCOL,
    STEP_STATUS_RULE
  ]
}

function assemblePrompt(state: PlanRunState, step: PlanStep, upstream: string): string {
  return promptParts(state, step, upstream).join('\n\n')
}

function requirePromptBudget(prompt: string): string {
  if (byteLength(prompt) > PLAN_STEP_PROMPT_MAX_BYTES) {
    throw new Error('Plan step prompt exceeds its byte limit before upstream report bodies.')
  }
  return prompt
}

export function buildStepPrompt(state: PlanRunState, stepId: string): string {
  const step = state.spec.steps.find((candidate) => candidate.id === stepId)
  if (!step) throw new Error(`Unknown plan step: ${stepId}`)
  const dependencies = dependencySteps(state, step)
  if (state.spec.researchQuestion && step.dependsOn.length) {
    throw new Error('Research dependencies require main-agent review before a new stage.')
  }
  if (!dependencies.length) return requirePromptBudget(assemblePrompt(state, step, 'None.'))

  const reports = dependencies.filter((candidate) => state.steps[candidate.id]?.report)
  const minimumUpstream = dependencies
    .map((candidate) =>
      state.steps[candidate.id]?.report
        ? upstreamReport(state, candidate, OMITTED_REPORT)
        : upstreamReport(state, candidate)
    )
    .join('\n\n')
  const fixedPrompt = requirePromptBudget(assemblePrompt(state, step, minimumUpstream))
  const fixedBytes = byteLength(fixedPrompt)
  const averageShare = reports.length
    ? Math.floor((PLAN_STEP_PROMPT_MAX_BYTES - fixedBytes) / reports.length)
    : 0
  const bodyLimit = Math.min(averageShare, UPSTREAM_REPORT_MAX_BYTES)
  const upstream = dependencies
    .map((candidate) => {
      const report = state.steps[candidate.id]?.report
      if (!report) return upstreamReport(state, candidate)
      const body =
        averageShare < MIN_REPORT_SHARE_BYTES
          ? OMITTED_REPORT
          : truncateReport(report.text, bodyLimit)
      return upstreamReport(state, candidate, body)
    })
    .join('\n\n')
  return requirePromptBudget(assemblePrompt(state, step, upstream))
}
