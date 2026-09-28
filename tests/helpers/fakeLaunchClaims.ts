import type { RemoteExecResult } from '../../src/main/agent/wrappers/remote-ssh-session'

/** The atomic remote mkdir used to reserve one launch attempt per run ID. */
export function fakeLaunchClaimCommand(
  command: string,
  claims: Set<string>
): RemoteExecResult | undefined {
  const path = command.match(/^mkdir '([^']+\/\.phi-launch-claim)' 2>\/dev\/null$/)?.[1]
  if (!path) return undefined
  const exists = claims.has(path)
  if (!exists) claims.add(path)
  return { stdout: '', stderr: '', code: exists ? 1 : 0, signal: null }
}
