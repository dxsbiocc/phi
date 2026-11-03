import type { RemoteProjectConnectionState } from '../../shared/projectLocation'
import { writeAppLog } from './app-logger'
import { setConnectionEventSink } from './connection-events'
import { markServerProjectsReachable } from './projects'

/**
 * Logs every server connection opening and closing. A connected kernel also proves its
 * server answers, so that server's projects stop showing "connecting".
 */
export function logServerConnections(): void {
  setConnectionEventSink(({ change, ...metadata }) => {
    writeAppLog({ event: `remote_connection_${change}`, metadata })
    if (change === 'opened' && metadata.layer === 'kernel' && metadata.target.startsWith('ssh:')) {
      markServerProjectsReachable(metadata.target.slice('ssh:'.length))
    }
  })
}

export function logProjectConnectionState(
  projectId: string,
  state: RemoteProjectConnectionState
): void {
  writeAppLog({
    event: 'remote_project_connection_state',
    metadata: {
      projectId,
      phase: state.phase,
      ...(state.message ? { message: state.message } : {})
    }
  })
}
