import { createHash } from 'node:crypto'

export const REMOTE_HELPER_READY_MARKER_FILENAME = '.phi-ready.json'
export const REMOTE_HELPER_READY_MARKER_MODE = 0o600
export const REMOTE_HELPER_READY_MARKER_SCHEMA = 1 as const

export interface RemoteHelperReadyMarkerIdentity {
  schema: typeof REMOTE_HELPER_READY_MARKER_SCHEMA
  kind: 'remote-helper'
  version: string
  sha256: string
}

export interface RemoteHelperInstallation {
  managedRoot: string
  remotePath: string
  remoteDirectory: string
  readyMarkerPath: string
  markerIdentity: RemoteHelperReadyMarkerIdentity
  readyMarkerSha256: string
}

export function remoteHelperReadyMarkerIdentity(
  artifact: Readonly<{ version: string; sha256: string }>
): RemoteHelperReadyMarkerIdentity {
  return {
    schema: REMOTE_HELPER_READY_MARKER_SCHEMA,
    kind: 'remote-helper',
    version: artifact.version,
    sha256: artifact.sha256
  }
}

export function serializeRemoteHelperReadyMarker(
  identity: RemoteHelperReadyMarkerIdentity
): string {
  return `${JSON.stringify(identity)}\n`
}

export function remoteHelperReadyMarkerSha256(identity: RemoteHelperReadyMarkerIdentity): string {
  return createHash('sha256').update(serializeRemoteHelperReadyMarker(identity)).digest('hex')
}
