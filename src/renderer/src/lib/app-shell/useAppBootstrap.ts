import { useEffect } from 'react'

import { appCopy } from '../appCopy'
import { chatItemsFromSessionMessages } from '../chatItems'
import { orderSessionsForDisplay } from '../sessionOrder'
import type { CurrentSession, Project, SessionSummary } from '../../types'
import type { RendererApi } from '../../types'

/**
 * First paint: who the window is, and what was open when it closed.
 *
 * Both loads are fire-and-forget and independent: the document title and
 * onboarding must appear even if listing sessions fails, and a failed session
 * list must still surface its error. They live together because they are the
 * only two things that run once on mount and seed the shell.
 */
export type AppBootstrapDeps = {
  rendererApi: Pick<
    RendererApi,
    | 'getAppName'
    | 'isOnboarded'
    | 'getPersonaMarkdown'
    | 'listSessions'
    | 'getCurrentSession'
    | 'listProjects'
  >
  mergeSessionSummariesRuntimeState: (sessions: SessionSummary[], cwd: string) => SessionSummary[]
  applyCurrentSession: (
    current: CurrentSession,
    options?: { resetSending?: boolean },
    callbacks?: { onCwdChanged?: () => void; onResetSending?: () => void }
  ) => void
  replaceMessages: (messages: ReturnType<typeof chatItemsFromSessionMessages>) => void
  setProjects: (projects: Project[]) => void
  projectsRef: { current: Project[] }
  setSessions: (sessions: SessionSummary[]) => void
  showSnackbarError: (error: unknown, fallback: string) => void
  resetJupyterRuntimeForCwdChange: () => void
  setPersonaMarkdownState: (markdown: string | null) => void
  setShowOnboarding: (show: boolean) => void
  setIsLoadingHomeSessions: (loading: boolean) => void
}

export function useAppBootstrap(deps: AppBootstrapDeps): void {
  const {
    rendererApi,
    mergeSessionSummariesRuntimeState,
    applyCurrentSession,
    replaceMessages,
    setProjects,
    projectsRef,
    setSessions,
    showSnackbarError,
    resetJupyterRuntimeForCwdChange,
    setPersonaMarkdownState,
    setShowOnboarding,
    setIsLoadingHomeSessions
  } = deps

  useEffect(() => {
    void (async () => {
      const [name, onboarded, markdown] = await Promise.all([
        rendererApi.getAppName(),
        rendererApi.isOnboarded(),
        rendererApi.getPersonaMarkdown()
      ])
      document.title = name
      setPersonaMarkdownState(markdown)
      setShowOnboarding(!onboarded)
    })()
  }, [rendererApi, setPersonaMarkdownState, setShowOnboarding])

  useEffect(() => {
    void (async () => {
      const [sessionList, current, projectList] = await Promise.all([
        rendererApi.listSessions(),
        rendererApi.getCurrentSession(),
        rendererApi.listProjects()
      ])
      setSessions(
        orderSessionsForDisplay(mergeSessionSummariesRuntimeState(sessionList, current.cwd))
      )
      applyCurrentSession(current, undefined, {
        onCwdChanged: resetJupyterRuntimeForCwdChange
      })
      if (Array.isArray(current.messages)) {
        replaceMessages(chatItemsFromSessionMessages(current.messages))
      }
      setProjects(projectList)
      projectsRef.current = projectList
    })()
      .catch((error: unknown) => showSnackbarError(error, appCopy.readChatFailed))
      .finally(() => setIsLoadingHomeSessions(false))
  }, [
    applyCurrentSession,
    mergeSessionSummariesRuntimeState,
    projectsRef,
    rendererApi,
    replaceMessages,
    resetJupyterRuntimeForCwdChange,
    setProjects,
    setSessions,
    showSnackbarError,
    setIsLoadingHomeSessions
  ])
}
