import { environmentVariables, getRuntimeRoot, type EnvHandle, type PhiPlatform } from '../envs'
import { estimateBuild, type BuildEstimate } from '../envs/estimate'
import type { EnvironmentBuilds } from './environment-builds'
import {
  EnvironmentNotReadyError,
  describeEnvironment,
  readyEnvironment,
  type EnvironmentDescriptor
} from './environment-refs'

export interface ConfirmBuildRequest {
  runtimeSessionId: string
  ref: string
  skill?: string
  agent?: string
  estimate: BuildEstimate
}

export type EnvironmentReady =
  | { status: 'ready'; handle: EnvHandle }
  | { status: 'notReady'; ref: string; envId: string; message: string }
  | { status: 'aborted'; envId: string }

export type BoundSession =
  | { ref: string; envId: string; variables: Record<string, string> }
  | { notReady: { ref: string; envId: string; message: string } }

/**
 * The not-ready path shared by skill runs and specialist binding: join a build
 * that is already running, otherwise ask, then build. Declining, failing, or
 * aborting never falls back to the host. Aborting does not cancel the build.
 */
export async function ensureEnvironmentReady(input: {
  root: string
  descriptor: EnvironmentDescriptor
  ref: string
  requester: { skill?: string; agent?: string }
  runtimeSessionId?: string
  builds?: EnvironmentBuilds
  confirmBuild?: (request: ConfirmBuildRequest) => Promise<boolean>
  signal: AbortSignal
}): Promise<EnvironmentReady> {
  let missing: EnvironmentNotReadyError | undefined
  try {
    return { status: 'ready', handle: readyEnvironment(input.root, input.descriptor) }
  } catch (error) {
    if (!(error instanceof EnvironmentNotReadyError)) throw error
    missing = error
  }
  if (input.signal.aborted) return { status: 'aborted', envId: missing.envId }
  const join = isBuilding(input.builds, missing.envId)
  if (!canPrepareEnvironment(join, input.runtimeSessionId, input.builds, input.confirmBuild)) {
    return {
      status: 'notReady',
      ref: missing.ref,
      envId: missing.envId,
      message: `environment ${missing.ref} is not ready; the user must build it first`
    }
  }
  const builds = input.builds
  if (!builds) {
    return {
      status: 'notReady',
      ref: missing.ref,
      envId: missing.envId,
      message: `environment ${missing.ref} is not ready; the user must build it first`
    }
  }
  try {
    if (!join && input.runtimeSessionId && input.confirmBuild) {
      const estimate = estimateBuild(input.root, input.descriptor.lockText)
      const request: ConfirmBuildRequest = {
        runtimeSessionId: input.runtimeSessionId,
        ref: missing.ref,
        estimate
      }
      if (input.requester.skill) request.skill = input.requester.skill
      if (input.requester.agent) request.agent = input.requester.agent
      const accepted = await untilAbort(input.confirmBuild(request), input.signal)
      if (!accepted) {
        return {
          status: 'notReady',
          ref: missing.ref,
          envId: missing.envId,
          message: `environment ${missing.ref} is not built; the user declined to build it now`
        }
      }
    }
    const requestedBy: { skill?: string; agent?: string } = {}
    if (input.requester.skill) requestedBy.skill = input.requester.skill
    if (input.requester.agent) requestedBy.agent = input.requester.agent
    const handle = await untilAbort(
      builds.start(input.descriptor, {
        ref: missing.ref,
        ...(Object.keys(requestedBy).length > 0 ? { requestedBy } : {})
      }),
      input.signal
    )
    return { status: 'ready', handle }
  } catch (waitError) {
    if (input.signal.aborted || isAbortError(waitError)) {
      return { status: 'aborted', envId: missing.envId }
    }
    return {
      status: 'notReady',
      ref: missing.ref,
      envId: missing.envId,
      message: `environment ${missing.ref} is not ready; ${failureReason(
        builds,
        missing.envId,
        waitError
      )}`
    }
  }
}

/**
 * Host handler for `environments.bindSession`.
 * No skill context: `./environment.yml` is an error.
 */
export async function bindAgentSession(
  params: unknown,
  deps: {
    root?: string
    builds?: EnvironmentBuilds
    confirmBuild?: (request: ConfirmBuildRequest) => Promise<boolean>
    environmentsDir?: string
    platform?: PhiPlatform
    signal?: AbortSignal
  } = {}
): Promise<BoundSession> {
  const record = requireRecord(params)
  const runtimeSessionId = requireString(record, 'runtimeSessionId')
  const ref = requireString(record, 'ref')
  const agent = requireString(record, 'agent')
  requireString(record, 'cwd')
  const root = deps.root ?? getRuntimeRoot()
  const descriptor = describeEnvironment(ref, {
    ...(deps.environmentsDir ? { environmentsDir: deps.environmentsDir } : {}),
    ...(deps.platform ? { platform: deps.platform } : {})
  })
  const outcome = await ensureEnvironmentReady({
    root,
    descriptor,
    ref,
    requester: { agent },
    runtimeSessionId,
    ...(deps.builds ? { builds: deps.builds } : {}),
    ...(deps.confirmBuild ? { confirmBuild: deps.confirmBuild } : {}),
    signal: deps.signal ?? new AbortController().signal
  })
  if (outcome.status === 'aborted') {
    throw new Error(`environment ${descriptor.ref} is not ready; aborted`)
  }
  if (outcome.status === 'notReady') {
    return {
      notReady: { ref: outcome.ref, envId: outcome.envId, message: outcome.message }
    }
  }
  return {
    ref: descriptor.ref,
    envId: outcome.handle.envId,
    variables: environmentVariables(outcome.handle)
  }
}

export function canPrepareEnvironment(
  joining: boolean,
  runtimeSessionId: string | undefined,
  builds: EnvironmentBuilds | undefined,
  confirmBuild: unknown
): boolean {
  if (!joining && (!runtimeSessionId || !confirmBuild || !builds)) return false
  if (!builds) return false
  return true
}

export function isBuilding(builds: EnvironmentBuilds | undefined, envId: string): boolean {
  return builds?.list().some((item) => item.envId === envId && item.state === 'building') ?? false
}

function failureReason(builds: EnvironmentBuilds, envId: string, error: unknown): string {
  const entry = builds.list().find((item) => item.envId === envId)
  if (entry?.state === 'cancelled' || entry?.state === 'failed') {
    return entry.error ?? (entry.state === 'cancelled' ? 'build cancelled' : 'build failed')
  }
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(abortError())
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(abortError())
        else reject(error)
      }
    )
  })
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object')
  }
  return value as Record<string, unknown>
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} is required`)
  return value
}
