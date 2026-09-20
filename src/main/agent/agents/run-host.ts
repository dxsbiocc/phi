import type { PersistedToolOutput } from '../session/session-store'
import {
  agentRunNotice,
  isAgentRunEndState,
  type AgentRunFinishedEvent
} from '../../../shared/agentRunNotice'

/**
 * The main-process side of a background agent run ending. The runs live in the
 * agent worker (one registry per conversation); when one ends it tells the main
 * process here, because only the main process knows the conversation on screen,
 * can persist to its timeline, notify the user and wake the main agent. Every
 * effect on the app is injected, and the worker is trusted no further than its JSON.
 */

export const AGENT_RUN_HOST_METHODS = {
  finished: 'agentRun.finished',
  reported: 'agentRun.reported',
  step: 'agentRun.step'
} as const

/** An event written to a conversation's timeline. */
export type AgentRunHostEvent = { type: string; [key: string]: unknown }

const MAX_REPORT_LENGTH = 20000
const MAX_TASK_LENGTH = 500

export interface AgentRunHostDeps {
  /** Maps the runtime session that started the run to its Phi conversation, if it is still known. */
  resolveSession: (
    originSessionId: string | undefined
  ) => { phiSessionId: string; cwd: string } | undefined
  /** Persists an event in that conversation's timeline and returns the stored form. */
  appendToSession: (phiSessionId: string, event: AgentRunHostEvent) => Record<string, unknown>
  sendToWindow: (payload: Record<string, unknown>) => void
  isAppFocused: () => boolean
  showOsNotification: (notification: { title: string; body: string }) => void
  /** Decides whether to wake the main agent (see `run-continue.ts`); a throw here is contained. */
  continueConversation?: (phiSessionId: string, event: AgentRunFinishedEvent) => void
  /** Strips secrets from text that came out of an agent session. */
  redact: (text: string) => string
  /** Keeps a long step output in a file and returns what goes into the timeline (a preview). */
  persistStepOutput: (
    phiSessionId: string,
    toolCallId: string,
    stepId: string,
    output: string
  ) => PersistedToolOutput | null
  /** Strips secrets from structured data (a step's arguments). */
  redactValue: (value: unknown) => unknown
  /** The main agent was handed this run's outcome, so it needs no wake-up for it. */
  markReported: (phiSessionId: string, agentRunId: string) => void
  /** A new run with this id has just ended; any earlier receipt for that id is stale. */
  clearReported: (phiSessionId: string, agentRunId: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(
  record: Record<string, unknown> | undefined,
  key: string,
  label = key
): string {
  const value = record?.[key]
  if (typeof value !== 'string' || !value) throw new Error(`Missing required parameter: ${label}`)
  return value
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value ? value : undefined
}

function seconds(record: Record<string, unknown>): number {
  const { startedAt, completedAt } = record
  if (typeof startedAt !== 'number' || typeof completedAt !== 'number') return 0
  return Math.max(0, Math.round((completedAt - startedAt) / 1000))
}

function capReport(report: string): string {
  return report.length > MAX_REPORT_LENGTH
    ? `${report.slice(0, MAX_REPORT_LENGTH)}\n… (report truncated)`
    : report
}

function parseFinished(
  params: unknown,
  redact: (text: string) => string
): { originSessionId: string; event: AgentRunFinishedEvent; toolCallId?: string } {
  const root = isRecord(params) ? params : undefined
  const originSessionId = requireString(root, 'originSessionId')
  const run = root?.run
  if (!isRecord(run)) throw new Error('Missing required parameter: run')
  const agentRunId = requireString(run, 'id', 'run.id')
  const agent = requireString(run, 'agent', 'run.agent')
  const state = run.state
  if (!isAgentRunEndState(state)) throw new Error(`Invalid run.state: ${String(state)}`)

  const report = optionalString(run, 'report')
  const error = optionalString(run, 'error')
  const toolCallId = optionalString(run, 'toolCallId')
  return {
    originSessionId,
    ...(toolCallId ? { toolCallId } : {}),
    event: {
      type: 'agent_run_finished',
      agentRunId,
      agent,
      state,
      task: redact((optionalString(run, 'task') ?? '').slice(0, MAX_TASK_LENGTH)),
      elapsedSeconds: seconds(run),
      ...(typeof run.toolCalls === 'number' ? { toolCalls: run.toolCalls } : {}),
      ...(report ? { report: redact(capReport(report)) } : {}),
      ...(error ? { error: redact(error) } : {})
    }
  }
}

function sessionEvent(
  deps: AgentRunHostDeps,
  phiSessionId: string,
  cwd: string,
  event: AgentRunHostEvent
): void {
  const stored = deps.appendToSession(phiSessionId, event)
  deps.sendToWindow({ source: 'phi', ...stored, phiSessionId, cwd })
}

function stepEvent(
  deps: AgentRunHostDeps,
  phiSessionId: string,
  input: {
    originSessionId: string
    toolCallId: string
    agent: string
    agentRunId: string
    step: Record<string, unknown>
    stepId: string
  }
): AgentRunHostEvent {
  const { step, stepId } = input
  const output = typeof step.output === 'string' ? step.output : ''
  const persisted = output
    ? deps.persistStepOutput(phiSessionId, input.toolCallId, stepId, output)
    : null
  const status =
    step.status === 'done' || step.status === 'error' || step.status === 'running'
      ? step.status
      : 'running'
  const error =
    typeof step.error === 'string' && step.error
      ? deps.redact(step.error)
      : status === 'error' && output
        ? deps.redact(output)
        : undefined
  return {
    type: 'agent_execution_step',
    toolCallId: input.toolCallId,
    agentName: input.agent,
    agentRunId: input.agentRunId,
    agentSessionId: input.originSessionId,
    step: {
      id: stepId,
      toolName: typeof step.toolName === 'string' && step.toolName ? step.toolName : 'tool',
      status,
      ...(step.args !== undefined ? { args: deps.redactValue(step.args) } : {}),
      ...(persisted ? { output: persisted.outputPreview } : {}),
      ...(persisted?.outputPath ? { outputPath: persisted.outputPath } : {}),
      ...(persisted ? { outputBytes: persisted.outputBytes } : {}),
      ...(persisted?.truncated ? { outputTruncated: true } : {}),
      ...(persisted?.outputArtifact ? { outputArtifact: persisted.outputArtifact } : {}),
      ...(error ? { error } : {}),
      ...(typeof step.createdAt === 'string' ? { createdAt: step.createdAt } : {}),
      ...(typeof step.completedAt === 'string' ? { completedAt: step.completedAt } : {})
    }
  }
}

export function agentRunHostHandlers(
  deps: AgentRunHostDeps
): Record<string, (params: unknown) => Promise<unknown>> {
  return {
    [AGENT_RUN_HOST_METHODS.finished]: async (params) => {
      const { originSessionId, event, toolCallId } = parseFinished(params, deps.redact)
      const origin = deps.resolveSession(originSessionId)

      if (origin) {
        deps.clearReported(origin.phiSessionId, event.agentRunId)
        // The card that showed this run in the chat ends with it.
        try {
          if (toolCallId) {
            sessionEvent(deps, origin.phiSessionId, origin.cwd, {
              type: 'agent_execution_completed',
              toolCallId,
              agentName: event.agent,
              agentRunId: event.agentRunId,
              agentSessionId: originSessionId,
              // A run somebody stopped did not fail: the card says "cancelled", not an error.
              isError: event.state === 'error',
              ...(event.state === 'cancelled' ? { cancelled: true } : {}),
              ...(event.report ? { finalReport: event.report } : {}),
              ...(event.toolCalls !== undefined ? { toolCalls: event.toolCalls } : {}),
              ...(event.state === 'error' && event.error ? { error: event.error } : {})
            })
          }
        } catch {
          // The notice below still tells the user.
        }
        try {
          sessionEvent(deps, origin.phiSessionId, origin.cwd, { ...event })
        } catch {
          // The OS notification below still tells the user.
        }
        try {
          deps.continueConversation?.(origin.phiSessionId, event)
        } catch {
          // Waking the agent is an extra; never let it get in the way of telling the user.
        }
      }

      // Someone who just stopped a run knows it ended; only unexpected endings pop up.
      if (event.state !== 'cancelled' && !deps.isAppFocused()) {
        try {
          deps.showOsNotification(agentRunNotice(event))
        } catch {
          // Notifications are best-effort (unsupported platform, permission denied).
        }
      }
      return { ok: true }
    },

    [AGENT_RUN_HOST_METHODS.step]: async (params) => {
      const root = isRecord(params) ? params : undefined
      const originSessionId = requireString(root, 'originSessionId')
      const run = root?.run
      if (!isRecord(run)) throw new Error('Missing required parameter: run')
      const agentRunId = requireString(run, 'id', 'run.id')
      const agent = requireString(run, 'agent', 'run.agent')
      const step = root?.step
      if (!isRecord(step)) throw new Error('Missing required parameter: step')
      const stepId = requireString(step, 'id', 'step.id')

      const toolCallId = optionalString(run, 'toolCallId')
      const origin = deps.resolveSession(originSessionId)
      // Without a card to show it on, the step has nowhere to go.
      if (!origin || !toolCallId) return { ok: true }
      try {
        sessionEvent(
          deps,
          origin.phiSessionId,
          origin.cwd,
          stepEvent(deps, origin.phiSessionId, {
            originSessionId,
            toolCallId,
            agent,
            agentRunId,
            step,
            stepId
          })
        )
      } catch {
        // Progress is best-effort; the run itself is unaffected.
      }
      return { ok: true }
    },

    [AGENT_RUN_HOST_METHODS.reported]: async (params) => {
      const root = isRecord(params) ? params : undefined
      const originSessionId = requireString(root, 'originSessionId')
      const runId = requireString(root, 'runId')
      const origin = deps.resolveSession(originSessionId)
      if (origin) deps.markReported(origin.phiSessionId, runId)
      return { ok: true }
    }
  }
}
