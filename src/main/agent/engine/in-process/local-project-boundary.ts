import { isRemoteProjectAnchorPath } from '../../remote-project-anchor'
import { isRecord } from './common'

export const IN_PROCESS_REMOTE_PROJECT_ERROR = 'SSH project sessions require the remote RPC runtime'

function isSshProjectLocation(value: unknown): boolean {
  return isRecord(value) && value.kind === 'ssh'
}

/** Prevents Phi-private SSH anchors and manifests from reaching desktop OMP sessions. */
export function assertInProcessLocalProject(params: unknown): void {
  const record = isRecord(params) ? params : {}
  const agentDir = typeof record.agentDir === 'string' ? record.agentDir : undefined
  const sessionManager = isRecord(record.sessionManager) ? record.sessionManager : undefined
  const manifest = isRecord(record.manifest) ? record.manifest : undefined
  const sessionManifest = isRecord(record.sessionManifest) ? record.sessionManifest : undefined
  const paths = [record.cwd, sessionManager?.cwd]

  if (
    record.remoteProject !== undefined ||
    isSshProjectLocation(record.projectLocation) ||
    isSshProjectLocation(manifest?.projectLocation) ||
    isSshProjectLocation(sessionManifest?.projectLocation) ||
    paths.some((path) => typeof path === 'string' && isRemoteProjectAnchorPath(path, agentDir))
  ) {
    throw new Error(IN_PROCESS_REMOTE_PROJECT_ERROR)
  }
}
