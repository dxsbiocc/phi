import {
  KERNEL_EVENT_APPROVAL_REQUESTED,
  KERNEL_EVENT_SESSION_EVENT,
  KERNEL_EVENT_SESSION_STATE,
  type JsonValue
} from '../../shared/kernel-protocol'
import { setWorkerOutbound, type WorkerOutbound } from '../../main/agent/engine/in-process/ipc'
import type { KernelProtocolCore } from '../protocol'
import type { PersistentSession } from '../sessions'
import { pauseAfterJournalCommit } from '../test-pause'

type BindWorkerOutboundOptions = {
  agentDir: string
  core: KernelProtocolCore
  activeRunId(sessionId: string): string | undefined
  persistentSession(sessionId: string): PersistentSession | undefined
  projectSessionState(
    sessionId: string,
    value: unknown,
    activeRunId?: string,
    lastRun?: PersistentSession['manifest']['lastRun']
  ): JsonValue
  diagnoseDroppedEvent(name: string, reason: string): void
  rejectAuthPrompt(requestId: string): void
}

function maybePauseAfterWriteResult(
  options: BindWorkerOutboundOptions,
  sessionId: string,
  payload: unknown
): void {
  if (
    !isRecord(payload) ||
    payload.type !== 'message_end' ||
    !isRecord(payload.message) ||
    payload.message.role !== 'toolResult' ||
    payload.message.toolName !== 'write' ||
    typeof payload.message.toolCallId !== 'string'
  ) {
    return
  }
  const persistent = options.persistentSession(sessionId)
  if (!persistent) return
  pauseAfterJournalCommit('c', options.agentDir, persistent.journalPath, payload.message.toolCallId)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hostRequestError(error: unknown): Error {
  if (!isRecord(error) || typeof error.message !== 'string') {
    return error instanceof Error ? error : new Error(String(error))
  }
  return Object.assign(new Error(error.message), {
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    ...(error.detail === undefined ? {} : { detail: error.detail })
  })
}

function emitSessionState(
  options: BindWorkerOutboundOptions,
  sessionId: string | undefined,
  runId: string | undefined,
  payload: unknown
): void {
  if (!sessionId) {
    options.diagnoseDroppedEvent('sessionState', 'missing sessionId')
    return
  }
  options.core.emitEvent(
    KERNEL_EVENT_SESSION_STATE,
    options.projectSessionState(
      sessionId,
      payload,
      runId,
      options.persistentSession(sessionId)?.manifest.lastRun
    ),
    { sessionId, runId }
  )
}

function emitApproval(
  options: BindWorkerOutboundOptions,
  sessionId: string | undefined,
  runId: string | undefined,
  payload: unknown
): void {
  if (!sessionId) throw new Error('toolApproval event omitted sessionId')
  if (!isRecord(payload)) throw new Error('toolApproval event payload is invalid')
  const approvalId =
    typeof payload.requestId === 'string' && payload.requestId ? payload.requestId : undefined
  if (!approvalId) throw new Error('toolApproval event omitted requestId')
  const toolCallId =
    typeof payload.toolCallId === 'string' && payload.toolCallId ? payload.toolCallId : approvalId
  options.core.emitEvent(
    KERNEL_EVENT_APPROVAL_REQUESTED,
    {
      approvalId,
      toolCallId,
      toolName: typeof payload.toolName === 'string' ? payload.toolName : '',
      input: (isRecord(payload.input) ? payload.input : {}) as JsonValue,
      ...(typeof payload.agentRunId === 'string' && payload.agentRunId
        ? { agentRunId: payload.agentRunId }
        : {}),
      ...(typeof payload.outsideProject === 'string' && payload.outsideProject
        ? { outsideProject: payload.outsideProject }
        : {})
    },
    { sessionId, runId }
  )
}

function routeEvent(
  options: BindWorkerOutboundOptions,
  name: string,
  payload: unknown,
  extra: Record<string, unknown>
): void {
  const sessionId = typeof extra.sessionId === 'string' ? extra.sessionId : undefined
  const runId = sessionId ? options.activeRunId(sessionId) : undefined
  switch (name) {
    case 'sessionEvent':
      if (sessionId) maybePauseAfterWriteResult(options, sessionId, payload)
      options.core.emitEvent(KERNEL_EVENT_SESSION_EVENT, payload as JsonValue, { sessionId, runId })
      return
    case 'sessionState':
      emitSessionState(options, sessionId, runId, payload)
      return
    case 'toolApproval':
      emitApproval(options, sessionId, runId, payload)
      return
    case 'authPrompt': {
      const requestId = typeof extra.requestId === 'string' ? extra.requestId : undefined
      if (requestId) options.rejectAuthPrompt(requestId)
      options.diagnoseDroppedEvent(name, 'authentication prompt unavailable in kernel v1')
      return
    }
    default:
      options.diagnoseDroppedEvent(name, 'notification is not exposed by kernel v1')
  }
}

export function bindWorkerOutbound(options: BindWorkerOutboundOptions): () => void {
  const outbound: WorkerOutbound = {
    send() {
      throw new Error('Raw legacy worker frames are unavailable on the kernel protocol')
    },
    event: (name, payload, extra) => routeEvent(options, name, payload, extra),
    hostRequest(method, params, context, onProgress) {
      const record = isRecord(params) ? params : {}
      const sessionId =
        context?.originSessionId ??
        (typeof record.runtimeSessionId === 'string'
          ? record.runtimeSessionId
          : typeof record.originSessionId === 'string'
            ? record.originSessionId
            : typeof record.sessionId === 'string'
              ? record.sessionId
              : undefined)
      // A host-origin plan step (or a background run that outlived its prompt) has no
      // active prompt run, so fall back to the child's own run id as the run binding.
      // Children of a live prompt keep that prompt's binding for approvals and cancellation.
      const runId = (sessionId ? options.activeRunId(sessionId) : undefined) ?? context?.agentRunId
      return options.core
        .requestHost(
          method,
          params as JsonValue,
          {
            ...(sessionId ? { sessionId } : {}),
            ...(runId ? { runId } : {}),
            ...(context?.agentRunId ? { agentRunId: context.agentRunId } : {})
          },
          onProgress as ((progress: JsonValue) => void) | undefined
        )
        .catch((error: unknown) => Promise.reject(hostRequestError(error)))
    }
  }
  setWorkerOutbound(outbound)
  return () => setWorkerOutbound(undefined)
}
