import { create } from 'zustand'
import {
  type AgentEventReducerState,
  createAgentEventReducerState,
  replaceAgentEventMessages,
  updateAgentEventMessages
} from '../lib/agentEventReducer'
import {
  idleSessionRuntimeState,
  mergeSessionRuntimeState,
  sessionRuntimeStateFrom,
  sessionRuntimeStateNeedsAcknowledgement,
  sessionRuntimeStatesEqual
} from '../lib/sessionRuntimeState'
import { sessionDraftKey } from '../lib/sessionDrafts'
import { preserveSessionListOrder } from '../lib/sessionOrder'
import { getRendererApi } from '../lib/rendererApi'
import type {
  AgentEventSummary,
  AgentUserInteractionRequest,
  AgentUserInteractionResponse,
  ChatItem,
  CurrentSession,
  PermissionMode,
  SessionRuntimeState,
  SessionSummary,
  ToolApprovalRequest
} from '../types'

export function sessionStateKey(input: {
  phiSessionId?: string | null
  path: string | null
  cwd: string
  sessionGeneration: number
}): string {
  return sessionDraftKey(input)
}

export function sessionStateKeyFromAgentEvent(event: AgentEventSummary): string | null {
  if (typeof event.phiSessionId === 'string') {
    return sessionStateKey({
      phiSessionId: event.phiSessionId,
      path: typeof event.sessionPath === 'string' ? event.sessionPath : null,
      cwd: typeof event.cwd === 'string' ? event.cwd : '',
      sessionGeneration: typeof event.sessionGeneration === 'number' ? event.sessionGeneration : 0
    })
  }
  if (typeof event.sessionGeneration !== 'number' || typeof event.cwd !== 'string') {
    return null
  }
  return sessionStateKey({
    path: typeof event.sessionPath === 'string' ? event.sessionPath : null,
    cwd: event.cwd,
    sessionGeneration: event.sessionGeneration
  })
}

export function sessionStateKeyFromToolApproval(
  request: ToolApprovalRequest,
  fallbackGeneration: number
): string | null {
  if (typeof request.sessionId === 'string') {
    return sessionStateKey({
      phiSessionId: request.sessionId,
      path: typeof request.sessionPath === 'string' ? request.sessionPath : null,
      cwd: typeof request.cwd === 'string' ? request.cwd : '',
      sessionGeneration:
        typeof request.sessionGeneration === 'number'
          ? request.sessionGeneration
          : fallbackGeneration
    })
  }
  if (typeof request.cwd !== 'string') return null
  return sessionStateKey({
    path: typeof request.sessionPath === 'string' ? request.sessionPath : null,
    cwd: request.cwd,
    sessionGeneration:
      typeof request.sessionGeneration === 'number' ? request.sessionGeneration : fallbackGeneration
  })
}

export function sessionStateKeyFromAgentUserInteraction(
  request: AgentUserInteractionRequest,
  fallbackGeneration: number
): string | null {
  if (typeof request.sessionId === 'string') {
    return sessionStateKey({
      phiSessionId: request.sessionId,
      path: typeof request.sessionPath === 'string' ? request.sessionPath : null,
      cwd: typeof request.cwd === 'string' ? request.cwd : '',
      sessionGeneration:
        typeof request.sessionGeneration === 'number'
          ? request.sessionGeneration
          : fallbackGeneration
    })
  }
  if (typeof request.cwd !== 'string') return null
  return sessionStateKey({
    path: typeof request.sessionPath === 'string' ? request.sessionPath : null,
    cwd: request.cwd,
    sessionGeneration:
      typeof request.sessionGeneration === 'number' ? request.sessionGeneration : fallbackGeneration
  })
}

/**
 * These maps back many sessions' worth of bookkeeping (runtime status, pending
 * approvals, cached agent-event state) that the UI never renders directly — only
 * the "active session" slice of each lives in the reactive store state below.
 * Kept outside `set()` (a single app-lifetime module singleton, same lifetime the
 * old per-component refs had) so high-frequency agent events don't force a
 * store-wide notify for bookkeeping nothing subscribes to.
 */
export const sessionRuntimeStates = new Map<string, SessionRuntimeState>()
export const pendingApprovalsBySession = new Map<string, ToolApprovalRequest>()
export const pendingUserInteractionsBySession = new Map<string, AgentUserInteractionRequest>()
export const sessionAgentEventStates = new Map<string, AgentEventReducerState>()

let sessionRefreshTimer: number | null = null
const activeSessionAcknowledgementRequests = new Set<string>()

type SessionStoreState = {
  sessions: SessionSummary[]
  activeSessionPath: string | null
  activePhiSessionId: string | null
  activeCwd: string
  activeSessionGeneration: number
  activeAgentEventStateKey: string | null
  activeChatScrollResetKey: string
  isSessionChanging: boolean
  currentPermissionMode: PermissionMode
  projectSessionRefreshKey: number
  agentEventState: AgentEventReducerState
  pendingApproval: ToolApprovalRequest | null
  pendingUserInteraction: AgentUserInteractionRequest | null
  activeSessionRuntimeState: SessionRuntimeState
  draftInputs: Record<string, string>

  setSessions: (updater: SessionSummary[] | ((prev: SessionSummary[]) => SessionSummary[])) => void
  setActiveSessionPath: (path: string | null) => void
  setActivePhiSessionId: (id: string | null) => void
  setActiveCwd: (cwd: string) => void
  setActiveSessionGeneration: (generation: number) => void
  setIsSessionChanging: (value: boolean) => void
  setCurrentPermissionMode: (mode: PermissionMode) => void
  setProjectSessionRefreshKey: (updater: number | ((prev: number) => number)) => void
  setPendingApproval: (approval: ToolApprovalRequest | null) => void
  setPendingUserInteraction: (request: AgentUserInteractionRequest | null) => void
  setAgentEventState: (state: AgentEventReducerState) => void
  setActiveSessionRuntimeState: (state: SessionRuntimeState) => void
  setDraftInputs: (
    updater: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>)
  ) => void

  storeSessionRuntimeState: (key: string, nextState: SessionRuntimeState) => boolean
  mergeSessionSummariesRuntimeState: (list: SessionSummary[], cwd: string) => SessionSummary[]
  getSessionRuntimeState: (
    path: string,
    cwd: string,
    phiSessionId?: string | null
  ) => SessionRuntimeState | null
  setVisibleAgentEventState: (
    updater: (previous: AgentEventReducerState) => AgentEventReducerState
  ) => void
  replaceMessages: (nextMessages: ChatItem[]) => void
  updateMessages: (updater: (prev: ChatItem[]) => ChatItem[]) => void
  applyCurrentSession: (
    current: CurrentSession,
    options?: { resetSending?: boolean },
    callbacks?: { onCwdChanged?: () => void; onResetSending?: () => void }
  ) => void
  refreshSessions: () => Promise<void>
  acknowledgeActiveSession: (options?: { force?: boolean }) => Promise<boolean>
  startFreshChat: () => void
  scheduleSessionRefresh: () => void
  cancelScheduledSessionRefresh: () => void
  onRenameSession: (path: string, name: string) => Promise<void>
  onRespondToolApproval: (requestId: string, approved: boolean) => Promise<void>
  onRespondAgentUserInteraction: (
    requestId: string,
    response: AgentUserInteractionResponse,
    cancelled?: boolean
  ) => Promise<void>
}

export const useSessionStore = create<SessionStoreState>()((set, get) => ({
  sessions: [],
  activeSessionPath: null,
  activePhiSessionId: null,
  activeCwd: '',
  activeSessionGeneration: 0,
  activeAgentEventStateKey: null,
  activeChatScrollResetKey: sessionStateKey({
    phiSessionId: null,
    path: null,
    cwd: '',
    sessionGeneration: 0
  }),
  isSessionChanging: false,
  currentPermissionMode: 'auto',
  projectSessionRefreshKey: 0,
  agentEventState: createAgentEventReducerState(),
  pendingApproval: null,
  pendingUserInteraction: null,
  activeSessionRuntimeState: idleSessionRuntimeState(),
  draftInputs: {},

  setSessions: (updater) =>
    set((state) => ({
      sessions: typeof updater === 'function' ? updater(state.sessions) : updater
    })),
  setActiveSessionPath: (path) => set({ activeSessionPath: path }),
  setActivePhiSessionId: (id) => set({ activePhiSessionId: id }),
  setActiveCwd: (cwd) => set({ activeCwd: cwd }),
  setActiveSessionGeneration: (generation) => set({ activeSessionGeneration: generation }),
  setIsSessionChanging: (value) => set({ isSessionChanging: value }),
  setCurrentPermissionMode: (mode) => set({ currentPermissionMode: mode }),
  setProjectSessionRefreshKey: (updater) =>
    set((state) => ({
      projectSessionRefreshKey:
        typeof updater === 'function' ? updater(state.projectSessionRefreshKey) : updater
    })),
  setPendingApproval: (approval) => set({ pendingApproval: approval }),
  setPendingUserInteraction: (request) => set({ pendingUserInteraction: request }),
  setAgentEventState: (state) => set({ agentEventState: state }),
  setActiveSessionRuntimeState: (state) => set({ activeSessionRuntimeState: state }),
  setDraftInputs: (updater) =>
    set((state) => ({
      draftInputs: typeof updater === 'function' ? updater(state.draftInputs) : updater
    })),

  storeSessionRuntimeState: (key, nextState) => {
    const previous = sessionRuntimeStates.get(key)
    if (sessionRuntimeStatesEqual(previous, nextState)) return false
    sessionRuntimeStates.set(key, nextState)
    return true
  },

  mergeSessionSummariesRuntimeState: (list, cwd) => {
    const { storeSessionRuntimeState, activeSessionGeneration } = get()
    return list.map((session) => {
      const stateKey = sessionStateKey({
        phiSessionId: session.phiSessionId,
        path: session.path,
        cwd,
        sessionGeneration: activeSessionGeneration
      })
      const nextRuntimeState = mergeSessionRuntimeState(sessionRuntimeStates.get(stateKey), session)
      storeSessionRuntimeState(stateKey, nextRuntimeState)
      return { ...session, ...nextRuntimeState }
    })
  },

  getSessionRuntimeState: (path, cwd, phiSessionId) =>
    sessionRuntimeStates.get(
      sessionStateKey({
        phiSessionId,
        path,
        cwd,
        sessionGeneration: get().activeSessionGeneration
      })
    ) ?? null,

  setVisibleAgentEventState: (updater) => {
    set((state) => {
      const next = updater(state.agentEventState)
      const activeKey = state.activeAgentEventStateKey
      if (activeKey) {
        sessionAgentEventStates.set(activeKey, next)
      }
      return { agentEventState: next }
    })
  },

  replaceMessages: (nextMessages) => {
    get().setVisibleAgentEventState((prev) => replaceAgentEventMessages(prev, nextMessages))
  },

  updateMessages: (updater) => {
    get().setVisibleAgentEventState((prev) => updateAgentEventMessages(prev, updater))
  },

  applyCurrentSession: (current, options = {}, callbacks = {}) => {
    const state = get()
    const previousPath = state.activeSessionPath
    const previousPhiSessionId = state.activePhiSessionId
    const previousCwd = state.activeCwd
    const previousGeneration = state.activeSessionGeneration
    const previousStateKey = state.activeAgentEventStateKey
    const currentPhiSessionId = current.phiSessionId ?? null
    const matchesPreviousPhi =
      currentPhiSessionId !== null && currentPhiSessionId === previousPhiSessionId
    const matchesPreviousPath = current.path !== null && current.path === previousPath
    const matchesFreshTarget =
      currentPhiSessionId === null &&
      current.path === null &&
      previousPhiSessionId === null &&
      previousPath === null
    const isSameTarget =
      current.cwd === previousCwd &&
      (matchesPreviousPhi || matchesPreviousPath || matchesFreshTarget)
    if (isSameTarget && current.sessionGeneration < previousGeneration) return

    const nextStateKey = sessionStateKey({
      phiSessionId: currentPhiSessionId,
      path: current.path,
      cwd: current.cwd,
      sessionGeneration: current.sessionGeneration
    })
    const generationChanged = current.sessionGeneration !== previousGeneration
    const targetChanged = !isSameTarget
    const stateKeyChanged = nextStateKey !== previousStateKey
    const materializesFreshPath = previousPath === null && current.path !== null
    const recordsPhiForKnownPath =
      previousPath !== null && current.path === previousPath && currentPhiSessionId !== null
    const shouldCarryActiveState =
      stateKeyChanged &&
      previousPhiSessionId === null &&
      current.cwd === previousCwd &&
      current.sessionGeneration === previousGeneration &&
      (materializesFreshPath || recordsPhiForKnownPath)
    if (shouldCarryActiveState && previousStateKey) {
      const previousPendingApproval = pendingApprovalsBySession.get(previousStateKey)
      if (previousPendingApproval && !pendingApprovalsBySession.has(nextStateKey)) {
        pendingApprovalsBySession.set(nextStateKey, previousPendingApproval)
        pendingApprovalsBySession.delete(previousStateKey)
      }
      const previousPendingUserInteraction = pendingUserInteractionsBySession.get(previousStateKey)
      if (previousPendingUserInteraction && !pendingUserInteractionsBySession.has(nextStateKey)) {
        pendingUserInteractionsBySession.set(nextStateKey, previousPendingUserInteraction)
        pendingUserInteractionsBySession.delete(previousStateKey)
      }
      const previousRuntimeState = sessionRuntimeStates.get(previousStateKey)
      if (previousRuntimeState && !sessionRuntimeStates.has(nextStateKey)) {
        sessionRuntimeStates.set(nextStateKey, previousRuntimeState)
      }
      set((s) => {
        if (
          s.draftInputs[nextStateKey] !== undefined ||
          s.draftInputs[previousStateKey] === undefined
        ) {
          return s
        }
        const next = { ...s.draftInputs, [nextStateKey]: s.draftInputs[previousStateKey] }
        delete next[previousStateKey]
        return { draftInputs: next }
      })
    }

    if (current.cwd !== previousCwd) {
      callbacks.onCwdChanged?.()
    }

    const nextRuntimeState = mergeSessionRuntimeState(
      sessionRuntimeStates.get(nextStateKey),
      current,
      { preserveBusy: false }
    )
    get().storeSessionRuntimeState(nextStateKey, nextRuntimeState)

    let nextAgentEventState = state.agentEventState
    if (generationChanged || targetChanged || stateKeyChanged) {
      nextAgentEventState =
        sessionAgentEventStates.get(nextStateKey) ??
        (shouldCarryActiveState ? state.agentEventState : createAgentEventReducerState())
      sessionAgentEventStates.set(nextStateKey, nextAgentEventState)
    }

    set({
      activeSessionGeneration: current.sessionGeneration,
      activeSessionPath: current.path,
      activePhiSessionId: currentPhiSessionId,
      activeCwd: current.cwd,
      activeAgentEventStateKey: nextStateKey,
      activeChatScrollResetKey: shouldCarryActiveState
        ? state.activeChatScrollResetKey
        : nextStateKey,
      currentPermissionMode: current.permissionMode ?? 'auto',
      activeSessionRuntimeState: nextRuntimeState,
      pendingApproval: pendingApprovalsBySession.get(nextStateKey) ?? null,
      pendingUserInteraction: pendingUserInteractionsBySession.get(nextStateKey) ?? null,
      agentEventState: nextAgentEventState
    })

    if (options.resetSending || generationChanged || targetChanged) {
      callbacks.onResetSending?.()
    }
  },

  refreshSessions: async () => {
    const rendererApi = getRendererApi()
    const state = get()
    const list = state.mergeSessionSummariesRuntimeState(
      await rendererApi.listSessions(),
      state.activeCwd
    )
    set((s) => ({ sessions: preserveSessionListOrder(s.sessions, list) }))
    const { activeSessionPath, activePhiSessionId } = get()
    if (!activeSessionPath && !activePhiSessionId) return
    const active = list.find((session) =>
      activePhiSessionId
        ? session.phiSessionId === activePhiSessionId
        : session.path === activeSessionPath
    )
    if (!active) return
    const activeKey = sessionStateKey({
      phiSessionId: active.phiSessionId ?? activePhiSessionId,
      path: active.path,
      cwd: get().activeCwd,
      sessionGeneration: get().activeSessionGeneration
    })
    const nextRuntimeState = mergeSessionRuntimeState(sessionRuntimeStates.get(activeKey), active)
    get().storeSessionRuntimeState(activeKey, nextRuntimeState)
    if (activeKey === get().activeAgentEventStateKey) {
      set({ activeSessionRuntimeState: nextRuntimeState })
    }
  },

  acknowledgeActiveSession: async (options = {}) => {
    const state = get()
    const path = state.activeSessionPath
    if (!path) return false

    const activeSummary = state.sessions.find(
      (session) =>
        session.path === path ||
        (typeof state.activePhiSessionId === 'string' &&
          session.phiSessionId === state.activePhiSessionId)
    )
    if (
      !options.force &&
      !sessionRuntimeStateNeedsAcknowledgement(state.activeSessionRuntimeState) &&
      !sessionRuntimeStateNeedsAcknowledgement(activeSummary)
    ) {
      return false
    }

    const requestKey =
      state.activeAgentEventStateKey ??
      sessionStateKey({
        phiSessionId: state.activePhiSessionId,
        path,
        cwd: state.activeCwd,
        sessionGeneration: state.activeSessionGeneration
      })
    if (activeSessionAcknowledgementRequests.has(requestKey)) return false
    activeSessionAcknowledgementRequests.add(requestKey)

    try {
      const acknowledged = await getRendererApi().acknowledgeSession(path)
      if (!acknowledged) return false

      const nextRuntimeState = sessionRuntimeStateFrom(acknowledged)
      const latest = get()
      const activeStillMatches =
        latest.activeSessionPath === acknowledged.path ||
        (typeof acknowledged.phiSessionId === 'string' &&
          acknowledged.phiSessionId === latest.activePhiSessionId)
      const stateKey = activeStillMatches
        ? (latest.activeAgentEventStateKey ??
          sessionStateKey({
            phiSessionId: latest.activePhiSessionId,
            path: latest.activeSessionPath,
            cwd: latest.activeCwd,
            sessionGeneration: latest.activeSessionGeneration
          }))
        : requestKey

      latest.storeSessionRuntimeState(stateKey, nextRuntimeState)
      set((current) => ({
        sessions: current.sessions.map((session) =>
          session.path === acknowledged.path ||
          (typeof acknowledged.phiSessionId === 'string' &&
            session.phiSessionId === acknowledged.phiSessionId)
            ? { ...session, ...nextRuntimeState }
            : session
        ),
        activeSessionRuntimeState: activeStillMatches
          ? nextRuntimeState
          : current.activeSessionRuntimeState,
        projectSessionRefreshKey: current.projectSessionRefreshKey + 1
      }))

      return true
    } finally {
      activeSessionAcknowledgementRequests.delete(requestKey)
    }
  },

  startFreshChat: () => {
    get().replaceMessages([])
  },

  scheduleSessionRefresh: () => {
    if (sessionRefreshTimer !== null) return
    sessionRefreshTimer = window.setTimeout(() => {
      sessionRefreshTimer = null
      void get().refreshSessions()
      get().setProjectSessionRefreshKey((key) => key + 1)
    }, 900)
  },

  cancelScheduledSessionRefresh: () => {
    if (sessionRefreshTimer !== null) {
      window.clearTimeout(sessionRefreshTimer)
      sessionRefreshTimer = null
    }
  },

  onRenameSession: async (path, name) => {
    const rendererApi = getRendererApi()
    await rendererApi.renameSession(path, name)
    await get().refreshSessions()
    get().setProjectSessionRefreshKey((key) => key + 1)
  },

  onRespondToolApproval: async (requestId, approved) => {
    const rendererApi = getRendererApi()
    const activeKey = get().activeAgentEventStateKey
    if (activeKey) {
      pendingApprovalsBySession.delete(activeKey)
    }
    set({ pendingApproval: null })
    await rendererApi.respondToolApproval(requestId, approved)
    await get().refreshSessions()
    get().setProjectSessionRefreshKey((key) => key + 1)
  },

  onRespondAgentUserInteraction: async (requestId, response, cancelled = false) => {
    const rendererApi = getRendererApi()
    const activeKey = get().activeAgentEventStateKey
    if (activeKey) {
      pendingUserInteractionsBySession.delete(activeKey)
    }
    set({ pendingUserInteraction: null })
    await rendererApi.respondAgentUserInteraction(requestId, response, cancelled)
    await get().refreshSessions()
    get().setProjectSessionRefreshKey((key) => key + 1)
  }
}))
