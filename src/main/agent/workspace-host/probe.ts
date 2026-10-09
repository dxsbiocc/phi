import type { RemoteExecResult, RemoteSshSession } from '../wrappers/remote-ssh-session'

import { parseHostCapabilityProbe, type ProbedHostCapabilityProfile } from './probe-parse'
import {
  HOST_CAPABILITY_FAST_PROBE_SCRIPT,
  HOST_CAPABILITY_SLOW_PROBE_SCRIPT,
  PROBE_START_SENTINEL
} from './probe-script'

export { parseHostCapabilityProbe, type ProbedHostCapabilityProfile } from './probe-parse'
export {
  HOST_CAPABILITY_FAST_PROBE_SCRIPT,
  HOST_CAPABILITY_PROBE_SCRIPT,
  HOST_CAPABILITY_SLOW_PROBE_SCRIPT
} from './probe-script'

export interface HostCapabilityProbeOptions {
  timeoutMs?: number
  fastTimeoutMs?: number
  slowTimeoutMs?: number
  now?: () => Date
}

export type HostCapabilityProbeSession = Pick<RemoteSshSession, 'execWithInput'>

const DEFAULT_FAST_PROBE_TIMEOUT_MS = 10_000
const DEFAULT_SLOW_PROBE_TIMEOUT_MS = 30_000

function failureProfile(reason: string, now: () => Date): ProbedHostCapabilityProfile {
  const profile = parseHostCapabilityProbe('')
  return {
    ...profile,
    probedAt: now().toISOString(),
    probe: { state: 'unavailable', reason }
  }
}

function executeWithTimeout(
  execution: Promise<RemoteExecResult>,
  timeoutMs: number
): Promise<RemoteExecResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CAPABILITY_PROBE_TIMEOUT')), timeoutMs)
    timer.unref()
    execution.then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function withProbeTime(
  profile: ProbedHostCapabilityProfile,
  now: () => Date
): ProbedHostCapabilityProfile {
  return { ...profile, probedAt: now().toISOString() }
}

function unsuccessfulFastProbe(
  result: RemoteExecResult,
  now: () => Date
): ProbedHostCapabilityProfile {
  const profile = parseHostCapabilityProbe(result.stdout)
  return withProbeTime(
    {
      ...profile,
      probe: { state: 'unavailable', reason: 'capability probe exited unsuccessfully' }
    },
    now
  )
}

export async function probeHostCapabilities(
  session: HostCapabilityProbeSession,
  options: HostCapabilityProbeOptions = {}
): Promise<ProbedHostCapabilityProfile> {
  const now = options.now ?? (() => new Date())
  if (!session.execWithInput) {
    return failureProfile('SSH session does not support stdin probes', now)
  }
  let fastResult: RemoteExecResult
  try {
    fastResult = await executeWithTimeout(
      session.execWithInput('sh -s', HOST_CAPABILITY_FAST_PROBE_SCRIPT),
      options.fastTimeoutMs ??
        Math.min(options.timeoutMs ?? DEFAULT_FAST_PROBE_TIMEOUT_MS, DEFAULT_FAST_PROBE_TIMEOUT_MS)
    )
  } catch (error) {
    const timedOut = error instanceof Error && error.message === 'CAPABILITY_PROBE_TIMEOUT'
    return failureProfile(timedOut ? 'capability probe timed out' : 'capability probe failed', now)
  }
  if (fastResult.code !== 0) return unsuccessfulFastProbe(fastResult, now)
  const fastProfile = parseHostCapabilityProbe(fastResult.stdout)
  if (fastResult.stdout.includes(PROBE_START_SENTINEL)) return withProbeTime(fastProfile, now)
  if (fastProfile.probe?.state === 'unavailable') return withProbeTime(fastProfile, now)

  try {
    const slowResult = await executeWithTimeout(
      session.execWithInput('sh -s', HOST_CAPABILITY_SLOW_PROBE_SCRIPT),
      options.slowTimeoutMs ?? options.timeoutMs ?? DEFAULT_SLOW_PROBE_TIMEOUT_MS
    )
    const profile = parseHostCapabilityProbe(`${fastResult.stdout}\n${slowResult.stdout}`, {
      ...(slowResult.code === 0 ? {} : { slowFailure: 'failed' as const })
    })
    return withProbeTime(profile, now)
  } catch (error) {
    const timedOut = error instanceof Error && error.message === 'CAPABILITY_PROBE_TIMEOUT'
    const profile = parseHostCapabilityProbe(fastResult.stdout, {
      slowFailure: timedOut ? 'timed-out' : 'failed'
    })
    return withProbeTime(profile, now)
  }
}
