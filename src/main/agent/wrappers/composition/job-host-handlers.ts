import type { WrapperRun } from '../types'
import type { PhiHostRequestContext } from '../../engine/types'
import {
  WRAPPER_JOB_HOST_METHODS,
  type WrapperJobClient,
  type WrapperJobControl
} from './job-types'

export interface WrapperJobHostScope extends WrapperJobControl {
  originSessionId: string
  ownsRun(runId: string): boolean
}

/** Uses the existing durable job origin and app-lifetime origin resolver; unknown old origins stay unowned. */
export function createWrapperJobHostScope(options: {
  originSessionId: string
  phiSessionId: string
  projectId: string
  hostProfileId: string
  host: string
  workspaceRoot: string
  signal?: AbortSignal
  assertCurrent(): void
  readRun(runId: string): WrapperRun | null | undefined
  resolveOrigin(originSessionId: string | undefined): { phiSessionId: string } | undefined
}): WrapperJobHostScope {
  return {
    originSessionId: options.originSessionId,
    signal: options.signal,
    assertCurrent: options.assertCurrent,
    ownsRun: (runId) => {
      const run = options.readRun(runId)
      return Boolean(
        run?.origin === 'composition' &&
        run.remote &&
        options.resolveOrigin(run.originSessionId)?.phiSessionId === options.phiSessionId &&
        run.remote.projectId === options.projectId &&
        run.remote.hostProfileId === options.hostProfileId &&
        run.remote.host === options.host &&
        run.remote.workspaceRoot === options.workspaceRoot
      )
    }
  }
}

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
  if (key === 'runId' && (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)))
    throw new Error('Invalid Wrapper run identifier')
  return value
}

export function wrapperJobHostHandlers(
  jobs: WrapperJobClient,
  options: {
    scopeFor?: (context: PhiHostRequestContext | undefined) => WrapperJobHostScope | undefined
  } = {}
): Record<string, (params: unknown, context?: PhiHostRequestContext) => Promise<unknown>> {
  const scopeFor = (
    context: PhiHostRequestContext | undefined
  ): WrapperJobHostScope | undefined => {
    const scope = options.scopeFor?.(context)
    scope?.signal?.throwIfAborted()
    scope?.assertCurrent?.()
    return scope
  }
  const owned = (scope: WrapperJobHostScope | undefined, runId: string): void => {
    if (scope && !scope.ownsRun(runId))
      throw new Error('Wrapper run is not owned by this Phi session/project')
  }
  return {
    [WRAPPER_JOB_HOST_METHODS.start]: (params, context) => {
      const scope = scopeFor(context)
      if (scope && isRecord(params) && params.target === 'local')
        throw new Error('An SSH project cannot run a wrapper on the desktop')
      const overrides = isRecord(params) && isRecord(params.overrides) ? params.overrides : {}
      const origin =
        scope?.originSessionId ?? (isRecord(params) ? params.originSessionId : undefined)
      return jobs.start(
        {
          id: requireString(params, 'id'),
          overrides,
          ...(isRecord(params) && typeof params.profile === 'string' && params.profile
            ? { profile: params.profile }
            : {}),
          ...(isRecord(params) && params.target === 'remote' ? { target: 'remote' as const } : {}),
          ...(typeof origin === 'string' && origin ? { originSessionId: origin } : {}),
          ...(isRecord(params) && params.continueWhenDone === false
            ? { continueWhenDone: false }
            : {}),
          ...(isRecord(params) && params.resources !== undefined
            ? { resources: params.resources }
            : {})
        },
        scope
      )
    },
    [WRAPPER_JOB_HOST_METHODS.status]: (params, context) => {
      const scope = scopeFor(context),
        runId = requireString(params, 'runId')
      owned(scope, runId)
      return jobs.status(runId)
    },
    [WRAPPER_JOB_HOST_METHODS.list]: async (params, context) => {
      const scope = scopeFor(context)
      const limit = isRecord(params) && typeof params.limit === 'number' ? params.limit : undefined
      const runs = await jobs.list(limit, scope?.ownsRun)
      scope?.signal?.throwIfAborted()
      scope?.assertCurrent?.()
      return runs
    },
    [WRAPPER_JOB_HOST_METHODS.cancel]: (params, context) => {
      const scope = scopeFor(context),
        runId = requireString(params, 'runId')
      owned(scope, runId)
      return jobs.cancel(runId, scope)
    },
    [WRAPPER_JOB_HOST_METHODS.wait]: (params, context) => {
      const scope = scopeFor(context),
        runId = requireString(params, 'runId')
      owned(scope, runId)
      const requested =
        isRecord(params) && typeof params.timeoutMs === 'number' ? params.timeoutMs : 0
      return jobs.wait(runId, Math.min(Math.max(0, requested), MAX_WAIT_MS), scope)
    }
  }
}
