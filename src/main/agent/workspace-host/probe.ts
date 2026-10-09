import type { RemoteExecResult, RemoteSshSession } from '../wrappers/remote-ssh-session'

import { parseHostCapabilityProbe, type ProbedHostCapabilityProfile } from './probe-parse'
import { HOST_CAPABILITY_PROBE_SCRIPT } from './probe-script'

export { parseHostCapabilityProbe, type ProbedHostCapabilityProfile } from './probe-parse'
export { HOST_CAPABILITY_PROBE_SCRIPT } from './probe-script'

export interface HostCapabilityProbeOptions {
  timeoutMs?: number
  now?: () => Date
}

export type HostCapabilityProbeSession = Pick<RemoteSshSession, 'execWithInput'>

const DEFAULT_PROBE_TIMEOUT_MS = 30_000

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

export async function probeHostCapabilities(
  session: HostCapabilityProbeSession,
  options: HostCapabilityProbeOptions = {}
): Promise<ProbedHostCapabilityProfile> {
  const now = options.now ?? (() => new Date())
  if (!session.execWithInput) {
    return failureProfile('SSH session does not support stdin probes', now)
  }
  try {
    const result = await executeWithTimeout(
      session.execWithInput('sh -s', HOST_CAPABILITY_PROBE_SCRIPT),
      options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    )
    const profile = parseHostCapabilityProbe(result.stdout)
    return {
      ...profile,
      probedAt: now().toISOString(),
      ...(result.code === 0
        ? {}
        : {
            probe: {
              state: 'unavailable' as const,
              reason: 'capability probe exited unsuccessfully'
            }
          })
    }
  } catch (error) {
    const timedOut = error instanceof Error && error.message === 'CAPABILITY_PROBE_TIMEOUT'
    return failureProfile(timedOut ? 'capability probe timed out' : 'capability probe failed', now)
  }
}
