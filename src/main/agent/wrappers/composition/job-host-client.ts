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
  request: (method: string, params: unknown) => Promise<unknown>,
  options: { originSessionId?: string } = {}
): WrapperJobClient {
  return {
    start: (input) =>
      request(WRAPPER_JOB_HOST_METHODS.start, {
        ...input,
        ...(options.originSessionId ? { originSessionId: options.originSessionId } : {})
      }) as Promise<StartJobResult>,
    status: (runId) =>
      request(WRAPPER_JOB_HOST_METHODS.status, { runId }) as Promise<WrapperJobStatus | undefined>,
    list: (limit) =>
      request(WRAPPER_JOB_HOST_METHODS.list, { limit }) as Promise<WrapperJobSummary[]>,
    cancel: (runId) =>
      request(WRAPPER_JOB_HOST_METHODS.cancel, { runId }) as Promise<CancelJobResult>,
    wait: (runId, timeoutMs) =>
      request(WRAPPER_JOB_HOST_METHODS.wait, { runId, timeoutMs }) as Promise<
        WrapperJobStatus | undefined
      >
  }
}
