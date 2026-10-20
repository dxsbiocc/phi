import { useEffect, useMemo } from 'react'

import { useSessionStore } from '../../../stores/sessionStore'
import type { AgentEventSummary } from '../../../types'
import {
  handleAgentEvent,
  handleAgentUserInteractionCancelled,
  handleAgentUserInteractionRequest,
  handleAuthInteraction,
  handleSessionChanged,
  handleToolApprovalCancelled,
  handleToolApprovalRequest,
  type SessionEventBridgeDeps,
  type SessionEventStore
} from '../lib/sessionEventBridge'

/**
 * Wires every main-process session subscription to its handler.
 *
 * The subscriptions share one lifetime and one cleanup; splitting them into
 * separate effects would only change the order in which they detach. The
 * routing itself lives in `lib/sessionEventBridge` so it can be tested with a
 * fake store instead of a mounted shell.
 */
export function useSessionEventBridge(deps: Omit<SessionEventBridgeDeps, 'store'>): void {
  const {
    rendererApi,
    isSendingRef,
    projectsRef,
    refreshProjects,
    enqueueTrustedOverlay,
    cancelTrustedOverlay,
    handleAuthInteractionEvent,
    showSettings,
    handleNotebookDraftChanged,
    handleNotebookFileChangedEvent,
    resetJupyterRuntimeForCwdChange,
    workspaceSidebarMode
  } = deps

  const store = useMemo<SessionEventStore>(
    () => ({
      getState: () => useSessionStore.getState(),
      setState: (partial) => useSessionStore.setState(partial)
    }),
    []
  )

  useEffect(() => {
    const bridge: SessionEventBridgeDeps = {
      store,
      rendererApi,
      isSendingRef,
      projectsRef,
      refreshProjects,
      enqueueTrustedOverlay,
      cancelTrustedOverlay,
      handleAuthInteractionEvent,
      showSettings,
      handleNotebookDraftChanged,
      handleNotebookFileChangedEvent,
      resetJupyterRuntimeForCwdChange,
      workspaceSidebarMode
    }
    const unsubscribes = [
      rendererApi.onAgentEvent((event: AgentEventSummary) => handleAgentEvent(bridge, event)),
      rendererApi.onAuthInteraction((event) => handleAuthInteraction(bridge, event)),
      rendererApi.onToolApprovalRequest((event) => handleToolApprovalRequest(bridge, event)),
      rendererApi.onToolApprovalCancelled((requestId) =>
        handleToolApprovalCancelled(bridge, requestId)
      ),
      rendererApi.onAgentUserInteractionRequest((event) =>
        handleAgentUserInteractionRequest(bridge, event)
      ),
      rendererApi.onAgentUserInteractionCancelled(() =>
        handleAgentUserInteractionCancelled(bridge)
      ),
      rendererApi.onAnalysisNotebookDraftChanged(handleNotebookDraftChanged),
      rendererApi.onAnalysisNotebookFileChanged(handleNotebookFileChangedEvent),
      rendererApi.onSessionChanged((session) => handleSessionChanged(bridge, session))
    ]
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe()
      store.getState().cancelScheduledSessionRefresh()
    }
  }, [
    cancelTrustedOverlay,
    enqueueTrustedOverlay,
    handleAuthInteractionEvent,
    handleNotebookDraftChanged,
    handleNotebookFileChangedEvent,
    isSendingRef,
    showSettings,
    projectsRef,
    refreshProjects,
    rendererApi,
    resetJupyterRuntimeForCwdChange,
    store,
    workspaceSidebarMode
  ])
}
