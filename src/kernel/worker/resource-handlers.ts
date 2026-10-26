import type {
  JsonValue,
  ResourcesReloadParams,
  ShellJobsCancelParams
} from '../../shared/kernel-protocol'
import { makeProtocolError } from '../protocol/errors'
import type { KernelMethodHandlers } from '../protocol'

type WorkerCall = (method: string, params: unknown) => Promise<unknown>

export type ResourceHandlerOptions = {
  agentDir: string
  callWorker: WorkerCall
  requireLoadedSession(sessionId: string): unknown
}

function requiredSessionId(sessionId: string | undefined): string {
  if (!sessionId) {
    throw makeProtocolError('INVALID_PARAMS', 'The request requires a sessionId.')
  }
  return sessionId
}

/** K3-2 resource and OMP async shell-job protocol adapters. */
export function createResourceHandlers(options: ResourceHandlerOptions): KernelMethodHandlers {
  return {
    async 'resources.reload'(params, context, request) {
      if (!context.trusted) {
        throw makeProtocolError(
          'CAPABILITY_UNAVAILABLE',
          'Resource reload requires a trusted host connection.',
          { reason: 'trusted_host_required' }
        )
      }
      const sessionId = requiredSessionId(request.sessionId)
      options.requireLoadedSession(sessionId)
      return (await options.callWorker('resources.reload', {
        ...(params as ResourcesReloadParams),
        agentDir: options.agentDir,
        sessionId
      })) as JsonValue
    },
    async 'shellJobs.list'() {
      return (await options.callWorker('shellJobs.list', {})) as JsonValue
    },
    async 'shellJobs.cancel'(params, _context, request) {
      const sessionId = requiredSessionId(request.sessionId)
      options.requireLoadedSession(sessionId)
      return (await options.callWorker('shellJobs.cancel', {
        sessionId,
        jobId: (params as ShellJobsCancelParams).jobId
      })) as JsonValue
    }
  }
}
