import type { AnalysisNotebookSessionStatus } from '../../../types'

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
  lastAutoConnectKey
}: {
  autoConnectKey: string | null
  hasNotebookFile: boolean
  hasDocument: boolean
  hasStartHandler: boolean
  availableKernelCount: number
  isStartingNotebookSession?: boolean
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  lastAutoConnectKey: string | null
}): boolean {
  return Boolean(
    autoConnectKey &&
    hasNotebookFile &&
    hasDocument &&
    hasStartHandler &&
    availableKernelCount > 0 &&
    !isStartingNotebookSession &&
    !hasLiveNotebookSession(notebookSessionStatus) &&
    lastAutoConnectKey !== autoConnectKey
  )
}
