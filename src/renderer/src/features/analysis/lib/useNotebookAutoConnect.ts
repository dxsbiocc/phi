import { useEffect, useRef, type MutableRefObject } from 'react'
import type { NotebookDocument } from '../../../../../shared/notebookDocument'
import type {
  AnalysisKernelDiagnostics,
  AnalysisNotebookFile,
  AnalysisNotebookSessionStatus
} from '../../../types'
import { hasLiveNotebookSession, shouldAutoStartNotebookSession } from './notebookSession'

const AUTO_CONNECT_RETRY_DELAY_MS = 4000

type StartNotebookSession = (
  file: AnalysisNotebookFile,
  document: NotebookDocument
) => void | Promise<void>

/**
 * Drives the notebook canvas's "connect to a kernel as soon as it's opened"
 * behavior, plus a bounded retry: a first attempt can fail simply because
 * the app-managed Jupyter Server was still starting up, and without a
 * retry the attempted key latches permanently, leaving the notebook
 * "disconnected" forever even once the server becomes ready.
 */
export function useNotebookAutoConnect(input: {
  autoConnectKey: string | null
  notebookFile?: AnalysisNotebookFile | null
  draftDocument: NotebookDocument | null
  onStartNotebookSession?: StartNotebookSession
  kernelDiagnostics?: AnalysisKernelDiagnostics | null
  isStartingNotebookSession?: boolean
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  notebookSessionError?: string | null
  requestedKernelName?: string
}): { autoConnectKeyRef: MutableRefObject<string | null> } {
  const {
    autoConnectKey,
    notebookFile,
    draftDocument,
    onStartNotebookSession,
    kernelDiagnostics,
    isStartingNotebookSession,
    notebookSessionStatus,
    notebookSessionError,
    requestedKernelName
  } = input
  const autoConnectKeyRef = useRef<string | null>(null)
  const sessionStatusForNotebook =
    notebookSessionStatus &&
    notebookFile &&
    notebookSessionStatus.notebookPath !== notebookFile.path
      ? null
      : notebookSessionStatus

  useEffect(() => {
    if (
      !shouldAutoStartNotebookSession({
        autoConnectKey,
        hasNotebookFile: Boolean(notebookFile),
        hasDocument: Boolean(draftDocument),
        hasStartHandler: Boolean(onStartNotebookSession),
        availableKernelCount: kernelDiagnostics?.kernels.length ?? 0,
        isStartingNotebookSession,
        notebookSessionStatus: sessionStatusForNotebook,
        requestedKernelName,
        lastAutoConnectKey: autoConnectKeyRef.current
      }) ||
      !notebookFile ||
      !draftDocument ||
      !onStartNotebookSession
    ) {
      return
    }
    autoConnectKeyRef.current = autoConnectKey
    onStartNotebookSession(notebookFile, draftDocument)
  }, [
    autoConnectKey,
    draftDocument,
    isStartingNotebookSession,
    kernelDiagnostics?.kernels.length,
    notebookFile,
    notebookSessionStatus,
    onStartNotebookSession,
    requestedKernelName,
    sessionStatusForNotebook
  ])

  useEffect(() => {
    if (
      !notebookSessionError ||
      !notebookFile ||
      !draftDocument ||
      !onStartNotebookSession ||
      isStartingNotebookSession ||
      hasLiveNotebookSession(sessionStatusForNotebook)
    ) {
      return
    }
    const retryTimer = window.setTimeout(() => {
      autoConnectKeyRef.current = autoConnectKey
      onStartNotebookSession(notebookFile, draftDocument)
    }, AUTO_CONNECT_RETRY_DELAY_MS)
    return () => window.clearTimeout(retryTimer)
  }, [
    notebookSessionError,
    notebookFile,
    draftDocument,
    onStartNotebookSession,
    isStartingNotebookSession,
    notebookSessionStatus,
    sessionStatusForNotebook,
    autoConnectKey
  ])

  return { autoConnectKeyRef }
}
