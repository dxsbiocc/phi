import {
  WRAPPER_CATALOG_HOST_METHODS,
  WRAPPER_JOB_HOST_METHODS,
  type CancelJobResult,
  type StartJobResult,
  type WrapperHostClient,
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
  options: {
    originSessionId?: string
    agentRunId?: string
    observeStatus?: (status: WrapperJobStatus) => void
  } = {}
): WrapperHostClient {
  const context = {
    ...(options.originSessionId ? { originSessionId: options.originSessionId } : {}),
    ...(options.agentRunId ? { agentRunId: options.agentRunId } : {})
  }
  const call = (method: string, params: unknown): Promise<unknown> =>
    request(method, params, context)
  const observedStatus = async (
    runId: string,
    pending: Promise<unknown>
  ): Promise<WrapperJobStatus | undefined> => {
    const status = (await pending) as WrapperJobStatus | undefined
    if (status?.runId === runId) options.observeStatus?.(status)
    return status
  }
  return {
    start: (input) =>
      call(WRAPPER_JOB_HOST_METHODS.start, {
        ...input,
        ...(options.originSessionId ? { originSessionId: options.originSessionId } : {})
      }) as Promise<StartJobResult>,
    status: (runId) => observedStatus(runId, call(WRAPPER_JOB_HOST_METHODS.status, { runId })),
    list: (limit) => call(WRAPPER_JOB_HOST_METHODS.list, { limit }) as Promise<WrapperJobSummary[]>,
    cancel: (runId) => call(WRAPPER_JOB_HOST_METHODS.cancel, { runId }) as Promise<CancelJobResult>,
    wait: (runId, timeoutMs) =>
      observedStatus(runId, call(WRAPPER_JOB_HOST_METHODS.wait, { runId, timeoutMs })),
    search: (query) =>
      call(WRAPPER_CATALOG_HOST_METHODS.search, { query }) as ReturnType<
        WrapperHostClient['search']
      >,
    inspect: (id) =>
      call(WRAPPER_CATALOG_HOST_METHODS.inspect, { id }) as ReturnType<WrapperHostClient['inspect']>
  }
}
