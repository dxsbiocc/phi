import type { PlanRunState, PlanStep } from '../../../../shared/planRunTypes'
import { AGENT_REPORT_PROTOCOL } from '../../agents/report'
import { truncateUtf8 } from '../model/utf8-truncate'

const UPSTREAM_REPORT_MAX_BYTES = 4 * 1024
const TRUNCATION_MARKER = '\n[truncated to 4 KiB]'
const encoder = new TextEncoder()

function truncateReport(text: string): string {
  const bytes = encoder.encode(text)
  if (bytes.byteLength <= UPSTREAM_REPORT_MAX_BYTES) return text
  const markerBytes = encoder.encode(TRUNCATION_MARKER).byteLength
  const prefix = truncateUtf8(text, UPSTREAM_REPORT_MAX_BYTES - markerBytes)
  return prefix + TRUNCATION_MARKER
}

function planOverview(state: PlanRunState): string {
  return state.spec.steps
    .map((step) => `- [${state.steps[step.id]?.status ?? 'unknown'}] ${step.id}: ${step.title}`)
    .join('\n')
}

function upstreamReport(state: PlanRunState, step: PlanStep): string {
  const report = state.steps[step.id]?.report
  const heading = `### ${step.id}: ${step.title}`
  if (!report) return `${heading}\nNo report was recorded for this upstream step.`
  const missing = report.missingInputs.length ? report.missingInputs.join(', ') : 'none'
  return [
    heading,
    `Status: ${report.status}`,
    `Missing inputs: ${missing}`,
    'Report summary:',
    truncateReport(report.text)
  ].join('\n')
}

function upstreamReports(state: PlanRunState, step: PlanStep): string {
  if (!step.dependsOn.length) return 'None.'
  const byId = new Map(state.spec.steps.map((candidate) => [candidate.id, candidate]))
  return step.dependsOn
    .map((id) => byId.get(id))
    .filter((candidate): candidate is PlanStep => candidate !== undefined)
    .map((candidate) => upstreamReport(state, candidate))
    .join('\n\n')
}

export function buildStepPrompt(state: PlanRunState, stepId: string): string {
  const step = state.spec.steps.find((candidate) => candidate.id === stepId)
  if (!step) throw new Error(`Unknown plan step: ${stepId}`)
  return [
    '## Overall goal',
    state.spec.goal,
    '## Plan overview',
    planOverview(state),
    `## Current step: ${step.id}: ${step.title}`,
    'Instructions:',
    step.instructions,
    'Acceptance criteria:',
    step.acceptance,
    '## Upstream reports',
    upstreamReports(state, step),
    '## Required final report protocol',
    AGENT_REPORT_PROTOCOL
  ].join('\n\n')
}
