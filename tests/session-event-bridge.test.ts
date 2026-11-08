import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'

import { createAgentEventReducerState } from '../src/renderer/src/lib/agentEventReducer'
import {
  handleAgentEvent,
  handleAgentUserInteractionCancelled,
  handleAgentUserInteractionRequest,
  handleAuthInteraction,
  handleSessionChanged,
  handleToolApprovalCancelled,
  handleToolApprovalRequest,
  type SessionEventBridgeDeps,
  type SessionEventStore,
  type SessionEventStoreState
} from '../src/renderer/src/features/chat/lib/sessionEventBridge'
import {
  clearPendingApprovals,
  pendingApprovalsBySession,
  pendingUserInteractionsBySession,
  removePendingApproval,
  sessionAgentEventStates,
  subscribeSessionEvents,
  sessionRuntimeStates,
  sessionStateKey,
  sessionStateKeyFromToolApproval
} from '../src/renderer/src/stores/sessionStore'
import type {
  AgentEventSummary,
  AgentUserInteractionRequest,
  CurrentSession,
  Project,
  ToolApprovalRequest
} from '../src/renderer/src/types'

const activeKey = sessionStateKey({
  phiSessionId: 'phi-a',
  path: '/a.jsonl',
  cwd: '/project',
  sessionGeneration: 3
})

type Overlay = {
  kind: string
  key: string
  publish(): void
  onCancel?(): void | Promise<void>
}

function harness(
  stateOverrides: Partial<SessionEventStoreState> = {},
  sending = false
): {
  deps: SessionEventBridgeDeps
  state: SessionEventStoreState
  writes: string[]
  overlays: Overlay[]
  cancels: Array<[string, string | undefined]>
  refreshProjects: () => number
  settingsOpened: () => number
  appliedSession: () => CurrentSession | null
} {
  const writes: string[] = []
  const overlays: Overlay[] = []
  const cancels: Array<[string, string | undefined]> = []
  let refreshCount = 0
  let settingsCount = 0
  let applied: CurrentSession | null = null

  const state: SessionEventStoreState = {
    activePhiSessionId: 'phi-a',
    activeSessionPath: '/a.jsonl',
    activeCwd: '/project',
    activeSessionGeneration: 3,
    activeAgentEventStateKey: activeKey,
    agentEventState: createAgentEventReducerState(),
    pendingApproval: null,
    setAgentEventState: (next) => {
      state.agentEventState = next
      writes.push('agentEventState')
    },
    setActiveSessionRuntimeState: () => writes.push('activeRuntime'),
    setVisibleAgentEventState: (updater) => {
      state.agentEventState = updater(state.agentEventState)
      writes.push('visibleState')
    },
    setPendingApproval: (approval) => {
      state.pendingApproval = approval
      writes.push('pendingApproval')
    },
    setPendingUserInteraction: () => writes.push('pendingInteraction'),
    storeSessionRuntimeState: (key, next) => {
      sessionRuntimeStates.set(key, next)
      writes.push('runtime')
      return true
    },
    setProjectSessionRefreshKey: () => writes.push('projectKey'),
    applyCurrentSession: (session) => {
      applied = session
      writes.push('applySession')
    },
    scheduleSessionRefresh: () => writes.push('scheduleRefresh'),
    cancelScheduledSessionRefresh: () => writes.push('cancelRefresh'),
    ...stateOverrides
  }

  const store: SessionEventStore = {
    getState: () => state,
    setState: (partial) => Object.assign(state, partial)
  }

  const deps: SessionEventBridgeDeps = {
    store,
    rendererApi: {
      submitAuthInteraction: async () => undefined,
      respondToolApproval: async () => undefined,
      respondAgentUserInteraction: async () => undefined,
      showPendingRequests: async () => undefined,
      onAgentEvent: () => () => undefined,
      onAuthInteraction: () => () => undefined,
      onToolApprovalRequest: () => () => undefined,
      onToolApprovalCancelled: () => () => undefined,
      onAgentUserInteractionRequest: () => () => undefined,
      onAgentUserInteractionCancelled: () => () => undefined,
      onAnalysisNotebookDraftChanged: () => () => undefined,
      onAnalysisNotebookFileChanged: () => () => undefined,
      onSessionChanged: () => () => undefined
    },
    isSendingRef: { current: sending },
    projectsRef: { current: [] },
    refreshProjects: () => {
      refreshCount += 1
    },
    enqueueTrustedOverlay: (request) => overlays.push(request),
    cancelTrustedOverlay: (kind, key) => cancels.push([kind, key]),
    handleAuthInteractionEvent: () => true,
    showSettings: () => {
      settingsCount += 1
    },
    handleNotebookDraftChanged: () => undefined,
    handleNotebookFileChangedEvent: () => undefined,
    resetJupyterRuntimeForCwdChange: () => undefined,
    workspaceSidebarMode: 'conversations'
  }

  return {
    deps,
    state,
    writes,
    overlays,
    cancels,
    refreshProjects: () => refreshCount,
    settingsOpened: () => settingsCount,
    appliedSession: () => applied
  }
}

beforeEach(() => {
  sessionRuntimeStates.clear()
  clearPendingApprovals()
  pendingUserInteractionsBySession.clear()
  sessionAgentEventStates.clear()
})

const runStarted = (overrides: Partial<AgentEventSummary> = {}): AgentEventSummary => ({
  type: 'run_started',
  phiSessionId: 'phi-a',
  sessionPath: '/a.jsonl',
  cwd: '/project',
  sessionGeneration: 3,
  runId: 'run-a',
  ...overrides
})

const messageEnd = (sessionPath: string): AgentEventSummary => ({
  type: 'message_end',
  sessionPath,
  cwd: '/project',
  message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }
})

const currentSession = (overrides: Partial<CurrentSession> = {}): CurrentSession => ({
  path: '/a.jsonl',
  phiSessionId: 'phi-a',
  cwd: '/project',
  sessionGeneration: 3,
  permissionMode: 'auto',
  status: 'idle',
  unreadKind: null,
  ...overrides
})

const approval = (overrides: Partial<ToolApprovalRequest> = {}): ToolApprovalRequest => ({
  requestId: 'approval-1',
  sessionId: 'phi-a',
  sessionPath: '/a.jsonl',
  cwd: '/project',
  sessionGeneration: 3,
  runId: 'run-a',
  toolName: 'bash',
  summary: 'ls',
  ...overrides
})

test('an event for the active session drives both the visible timeline and its runtime state', () => {
  const h = harness()
  handleAgentEvent(h.deps, runStarted())
  assert.deepEqual(h.writes, [
    'scheduleRefresh',
    'runtime',
    'agentEventState',
    'activeRuntime',
    'projectKey'
  ])
  assert.equal(h.state.activeAgentEventStateKey, activeKey)
  assert.ok(sessionAgentEventStates.has(activeKey))
  assert.equal(sessionRuntimeStates.get(activeKey)?.currentRunId, 'run-a')
})

test('a background session event only updates that session’s bookkeeping', () => {
  const h = harness()
  const before = h.state.agentEventState
  handleAgentEvent(h.deps, runStarted({ phiSessionId: 'phi-b', sessionPath: '/b.jsonl' }))
  assert.equal(h.state.agentEventState, before)
  assert.equal(h.state.activeAgentEventStateKey, activeKey)
  assert.ok(
    sessionAgentEventStates.has(
      sessionStateKey({
        phiSessionId: 'phi-b',
        path: '/b.jsonl',
        cwd: '/project',
        sessionGeneration: 3
      })
    )
  )
  assert.ok(!h.writes.includes('agentEventState'))
})

test('a run started while sending materializes the fresh session as the active one', () => {
  const h = harness(
    { activePhiSessionId: null, activeSessionPath: null, activeSessionGeneration: 4 },
    true
  )
  handleAgentEvent(
    h.deps,
    runStarted({ phiSessionId: 'phi-new', sessionPath: '/new.jsonl', sessionGeneration: 4 })
  )
  assert.equal(h.state.activePhiSessionId, 'phi-new')
  assert.equal(h.state.activeSessionPath, '/new.jsonl')
})

test('the same run started event does not materialize anything when no send is in flight', () => {
  const h = harness(
    { activePhiSessionId: null, activeSessionPath: null, activeSessionGeneration: 4 },
    false
  )
  handleAgentEvent(
    h.deps,
    runStarted({ phiSessionId: 'phi-new', sessionPath: '/new.jsonl', sessionGeneration: 4 })
  )
  assert.equal(h.state.activePhiSessionId, null)
  assert.equal(h.state.activeSessionPath, null)
  assert.ok(!h.writes.includes('agentEventState'))
})

test('an event without a session key reaches the visible timeline only for the active session', () => {
  const active = harness()
  handleAgentEvent(active.deps, messageEnd('/a.jsonl'))
  assert.ok(active.writes.includes('visibleState'))
  assert.ok(!active.writes.includes('runtime'))

  const background = harness()
  handleAgentEvent(background.deps, messageEnd('/b.jsonl'))
  assert.ok(!background.writes.includes('visibleState'))
})

test('a tool approval publishes only once the trusted overlay releases it', () => {
  const h = harness()
  handleToolApprovalRequest(h.deps, approval())
  assert.equal(h.overlays.length, 1)
  assert.equal(h.overlays[0].kind, 'approval')
  assert.equal(h.writes.length, 0)

  h.overlays[0].publish()
  const key = sessionStateKeyFromToolApproval(approval(), 3)
  assert.ok(key)
  assert.equal(pendingApprovalsBySession.get(key)?.requestId, 'approval-1')
  assert.equal(h.state.pendingApproval?.requestId, 'approval-1')
  assert.equal(sessionRuntimeStates.get(key)?.status, 'needs_approval')
  assert.ok(h.writes.includes('scheduleRefresh'))
  assert.ok(h.writes.includes('projectKey'))
})

test('an approval for a background session is stored without becoming the visible prompt', () => {
  const h = harness()
  handleToolApprovalRequest(h.deps, approval({ sessionId: 'phi-b', sessionPath: '/b.jsonl' }))
  h.overlays[0].publish()
  assert.equal(h.state.pendingApproval, null)
  assert.equal(pendingApprovalsBySession.size, 1)
  assert.equal([...pendingApprovalsBySession.values()][0].requestId, 'approval-1')
})

test('cancelling one approval removes only that request and clears the visible prompt if it matches', () => {
  const h = harness()
  handleToolApprovalRequest(h.deps, approval())
  h.overlays[0].publish()
  const key = sessionStateKeyFromToolApproval(approval(), 3)
  assert.ok(key)

  handleToolApprovalCancelled(h.deps, 'approval-1')
  assert.equal(pendingApprovalsBySession.size, 0)
  assert.equal(h.state.pendingApproval, null)
  assert.deepEqual(h.cancels, [['approval', 'approval-1']])
  assert.ok(!pendingApprovalsBySession.has(key))
})

test('parallel approvals in one session are shown one after another', () => {
  const h = harness()
  handleToolApprovalRequest(h.deps, approval())
  handleToolApprovalRequest(h.deps, approval({ requestId: 'approval-2', summary: 'du /data2' }))
  h.overlays[0].publish()
  h.overlays[1].publish()
  const key = sessionStateKeyFromToolApproval(approval(), 3)
  assert.ok(key)
  assert.equal(h.state.pendingApproval?.requestId, 'approval-1', 'the first stays on screen')

  // Answering goes through the store; the bridge sees the same removal.
  removePendingApproval('approval-1')
  assert.equal(
    pendingApprovalsBySession.get(key)?.requestId,
    'approval-2',
    'the next takes its place'
  )

  handleToolApprovalCancelled(h.deps, 'approval-1')
  handleToolApprovalCancelled(h.deps, 'approval-2')
  assert.ok(!pendingApprovalsBySession.has(key))
})

test('cancelling the shown approval reveals the one queued behind it', () => {
  const h = harness()
  handleToolApprovalRequest(h.deps, approval())
  handleToolApprovalRequest(h.deps, approval({ requestId: 'approval-2' }))
  h.overlays[0].publish()
  h.overlays[1].publish()

  handleToolApprovalCancelled(h.deps, 'approval-1')
  assert.equal(h.state.pendingApproval?.requestId, 'approval-2')
})

test('cancelling without a request id clears every pending approval', () => {
  const h = harness()
  handleToolApprovalRequest(h.deps, approval())
  h.overlays[0].publish()
  handleToolApprovalRequest(h.deps, approval({ requestId: 'approval-2', sessionId: 'phi-b' }))
  h.overlays[1].publish()
  assert.equal(pendingApprovalsBySession.size, 2)

  handleToolApprovalCancelled(h.deps)
  assert.equal(pendingApprovalsBySession.size, 0)
  assert.equal(h.state.pendingApproval, null)
})

test('a user interaction becomes needs_input for the active session', () => {
  const h = harness()
  const request: AgentUserInteractionRequest = {
    requestId: 'interaction-1',
    questions: [{ question: 'Continue?', header: 'Confirm', options: [] }],
    sessionId: 'phi-a',
    sessionPath: '/a.jsonl',
    cwd: '/project',
    sessionGeneration: 3,
    runId: 'run-a'
  }
  handleAgentUserInteractionRequest(h.deps, request)
  h.overlays[0].publish()
  assert.ok(h.writes.includes('pendingInteraction'))
  assert.equal(sessionRuntimeStates.get(activeKey)?.status, 'needs_input')
})

test('a cancelled user interaction clears the pending prompt and schedules a refresh', () => {
  const h = harness()
  handleAgentUserInteractionCancelled(h.deps)
  assert.deepEqual(h.cancels, [['interaction', undefined]])
  assert.ok(h.writes.includes('pendingInteraction'))
  assert.ok(h.writes.includes('scheduleRefresh'))
})

test('an auth prompt publishes through the overlay and reveals settings without the browser gate', () => {
  const h = harness()
  handleAuthInteraction(h.deps, {
    type: 'prompt',
    attemptId: 'login',
    requestId: 'auth-1',
    providerId: 'openai',
    prompt: { type: 'secret', message: 'Key' }
  })
  assert.equal(h.overlays[0].kind, 'auth')
  assert.deepEqual(h.writes, [])
  h.overlays[0].publish()
  assert.equal(h.settingsOpened(), 1)
  void h.overlays[0].onCancel?.()
})

test('a metadata-only session change applies the session without refreshing projects', () => {
  const session = currentSession()
  const conversations = harness()
  handleSessionChanged(conversations.deps, session)
  assert.equal(conversations.appliedSession(), session)
  assert.ok(conversations.writes.includes('projectKey'))
  assert.equal(conversations.refreshProjects(), 0)

  const projects = harness({}, false)
  projects.deps.workspaceSidebarMode = 'projects'
  handleSessionChanged(projects.deps, session)
  assert.equal(projects.appliedSession(), session)
  assert.ok(projects.writes.includes('projectKey'))
  assert.equal(projects.refreshProjects(), 0)
})

test('a notification for another session neither applies it nor refreshes projects', () => {
  const h = harness({}, false)
  h.deps.workspaceSidebarMode = 'projects'
  handleSessionChanged(h.deps, currentSession({ path: '/b.jsonl', phiSessionId: 'phi-b' }))
  assert.equal(h.appliedSession(), null)
  assert.equal(h.refreshProjects(), 0)
})

test('a run finishing refreshes project Git status', () => {
  const h = harness()
  h.deps.projectsRef.current = [
    { workingDirectory: '/project', location: { kind: 'local' } } as Project
  ]
  handleAgentEvent(h.deps, runStarted({ type: 'run_completed' }))
  assert.equal(h.refreshProjects(), 1)
})

test('a delayed session notification cannot navigate away from the selected conversation', () => {
  const h = harness()
  handleSessionChanged(h.deps, {
    path: '/previous.jsonl',
    phiSessionId: 'phi-previous'
  } as CurrentSession)
  assert.equal(h.appliedSession(), null)
  assert.deepEqual(h.writes, [])
})

test('child-run tabs receive live background progress only from their owning session', () => {
  const h = harness()
  const backgroundKey = sessionStateKey({
    phiSessionId: 'phi-b',
    path: '/b.jsonl',
    cwd: '/b',
    sessionGeneration: 4
  })
  let notifications = 0
  const stopListening = subscribeSessionEvents(backgroundKey, () => {
    notifications += 1
  })
  const event = (data: Partial<AgentEventSummary>): AgentEventSummary => ({
    type: 'agent_execution_started',
    phiSessionId: 'phi-b',
    sessionPath: '/b.jsonl',
    cwd: '/b',
    sessionGeneration: 4,
    toolCallId: 'child-call',
    agentName: 'Reviewer',
    ...data
  })
  try {
    handleAgentEvent(h.deps, event({ task: 'Inspect files', args: { task: 'Inspect files' } }))
    handleAgentEvent(
      h.deps,
      event({
        type: 'agent_execution_step',
        step: { id: 'read-1', toolName: 'read', status: 'running', args: { path: 'file.txt' } }
      })
    )
    handleAgentEvent(h.deps, event({ type: 'agent_execution_completed', finalReport: 'Verified' }))
    assert.equal(notifications, 3)
    const item = sessionAgentEventStates.get(backgroundKey)?.messages[0]
    assert.equal(item?.role, 'agent_execution')
    if (item?.role !== 'agent_execution') assert.fail('expected a child run')
    assert.equal(item.status, 'done')
    assert.equal(item.steps.length, 1)
    assert.equal(item.finalReport, 'Verified')
    assert.equal(h.state.agentEventState.messages.length, 0, 'parent selection is unchanged')
    handleAgentEvent(h.deps, runStarted())
    assert.equal(notifications, 3, 'unrelated session events do not notify this tab')
  } finally {
    stopListening()
  }
  handleAgentEvent(h.deps, event({ type: 'agent_execution_steered', text: 'extra' }))
  assert.equal(notifications, 3, 'closing the view unsubscribes without stopping the run')
})
