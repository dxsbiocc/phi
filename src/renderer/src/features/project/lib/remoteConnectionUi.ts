import type { RemoteProjectReachability } from '../../../../../shared/projectLocation'

/** Reconnected reads may be retried; writes and commands must be checked manually. */
export function shouldRetryRemoteReads(
  previous: RemoteProjectReachability | null,
  next: RemoteProjectReachability
): boolean {
  return previous !== null && previous !== 'reachable' && next === 'reachable'
}
