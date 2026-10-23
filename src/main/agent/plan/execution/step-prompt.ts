import {
  PLAN_STEP_PROMPT_MAX_BYTES,
  type PlanRunState,
  type PlanStep
} from '../../../../shared/planRunTypes'
import { AGENT_REPORT_PROTOCOL } from '../../agents/report'
import { truncateUtf8 } from '../model/utf8-truncate'

const UPSTREAM_REPORT_MAX_BYTES = 4 * 1024
const TRUNCATION_MARKER = '\n[truncated to 4 KiB]'
const BUDGET_TRUNCATION_MARKER = '\n[truncated to prompt budget]'
const OMITTED_REPORT = '[report omitted: prompt budget exhausted]'
const MIN_REPORT_SHARE_BYTES = 512
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

function promptParts(state: PlanRunState, step: PlanStep, upstream: string): string[] {
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
    upstream,
    '## Required final report protocol',
    AGENT_REPORT_PROTOCOL
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
