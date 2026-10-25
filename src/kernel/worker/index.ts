import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import {
  KERNEL_EVENT_APPROVAL_REQUESTED,
  KERNEL_EVENT_SESSION_EVENT,
  KERNEL_EVENT_SESSION_STATE,
  type ApprovalRespondParams,
  type JsonValue,
  type SessionCreateParams,
  type SessionPromptParams
} from '../../shared/kernel-protocol'
import { setWorkerOutbound, type WorkerOutbound } from '../../main/agent/engine/in-process/ipc'
import { makeProtocolError } from '../protocol/errors'
import type {
  KernelMethodHandlers,
  KernelProtocolCore,
  RunCompletionStatus,
  SessionPromptRun
} from '../protocol'

type WorkerCall = (method: string, params: unknown) => Promise<unknown>

export type WorkerKernelAdapterOptions = {
  agentDir: string
  callWorker?: WorkerCall
  readSessionState?: (sessionId: string) => unknown | Promise<unknown>
  diagnostic?: (message: string) => void
}

export type WorkerKernelAdapter = {
  handlers: KernelMethodHandlers
  bind(core: KernelProtocolCore): () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredSessionId(sessionId: string | undefined): string {
  if (!sessionId) {
    throw makeProtocolError('INVALID_PARAMS', 'The request requires a sessionId.')
  }
  return sessionId
}

async function defaultWorkerCall(method: string, params: unknown): Promise<unknown> {
  const runtime = async (): Promise<
    typeof import('../../main/agent/engine/in-process/session-runtime')
  > => import('../../main/agent/engine/in-process/session-runtime')
  switch (method) {
    case 'session.create': {
      const { createSession } = await import('../../main/agent/engine/in-process/session-creation')
      return createSession(params)
    }
    case 'session.prompt':
      return (await runtime()).promptSession(params)
    case 'session.abort':
      return (await runtime()).abortSession(params)
    case 'session.dispose':
      return (await runtime()).disposeSession(params)
    case 'toolApproval.result': {
      const [{ pendingToolApprovals }, { isRecord, stringValue }] = await Promise.all([
        import('../../main/agent/engine/in-process/state'),
        import('../../main/agent/engine/in-process/common')
      ])
      const record = isRecord(params) ? params : {}
      const requestId = stringValue(record.requestId)
      const resolve = pendingToolApprovals.get(requestId)
      if (!resolve) return false
      pendingToolApprovals.delete(requestId)
      resolve(record.result ?? null)
      return true
    }
    default:
      throw new Error(`Unsupported kernel worker method: ${method}`)
  }
}

async function defaultReadSessionState(sessionId: string): Promise<unknown> {
  const [{ getSession }, { serializeSessionState }, { toJsonSafe }] = await Promise.all([
    import('../../main/agent/engine/in-process/session-runtime'),
    import('../../main/agent/engine/in-process/tool-support'),
    import('../../main/agent/engine/in-process/common')
  ])
  // Snapshots bypass the ipc.ts wrappers, so they need their own JSON-safe pass.
  return toJsonSafe(serializeSessionState(getSession(sessionId)))
}

async function assertExistingAbsoluteDirectory(cwd: string): Promise<void> {
  if (!isAbsolute(cwd)) {
    throw makeProtocolError('INVALID_PARAMS', 'Session cwd must be an existing absolute directory.')
  }
  try {
    if ((await stat(cwd)).isDirectory()) return
  } catch {
    // The protocol exposes one stable validation result for missing and non-directory paths.
  }
  throw makeProtocolError('INVALID_PARAMS', 'Session cwd must be an existing absolute directory.')
}

const thinkingLevels = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function projectSessionState(sessionId: string, value: unknown, activeRunId?: string): JsonValue {
  const state = isRecord(value) ? value : {}
  const model = isRecord(state.model) ? state.model : undefined
  const messages = Array.isArray(state.messages) ? (state.messages as JsonValue[]) : []
  const cwd = typeof state.cwd === 'string' && state.cwd ? state.cwd : undefined
  if (!cwd) throw new TypeError('Worker session state omitted cwd')
  return {
    sessionId,
    messages,
    ...(model && typeof model.provider === 'string' && typeof model.id === 'string'
      ? { model: { provider: model.provider, id: model.id } }
      : {}),
    ...(typeof state.thinkingLevel === 'string' && thinkingLevels.has(state.thinkingLevel)
      ? { thinkingLevel: state.thinkingLevel }
      : {}),
    cwd,
    ...(activeRunId ? { activeRunId } : {})
  }
}

function sanitizeRunError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s:]+[\\/])*[^\s:]*/g, '<path>').slice(0, 1024)
}

export function createWorkerKernelAdapter(
  options: WorkerKernelAdapterOptions
): WorkerKernelAdapter {
  if (!options.agentDir) throw new Error('PI_CODING_AGENT_DIR is required by the kernel entry')

  const callWorker = options.callWorker ?? defaultWorkerCall
  const readSessionState = options.readSessionState ?? defaultReadSessionState
  const diagnostic =
    options.diagnostic ??
    ((message: string) => process.stderr.write(`[kernel-worker] ${message}\n`))
  const diagnosedEvents = new Set<string>()
  const activeRuns = new Map<string, string>()
  const cancelledRuns = new Set<string>()

  const diagnoseDroppedEvent = (name: string, reason: string): void => {
    if (diagnosedEvents.has(name)) return
    diagnosedEvents.add(name)
    diagnostic(`Dropped legacy worker event ${name}: ${reason}`)
  }

  const rejectAuthPrompt = (requestId: string): void => {
    void import('../../main/agent/engine/in-process/state')
      .then(({ pendingAuthPrompts }) => {
        const pending = pendingAuthPrompts.get(requestId)
        if (!pending) return
        pendingAuthPrompts.delete(requestId)
        pending.reject(new Error('authentication prompt unavailable in kernel v1'))
      })
      .catch((error: unknown) => {
        diagnostic(`Failed to reject kernel authentication prompt: ${String(error)}`)
      })
  }

  const handlers: KernelMethodHandlers = {
    async 'session.create'(params) {
      const create = params as SessionCreateParams
      await assertExistingAbsoluteDirectory(create.cwd)
      const sessionId = randomUUID()
      await callWorker('session.create', {
        ...create,
        sessionId,
        agentDir: options.agentDir,
        sessionManager: { kind: create.sessionManager.kind, cwd: create.cwd }
      })
      return { sessionId }
    },
    'session.prompt'(params, _context, request): SessionPromptRun {
      const sessionId = requiredSessionId(request.sessionId)
      const prompt = params as SessionPromptParams
      const runId = randomUUID()
      activeRuns.set(sessionId, runId)
      const completion = (async (): Promise<
        RunCompletionStatus | { status: RunCompletionStatus; detail?: string }
      > => {
        try {
          await callWorker('session.prompt', {
            sessionId,
            text: prompt.text,
            ...(prompt.images ? { options: { images: prompt.images } } : {})
          })
          return cancelledRuns.has(runId) ? 'cancelled' : 'completed'
        } catch (error) {
          if (cancelledRuns.has(runId)) return 'cancelled'
          return { status: 'failed', detail: sanitizeRunError(error) }
        } finally {
          cancelledRuns.delete(runId)
          if (activeRuns.get(sessionId) === runId) activeRuns.delete(sessionId)
        }
      })()
      return { runId, completion }
    },
    async 'session.abort'(_params, _context, request) {
      const sessionId = requiredSessionId(request.sessionId)
      const activeRunId = activeRuns.get(sessionId)
      if (activeRunId) cancelledRuns.add(activeRunId)
      try {
        await callWorker('session.abort', { sessionId })
      } catch (error) {
        if (activeRunId) cancelledRuns.delete(activeRunId)
        throw error
      }
      return { cancelled: true }
    },
    async 'session.snapshot'(_params, _context, request) {
      const sessionId = requiredSessionId(request.sessionId)
      return projectSessionState(
        sessionId,
        await readSessionState(sessionId),
        activeRuns.get(sessionId)
      )
    },
    async 'session.close'(_params, _context, request) {
      const sessionId = requiredSessionId(request.sessionId)
      await callWorker('session.dispose', { sessionId })
      activeRuns.delete(sessionId)
      return { closed: true }
    },
    'events.subscribe': () => ({ subscribed: true, lastSeq: 0 }),
    async 'approval.respond'(params) {
      const response = params as ApprovalRespondParams
      const result =
        response.decision === 'approved'
          ? null
          : { block: true, reason: 'User denied tool execution' }
      const accepted = await callWorker('toolApproval.result', {
        requestId: response.approvalId,
        result
      })
      if (accepted !== true) {
        throw makeProtocolError('INVALID_PARAMS', 'The approval is unknown or already answered.')
      }
      return { accepted: true }
    },
    onControllerDetached() {
      // A controller detaching is not an approval decision or a cancellation request.
    }
  }

  return {
    handlers,
    bind(core) {
      const outbound: WorkerOutbound = {
        send() {
          throw new Error('Raw legacy worker frames are unavailable on the kernel protocol')
        },
        event(name, payload, extra) {
          const sessionId = typeof extra.sessionId === 'string' ? extra.sessionId : undefined
          const runId = sessionId ? activeRuns.get(sessionId) : undefined
          if (name === 'sessionEvent') {
            core.emitEvent(KERNEL_EVENT_SESSION_EVENT, payload as JsonValue, { sessionId, runId })
            return
          }
          if (name === 'sessionState') {
            if (!sessionId) {
              diagnoseDroppedEvent(name, 'missing sessionId')
              return
            }
            core.emitEvent(
              KERNEL_EVENT_SESSION_STATE,
              projectSessionState(sessionId, payload, runId),
              { sessionId, runId }
            )
            return
          }
          if (name === 'toolApproval') {
            if (!isRecord(payload)) throw new Error('toolApproval event payload is invalid')
            const approvalId =
              typeof payload.requestId === 'string' && payload.requestId
                ? payload.requestId
                : undefined
            if (!approvalId) throw new Error('toolApproval event omitted requestId')
            const toolCallId =
              typeof payload.toolCallId === 'string' && payload.toolCallId
                ? payload.toolCallId
                : approvalId
            core.emitEvent(
              KERNEL_EVENT_APPROVAL_REQUESTED,
              {
                approvalId,
                toolCallId,
                toolName: typeof payload.toolName === 'string' ? payload.toolName : '',
                input: (isRecord(payload.input) ? payload.input : {}) as JsonValue,
                ...(typeof payload.agentRunId === 'string' && payload.agentRunId
                  ? { agentRunId: payload.agentRunId }
                  : {})
              },
              { sessionId, runId }
            )
            return
          }
          if (name === 'authPrompt') {
            const requestId = typeof extra.requestId === 'string' ? extra.requestId : undefined
            if (requestId) rejectAuthPrompt(requestId)
            diagnoseDroppedEvent(name, 'authentication prompt unavailable in kernel v1')
            return
          }
          diagnoseDroppedEvent(name, 'notification is not exposed by kernel v1')
        },
        hostRequest(method, params, context) {
          return core.requestHost(method, params as JsonValue, {
            ...(context?.originSessionId ? { sessionId: context.originSessionId } : {}),
            ...(context?.agentRunId ? { agentRunId: context.agentRunId } : {})
          })
        }
      }
      setWorkerOutbound(outbound)
      return () => setWorkerOutbound(undefined)
    }
  }
}
