import type { AgentEventReducerState } from '../../../lib/agentEventReducer'
import { createAgentEventReducerState, reduceAgentEventState } from '../../../lib/agentEventReducer'
import {
  agentEventBelongsToActiveSession,
  agentEventMaterializesActiveFreshSession
} from '../../../lib/agentEventRouting'
import { shouldRefreshProjectGitStatusForAgentEvent } from '../../../lib/projectGitRefresh'
import {
  idleSessionRuntimeState,
  reduceSessionRuntimeState
} from '../../../lib/sessionRuntimeState'
import type { WorkspaceSidebarMode } from '../../../lib/workspaceSidebar'
import {
  pendingApprovalsBySession,
  pendingUserInteractionsBySession,
  sessionAgentEventStates,
  sessionRuntimeStates,
  sessionStateKeyFromAgentEvent,
  sessionStateKeyFromAgentUserInteraction,
  sessionStateKeyFromToolApproval
} from '../../../stores/sessionStore'
import type {
  AgentEventSummary,
  AgentUserInteractionRequest,
  AnalysisNotebookDraftChange,
  AnalysisNotebookFileChange,
  AuthInteractionEvent,
  CurrentSession,
  Project,
  RendererApi,
  SessionRuntimeState,
  ToolApprovalRequest
} from '../../../types'
import type {
  BrowserTrustedOverlayKind,
  BrowserTrustedOverlayRequest
} from '../../browser/lib/browserTrustedOverlayGate'

/**
 * Main-process session events, routed into the session store.
 *
 * Every subscription here shares one lifetime (the app shell's mount) and one
 * job: turn an event from the bridge into the state the window renders —
 * per-session runtime state, per-session reducer state, the pending approval or
 * user interaction, and the refresh nudges the sidebars need.
 *
 * The handlers are plain functions over an explicit dependency object, so the
 * routing rules (which event belongs to the active session, when a fresh session
 * is materialized, which session an approval belongs to) can be tested without
 * mounting the shell. The hook next to this file only wires the subscriptions.
 */

/** The slice of the session store the bridge reads and writes. */
export type SessionEventStoreState = {
  activePhiSessionId: string | null
  activeSessionPath: string | null
  activeCwd: string
  activeSessionGeneration: number
  activeAgentEventStateKey: string | null
  agentEventState: AgentEventReducerState
  pendingApproval: ToolApprovalRequest | null
  setAgentEventState: (state: AgentEventReducerState) => void
  setActiveSessionRuntimeState: (state: SessionRuntimeState) => void
  setVisibleAgentEventState: (
    updater: (previous: AgentEventReducerState) => AgentEventReducerState
  ) => void
  setPendingApproval: (approval: ToolApprovalRequest | null) => void
  setPendingUserInteraction: (request: AgentUserInteractionRequest | null) => void
  storeSessionRuntimeState: (key: string, nextState: SessionRuntimeState) => boolean
  setProjectSessionRefreshKey: (updater: (previous: number) => number) => void
  applyCurrentSession: (
    current: CurrentSession,
    options?: { resetSending?: boolean },
    callbacks?: { onCwdChanged?: () => void; onResetSending?: () => void }
  ) => void
  scheduleSessionRefresh: () => void
  cancelScheduledSessionRefresh: () => void
}

export type SessionEventActiveKeys = Partial<
  Pick<
    SessionEventStoreState,
    'activeAgentEventStateKey' | 'activePhiSessionId' | 'activeSessionPath'
  >
>

export type SessionEventStore = {
  getState: () => SessionEventStoreState
  setState: (partial: SessionEventActiveKeys) => void
}

export type SessionEventBridgeDeps = {
  store: SessionEventStore
  rendererApi: Pick<
    RendererApi,
    | 'submitAuthInteraction'
    | 'respondToolApproval'
    | 'respondAgentUserInteraction'
    | 'onAgentEvent'
    | 'onAuthInteraction'
    | 'onToolApprovalRequest'
    | 'onToolApprovalCancelled'
    | 'onAgentUserInteractionRequest'
    | 'onAgentUserInteractionCancelled'
    | 'onAnalysisNotebookDraftChanged'
    | 'onAnalysisNotebookFileChanged'
    | 'onSessionChanged'
  >
  /** True while a prompt is in flight, so a fresh session may materialize. */
  isSendingRef: { current: boolean }
  projectsRef: { current: Project[] }
  refreshProjects: () => void
  enqueueTrustedOverlay: (request: BrowserTrustedOverlayRequest) => void
  cancelTrustedOverlay: (kind: BrowserTrustedOverlayKind, key?: string) => void
  handleAuthInteractionEvent: (event: AuthInteractionEvent) => boolean
  /** Reveals settings without the browser gate: the overlay already owns the screen. */
  showSettings: () => void
  handleNotebookDraftChanged: (change: AnalysisNotebookDraftChange) => void
  handleNotebookFileChangedEvent: (change: AnalysisNotebookFileChange) => void
  resetJupyterRuntimeForCwdChange: () => void
  workspaceSidebarMode: WorkspaceSidebarMode
}

export function handleAgentEvent(deps: SessionEventBridgeDeps, event: AgentEventSummary): void {
  const state = deps.store.getState()
  if (event.sessionPath) state.scheduleSessionRefresh()

  const activeSessionIdentity = {
    phiSessionId: state.activePhiSessionId,
    path: state.activeSessionPath,
    cwd: state.activeCwd,
    sessionGeneration: state.activeSessionGeneration
  }
  const materializesActiveFreshSession = agentEventMaterializesActiveFreshSession(
    event,
    activeSessionIdentity,
    deps.isSendingRef.current
  )
  const belongsToActiveSession =
    materializesActiveFreshSession || agentEventBelongsToActiveSession(event, activeSessionIdentity)
  const eventStateKey = sessionStateKeyFromAgentEvent(event)
  if (eventStateKey) {
    const nextRuntimeState = reduceSessionRuntimeState(
      sessionRuntimeStates.get(eventStateKey) ?? idleSessionRuntimeState(),
      event
    )
    const runtimeStateChanged = state.storeSessionRuntimeState(eventStateKey, nextRuntimeState)
    const baseState =
      sessionAgentEventStates.get(eventStateKey) ??
      (belongsToActiveSession ? state.agentEventState : createAgentEventReducerState())
    const nextState = reduceAgentEventState(baseState, event)
    sessionAgentEventStates.set(eventStateKey, nextState)
    if (belongsToActiveSession) {
      deps.store.setState({
        activeAgentEventStateKey: eventStateKey,
        ...(materializesActiveFreshSession && typeof event.phiSessionId === 'string'
          ? { activePhiSessionId: event.phiSessionId }
          : {}),
        ...(materializesActiveFreshSession && typeof event.sessionPath === 'string'
          ? { activeSessionPath: event.sessionPath }
          : {})
      })
      state.setAgentEventState(nextState)
      state.setActiveSessionRuntimeState(nextRuntimeState)
    }
    if (runtimeStateChanged) state.setProjectSessionRefreshKey((key) => key + 1)
    if (shouldRefreshProjectGitStatusForAgentEvent(event, deps.projectsRef.current)) {
      void deps.refreshProjects()
    }
    return
  }

  if (!belongsToActiveSession) return
  state.setVisibleAgentEventState((prev) => reduceAgentEventState(prev, event))
}

export function handleAuthInteraction(
  deps: SessionEventBridgeDeps,
  event: AuthInteractionEvent
): void {
  deps.enqueueTrustedOverlay({
    kind: 'auth',
    key: event.type === 'prompt' ? event.requestId : `${event.providerId}:${event.event.type}`,
    onCancel:
      event.type === 'prompt'
        ? () => deps.rendererApi.submitAuthInteraction(event.requestId, '')
        : undefined,
    publish: () => {
      if (deps.handleAuthInteractionEvent(event)) deps.showSettings()
    }
  })
}

export function handleToolApprovalRequest(
  deps: SessionEventBridgeDeps,
  event: ToolApprovalRequest
): void {
  deps.enqueueTrustedOverlay({
    kind: 'approval',
    key: event.requestId,
    onCancel: () => deps.rendererApi.respondToolApproval(event.requestId, false),
    publish: () => {
      const state = deps.store.getState()
      const approvalStateKey = sessionStateKeyFromToolApproval(event, state.activeSessionGeneration)
      if (approvalStateKey) {
        pendingApprovalsBySession.set(approvalStateKey, event)
        const nextRuntimeState = {
          ...(sessionRuntimeStates.get(approvalStateKey) ?? idleSessionRuntimeState()),
          status: 'needs_approval' as const,
          unreadKind: 'approval' as const,
          currentRunId: event.runId
        }
        state.storeSessionRuntimeState(approvalStateKey, nextRuntimeState)
        if (approvalStateKey === state.activeAgentEventStateKey) {
          state.setPendingApproval(event)
          state.setActiveSessionRuntimeState(nextRuntimeState)
        }
      } else {
        state.setPendingApproval(event)
      }
      state.setProjectSessionRefreshKey((key) => key + 1)
      state.scheduleSessionRefresh()
    }
  })
}

export function handleToolApprovalCancelled(
  deps: SessionEventBridgeDeps,
  requestId?: string
): void {
  deps.cancelTrustedOverlay('approval', requestId)
  const state = deps.store.getState()
  if (requestId) {
    for (const [key, request] of pendingApprovalsBySession) {
      if (request.requestId === requestId) pendingApprovalsBySession.delete(key)
    }
    if (state.pendingApproval?.requestId === requestId) state.setPendingApproval(null)
  } else {
    pendingApprovalsBySession.clear()
    state.setPendingApproval(null)
  }
  state.scheduleSessionRefresh()
}

export function handleAgentUserInteractionRequest(
  deps: SessionEventBridgeDeps,
  event: AgentUserInteractionRequest
): void {
  deps.enqueueTrustedOverlay({
    kind: 'interaction',
    key: event.requestId,
    onCancel: () =>
      deps.rendererApi.respondAgentUserInteraction(
        event.requestId,
        { requestId: event.requestId, answers: [], cancelled: true },
        true
      ),
    publish: () => {
      const state = deps.store.getState()
      const interactionStateKey = sessionStateKeyFromAgentUserInteraction(
        event,
        state.activeSessionGeneration
      )
      if (interactionStateKey) {
        pendingUserInteractionsBySession.set(interactionStateKey, event)
        const nextRuntimeState = {
          ...(sessionRuntimeStates.get(interactionStateKey) ?? idleSessionRuntimeState()),
          status: 'needs_input' as const,
          unreadKind: 'input' as const,
          currentRunId: event.runId
        }
        state.storeSessionRuntimeState(interactionStateKey, nextRuntimeState)
        if (interactionStateKey === state.activeAgentEventStateKey) {
          state.setPendingUserInteraction(event)
          state.setActiveSessionRuntimeState(nextRuntimeState)
        }
      } else {
        state.setPendingUserInteraction(event)
      }
      state.setProjectSessionRefreshKey((key) => key + 1)
      state.scheduleSessionRefresh()
    }
  })
}

export function handleAgentUserInteractionCancelled(deps: SessionEventBridgeDeps): void {
  deps.cancelTrustedOverlay('interaction')
  pendingUserInteractionsBySession.clear()
  const state = deps.store.getState()
  state.setPendingUserInteraction(null)
  state.scheduleSessionRefresh()
}

export function handleSessionChanged(deps: SessionEventBridgeDeps, session: CurrentSession): void {
  const state = deps.store.getState()
  state.applyCurrentSession(session, undefined, {
    onCwdChanged: deps.resetJupyterRuntimeForCwdChange
  })
  state.setProjectSessionRefreshKey((key) => key + 1)
  if (deps.workspaceSidebarMode === 'projects') {
    void deps.refreshProjects()
  }
}
