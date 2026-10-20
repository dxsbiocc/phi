import { redactSensitiveText } from '../redaction'
import type { PersistedToolOutput, SessionEventInput } from './session-store'
import type {
  SessionEventPersistenceDeps,
  SessionEventPersistenceRun
} from './session-event-persistence'
import {
  agentNameFromDetails,
  agentRunRefFrom,
  agentStepRecordFrom,
  agentToolStepId,
  isAgentToolName
} from './session-event-payload-projection'

function persistAgentStepOutput(
  run: SessionEventPersistenceRun,
  parentToolCallId: string,
  stepId: string,
  output: string,
  deps: SessionEventPersistenceDeps
): PersistedToolOutput | null {
  if (!output) return null
  return deps.storage.persistToolOutput(run.phiSessionId, {
    runId: run.runId,
    toolCallId: `${parentToolCallId}-${stepId}`,
    output,
    inlineLimit: deps.storage.toolOutputInlineLimit
  })
}

function agentStepStatus(step: Record<string, unknown>): 'done' | 'error' | 'running' {
  return step.status === 'done' || step.status === 'error' || step.status === 'running'
    ? step.status
    : 'running'
}

function agentStepError(
  step: Record<string, unknown>,
  status: 'done' | 'error' | 'running',
  output: string
): string | undefined {
  return typeof step.error === 'string' && step.error
    ? redactSensitiveText(step.error)
    : status === 'error' && output
      ? redactSensitiveText(output)
      : undefined
}

function persistedAgentStepFields(persisted: PersistedToolOutput | null): Record<string, unknown> {
  return {
    ...(persisted ? { output: persisted.outputPreview } : {}),
    ...(persisted?.outputPath ? { outputPath: persisted.outputPath } : {}),
    ...(persisted ? { outputBytes: persisted.outputBytes } : {}),
    ...(persisted?.truncated ? { outputTruncated: true } : {}),
    ...(persisted?.outputArtifact ? { outputArtifact: persisted.outputArtifact } : {})
  }
}

function agentStepTimingFields(step: Record<string, unknown>): Record<string, unknown> {
  const completedAt = typeof step.completedAt === 'string' ? step.completedAt : undefined
  const createdAt = typeof step.createdAt === 'string' ? step.createdAt : undefined
  return {
    ...(createdAt ? { createdAt } : {}),
    ...(completedAt ? { completedAt } : {})
  }
}

export function agentStepEventFromSummary(
  run: SessionEventPersistenceRun,
  summary: Record<string, unknown>,
  deps: SessionEventPersistenceDeps
): SessionEventInput | null {
  if (typeof summary.toolCallId !== 'string') return null
  const parentToolCallId = summary.toolCallId
  const step = agentStepRecordFrom(summary.partialResult)
  if (!step) return null
  const stepId = agentToolStepId(step, parentToolCallId)
  const output = typeof step.output === 'string' ? step.output : ''
  const persisted = persistAgentStepOutput(run, parentToolCallId, stepId, output, deps)
  const status = agentStepStatus(step)
  const error = agentStepError(step, status, output)

  return {
    type: 'agent_execution_step',
    runId: run.runId,
    toolCallId: parentToolCallId,
    agentName:
      agentNameFromDetails(summary.partialResult) ??
      (isAgentToolName(summary.toolName) ? summary.toolName : undefined),
    ...agentRunRefFrom(run, summary.partialResult),
    step: {
      id: stepId,
      toolName: typeof step.toolName === 'string' && step.toolName ? step.toolName : 'tool',
      status,
      ...(step.args !== undefined ? { args: deps.shared.redactStructuredValue(step.args) } : {}),
      ...persistedAgentStepFields(persisted),
      ...(error ? { error } : {}),
      ...agentStepTimingFields(step)
    },
    ...deps.shared.createdAtFromSummary(summary)
  }
}
