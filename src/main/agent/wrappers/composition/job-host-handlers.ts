import { WRAPPER_JOB_HOST_METHODS, type WrapperJobClient } from './job-types'

/**
 * The main-process side of the job boundary: host-request handlers (keyed by
 * method name) that validate what arrived from the worker and delegate to the
 * job manager. The worker is trusted no further than its JSON.
 */

const MAX_WAIT_MS = 10 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(params: unknown, key: string): string {
  const value = isRecord(params) ? params[key] : undefined
  if (typeof value !== 'string' || !value) throw new Error(`Missing required parameter: ${key}`)
  return value
}

export function wrapperJobHostHandlers(
  jobs: WrapperJobClient
): Record<string, (params: unknown) => Promise<unknown>> {
  return {
    [WRAPPER_JOB_HOST_METHODS.start]: (params) => {
      const overrides = isRecord(params) && isRecord(params.overrides) ? params.overrides : {}
      const origin = isRecord(params) ? params.originSessionId : undefined
      return jobs.start({
        id: requireString(params, 'id'),
        overrides,
        profile: requireString(params, 'profile'),
        ...(typeof origin === 'string' && origin ? { originSessionId: origin } : {}),
        ...(isRecord(params) && params.continueWhenDone === false
          ? { continueWhenDone: false }
          : {})
      })
    },
    [WRAPPER_JOB_HOST_METHODS.status]: (params) => jobs.status(requireString(params, 'runId')),
    [WRAPPER_JOB_HOST_METHODS.list]: (params) => {
      const limit = isRecord(params) && typeof params.limit === 'number' ? params.limit : undefined
      return jobs.list(limit)
    },
    [WRAPPER_JOB_HOST_METHODS.cancel]: (params) => jobs.cancel(requireString(params, 'runId')),
    [WRAPPER_JOB_HOST_METHODS.wait]: (params) => {
      const requested =
        isRecord(params) && typeof params.timeoutMs === 'number' ? params.timeoutMs : 0
      return jobs.wait(
        requireString(params, 'runId'),
        Math.min(Math.max(0, requested), MAX_WAIT_MS)
      )
    }
  }
}
