import {
  WRAPPER_JOB_HOST_METHODS,
  type CancelJobResult,
  type StartJobResult,
  type WrapperJobClient,
  type WrapperJobStatus,
  type WrapperJobSummary
} from './job-types'

/**
 * The worker's side of the job boundary: every call becomes a host request to
 * the main process, where the single `WrapperJobManager` lives (see
 * `job-host-handlers.ts`).
 */
export function createHostJobClient(
  request: (
    method: string,
    params: unknown,
    context?: { originSessionId?: string; agentRunId?: string }
  ) => Promise<unknown>,
  options: { originSessionId?: string; agentRunId?: string } = {}
): WrapperJobClient {
  const context = {
    ...(options.originSessionId ? { originSessionId: options.originSessionId } : {}),
    ...(options.agentRunId ? { agentRunId: options.agentRunId } : {})
  }
  const call = (method: string, params: unknown): Promise<unknown> =>
    request(method, params, context)
  return {
    start: (input) =>
      call(WRAPPER_JOB_HOST_METHODS.start, {
        ...input,
        ...(options.originSessionId ? { originSessionId: options.originSessionId } : {})
      }) as Promise<StartJobResult>,
    status: (runId) =>
      call(WRAPPER_JOB_HOST_METHODS.status, { runId }) as Promise<WrapperJobStatus | undefined>,
    list: (limit) => call(WRAPPER_JOB_HOST_METHODS.list, { limit }) as Promise<WrapperJobSummary[]>,
    cancel: (runId) => call(WRAPPER_JOB_HOST_METHODS.cancel, { runId }) as Promise<CancelJobResult>,
    wait: (runId, timeoutMs) =>
      call(WRAPPER_JOB_HOST_METHODS.wait, { runId, timeoutMs }) as Promise<
        WrapperJobStatus | undefined
      >
  }
}
