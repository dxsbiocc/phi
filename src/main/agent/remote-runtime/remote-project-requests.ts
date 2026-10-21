import { writeAppLog, type AppLogEntry } from '../app-logger'

interface RemoteProjectConnectionCheck {
  check: (sessionId: string, projectId: string) => Promise<unknown>
}

export interface RemoteProjectRequestsDeps {
  remoteConnectionTracker: RemoteProjectConnectionCheck
  writeAppLog?: (entry: AppLogEntry) => void
}

export interface RemoteProjectRequests {
  scheduleRemoteProjectCheck: (sessionId: string, projectId: string) => void
}

export function remoteRequestProjectId(params: unknown): string {
  if (typeof params !== 'object' || params === null) return ''
  const projectId = (params as Record<string, unknown>).projectId
  return typeof projectId === 'string' ? projectId : ''
}

export function createRemoteProjectRequests(
  deps: RemoteProjectRequestsDeps
): RemoteProjectRequests {
  const appLog = deps.writeAppLog ?? writeAppLog

  const scheduleRemoteProjectCheck: RemoteProjectRequests['scheduleRemoteProjectCheck'] = (
    sessionId,
    projectId
  ) => {
    void deps.remoteConnectionTracker.check(sessionId, projectId).catch((error) => {
      appLog({
        level: 'warn',
        event: 'remote_project_connection_check_failed',
        sessionId,
        metadata: { projectId, reason: error instanceof Error ? error.message : '检查未完成' }
      })
    })
  }

  return { scheduleRemoteProjectCheck }
}
