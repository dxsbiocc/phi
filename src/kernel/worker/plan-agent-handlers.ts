import type { JsonValue } from '../../shared/kernel-protocol'
import type { KernelAgentRunCoordinator } from '../agent-runs/coordinator'
import type { KernelPlanCoordinator } from '../plans/coordinator'
import { makeProtocolError } from '../protocol/errors'
import type { KernelMethodHandlers } from '../protocol'

type WorkerCall = (method: string, params: unknown) => Promise<unknown>

type Options = {
  callWorker: WorkerCall
  plans: KernelPlanCoordinator
  agentRuns: KernelAgentRunCoordinator
  requireLoadedSession(sessionId: string): unknown
}

function sessionId(value: string | undefined): string {
  if (!value) throw makeProtocolError('INVALID_PARAMS', 'The request requires a sessionId.')
  return value
}

function json(value: unknown): JsonValue {
  return value as JsonValue
}

/** Additive K3-1 handlers kept out of the already-large worker composition root. */
export function createPlanAgentHandlers(options: Options): KernelMethodHandlers {
  const loaded = (value: string | undefined): string => {
    const id = sessionId(value)
    options.requireLoadedSession(id)
    return id
  }
  return {
    async 'session.plan.enter'(params, _context, request) {
      const id = loaded(request.sessionId)
      const input = params as { execute?: boolean }
      return json(
        await options.callWorker('session.plan.enter', {
          sessionId: id,
          ...(input.execute === true ? { execute: true } : {})
        })
      )
    },
    async 'session.plan.cancel'(params, _context, request) {
      const id = loaded(request.sessionId)
      const input = params as { replanRequestId?: string }
      const cancelled = await options.callWorker('session.plan.cancel', {
        sessionId: id,
        ...(input.replanRequestId ? { replanRequestId: input.replanRequestId } : {})
      })
      return { cancelled: cancelled === true }
    },
    async 'planRuns.list'(_params, _context, request) {
      return json(await options.plans.list(loaded(request.sessionId)))
    },
    async 'planRuns.get'(params, _context, request) {
      return json(
        await options.plans.get(loaded(request.sessionId), (params as { runId: string }).runId)
      )
    },
    async 'planRuns.retryStep'(params, _context, request) {
      const input = params as { runId: string; stepId: string }
      return json(
        await options.plans.retryStep(loaded(request.sessionId), input.runId, input.stepId)
      )
    },
    async 'planRuns.skipStep'(params, _context, request) {
      const input = params as { runId: string; stepId: string }
      return json(
        await options.plans.skipStep(loaded(request.sessionId), input.runId, input.stepId)
      )
    },
    async 'planRuns.replan'(params, _context, request) {
      return json(
        await options.plans.replan(loaded(request.sessionId), (params as { runId: string }).runId)
      )
    },
    async 'planRuns.stop'(params, _context, request) {
      return json(
        await options.plans.stop(loaded(request.sessionId), (params as { runId: string }).runId)
      )
    },
    async 'agentRuns.start'(params, _context, request) {
      return options.agentRuns.start(
        loaded(request.sessionId),
        params as { requestId: string; agent?: string; task: string }
      )
    },
    async 'agentRuns.list'(_params, _context, request) {
      return options.agentRuns.list(loaded(request.sessionId))
    },
    async 'agentRuns.wait'(params, _context, request) {
      const input = params as { runId: string; timeoutMs?: number }
      return options.agentRuns.wait(loaded(request.sessionId), input.runId, input.timeoutMs)
    },
    async 'agentRuns.steer'(params, _context, request) {
      const input = params as { runId: string; message: string }
      return options.agentRuns.steer(loaded(request.sessionId), input.runId, input.message)
    },
    async 'agentRuns.stop'(params, _context, request) {
      return options.agentRuns.stop(loaded(request.sessionId), (params as { runId: string }).runId)
    }
  }
}
