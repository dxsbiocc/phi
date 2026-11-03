import type { ProjectLocation } from '../../../shared/projectLocation'

/** A remote session runs from a local anchor directory; approvals show the project's path on the server. */
export function approvalDisplayCwd(sessionCwd: string, location?: ProjectLocation): string {
  return location?.kind === 'ssh' ? location.remoteRoot : sessionCwd
}
