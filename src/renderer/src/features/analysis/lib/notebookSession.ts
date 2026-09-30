import type { NotebookDocument } from '../../../../../shared/notebookDocument'
import type {
  AnalysisJupyterRuntimeStatus,
  AnalysisKernelSummary,
  AnalysisNotebookSessionStatus,
  JupyterServerStatus
} from '../../../types'

export function hasLiveNotebookSession(
  status: AnalysisNotebookSessionStatus | null | undefined
): boolean {
  return Boolean(
    status?.sessionId &&
    (status.state === 'idle' || status.state === 'busy' || status.state === 'restarting')
  )
}

export function isNotebookSessionRunnable(
  status: AnalysisNotebookSessionStatus | null | undefined
): boolean {
  return Boolean(status?.sessionId && status.state === 'idle')
}

export function shouldAutoStartNotebookSession({
  autoConnectKey,
  hasNotebookFile,
  hasDocument,
  hasStartHandler,
  availableKernelCount,
  isStartingNotebookSession,
  notebookSessionStatus,
  requestedKernelName,
  lastAutoConnectKey
}: {
  autoConnectKey: string | null
  hasNotebookFile: boolean
  hasDocument: boolean
  hasStartHandler: boolean
  availableKernelCount: number
  isStartingNotebookSession?: boolean
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  requestedKernelName?: string
  lastAutoConnectKey: string | null
}): boolean {
  const liveKernelMismatch = Boolean(
    requestedKernelName &&
    hasLiveNotebookSession(notebookSessionStatus) &&
    notebookSessionStatus?.kernelName &&
    notebookSessionStatus.kernelName !== requestedKernelName
  )
  return Boolean(
    autoConnectKey &&
    hasNotebookFile &&
    hasDocument &&
    hasStartHandler &&
    availableKernelCount > 0 &&
    !isStartingNotebookSession &&
    (!hasLiveNotebookSession(notebookSessionStatus) || liveKernelMismatch) &&
    lastAutoConnectKey !== autoConnectKey
  )
}

export function isListedNotebookKernel(session: AnalysisNotebookSessionStatus): boolean {
  return session.state === 'idle' || session.state === 'busy' || session.state === 'restarting'
}

export function pendingNotebookKernelSession({
  projectCwd,
  notebookPath,
  document,
  kernels
}: {
  projectCwd: string
  notebookPath: string
  document: NotebookDocument
  kernels?: AnalysisKernelSummary[]
}): AnalysisNotebookSessionStatus {
  const spec = kernelspecLabel(document)
  const match = spec.name ? kernels?.find((kernel) => kernel.name === spec.name) : undefined
  return {
    projectCwd,
    notebookPath,
    kernelName: match?.name ?? spec.name,
    kernelDisplayName: match?.displayName ?? spec.displayName ?? spec.name,
    state: 'busy',
    message: '正在连接 kernel'
  }
}

export function upsertNotebookKernelSession(
  status: AnalysisJupyterRuntimeStatus | null,
  session: AnalysisNotebookSessionStatus,
  server: JupyterServerStatus | null | undefined
): AnalysisJupyterRuntimeStatus | null {
  const base =
    status ??
    (server
      ? {
          server,
          notebooks: { activeSessionCount: 0, busySessionCount: 0, sessions: [] }
        }
      : null)
  if (!base) return status
  const sessions = [
    session,
    ...base.notebooks.sessions.filter((item) => item.notebookPath !== session.notebookPath)
  ]
  return { ...base, notebooks: summarizeNotebookSessions(sessions) }
}

export function dropUnconfirmedNotebookKernelSession(
  status: AnalysisJupyterRuntimeStatus | null,
  notebookPath: string
): AnalysisJupyterRuntimeStatus | null {
  if (!status) return status
  const sessions = status.notebooks.sessions.filter(
    (item) => item.notebookPath !== notebookPath || Boolean(item.sessionId)
  )
  return { ...status, notebooks: summarizeNotebookSessions(sessions) }
}

function summarizeNotebookSessions(
  sessions: AnalysisNotebookSessionStatus[]
): AnalysisJupyterRuntimeStatus['notebooks'] {
  return {
    activeSessionCount: sessions.length,
    busySessionCount: sessions.filter(
      (session) => session.state === 'busy' || session.state === 'restarting'
    ).length,
    sessions
  }
}

function kernelspecLabel(document: NotebookDocument): { name?: string; displayName?: string } {
  const spec = document.metadata.kernelspec
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return {}
  const record = spec as Record<string, unknown>
  return {
    name: typeof record.name === 'string' && record.name ? record.name : undefined,
    displayName:
      typeof record.display_name === 'string' && record.display_name
        ? record.display_name
        : undefined
  }
}
