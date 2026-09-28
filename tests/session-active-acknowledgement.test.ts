import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { createAgentEventReducerState } from '../src/renderer/src/lib/agentEventReducer'
import { idleSessionRuntimeState } from '../src/renderer/src/lib/sessionRuntimeState'
import {
  pendingApprovalsBySession,
  sessionAgentEventStates,
  sessionRuntimeStates,
  sessionStateKey,
  useSessionStore
} from '../src/renderer/src/stores/sessionStore'
import type { RendererApi, SessionRuntimeState, SessionSummary } from '../src/renderer/src/types'

const baseSession: SessionSummary = {
  path: 'session-a',
  id: 'session-a',
  created: '2026-09-14T00:00:00.000Z',
  modified: '2026-09-14T00:00:00.000Z',
  messageCount: 1,
  firstMessage: '完成标记确认',
  status: 'idle',
  unreadKind: null
}

function installRendererApi(api: Partial<RendererApi>): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: api as RendererApi },
    writable: true
  })
}

function resetSessionStore(): void {
  sessionRuntimeStates.clear()
  pendingApprovalsBySession.clear()
  sessionAgentEventStates.clear()
  useSessionStore.setState({
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
    agentEventState: createAgentEventReducerState(),
    pendingApproval: null,
    activeSessionRuntimeState: idleSessionRuntimeState(),
    projectSessionRefreshKey: 0,
    draftInputs: {}
  })
}

beforeEach(() => {
  resetSessionStore()
})

afterEach(() => {
  resetSessionStore()
  Reflect.deleteProperty(globalThis, 'window')
})

test('active session acknowledgement clears terminal unread state without switching sessions', async () => {
  const completedState: SessionRuntimeState = {
    status: 'completed_unread',
    unreadKind: 'completed',
    lastRunOutcome: 'completed',
    lastActivityAt: '2026-09-14T00:01:00.000Z'
  }
  const activeStateKey = sessionStateKey({
    path: baseSession.path,
    phiSessionId: null,
    cwd: '/workspace',
    sessionGeneration: 3
  })
  const calls: string[] = []

  sessionRuntimeStates.set(activeStateKey, completedState)
  useSessionStore.setState({
    sessions: [{ ...baseSession, ...completedState }],
    activeSessionPath: baseSession.path,
    activePhiSessionId: null,
    activeCwd: '/workspace',
    activeSessionGeneration: 3,
    activeAgentEventStateKey: activeStateKey,
    activeSessionRuntimeState: completedState
  })
  installRendererApi({
    acknowledgeSession: async (path) => {
      calls.push(path)
      return {
        ...baseSession,
        status: 'idle',
        unreadKind: null,
        lastRunOutcome: 'completed',
        lastActivityAt: '2026-09-14T00:01:00.000Z'
      }
    }
  })

  assert.equal(await useSessionStore.getState().acknowledgeActiveSession(), true)

  const nextState = useSessionStore.getState()
  assert.deepEqual(calls, [baseSession.path])
  assert.equal(nextState.activeSessionRuntimeState.status, 'idle')
  assert.equal(nextState.activeSessionRuntimeState.unreadKind, null)
  assert.equal(nextState.sessions[0]?.status, 'idle')
  assert.equal(nextState.sessions[0]?.unreadKind, null)
  assert.equal(nextState.projectSessionRefreshKey, 1)
  assert.equal(sessionRuntimeStates.get(activeStateKey)?.unreadKind, null)
})

test('active session acknowledgement does not clear approval attention', async () => {
  const approvalState: SessionRuntimeState = {
    status: 'needs_approval',
    unreadKind: 'approval',
    currentRunId: 'run-approval'
  }
  const calls: string[] = []

  useSessionStore.setState({
    sessions: [{ ...baseSession, ...approvalState }],
    activeSessionPath: baseSession.path,
    activePhiSessionId: null,
    activeCwd: '/workspace',
    activeSessionGeneration: 3,
    activeSessionRuntimeState: approvalState
  })
  installRendererApi({
    acknowledgeSession: async (path) => {
      calls.push(path)
      return null
    }
  })

  assert.equal(await useSessionStore.getState().acknowledgeActiveSession(), false)
  assert.deepEqual(calls, [])
  assert.equal(useSessionStore.getState().activeSessionRuntimeState.unreadKind, 'approval')
})

test('current session keeps visible messages when an existing path gains a Phi id', () => {
  const pathStateKey = sessionStateKey({
    phiSessionId: null,
    path: baseSession.path,
    cwd: '/workspace',
    sessionGeneration: 3
  })
  const phiStateKey = sessionStateKey({
    phiSessionId: 'phi-session-1',
    path: baseSession.path,
    cwd: '/workspace',
    sessionGeneration: 3
  })
  const visibleState = createAgentEventReducerState([
    { id: 'user-local', role: 'user', content: 'hello' }
  ])

  sessionAgentEventStates.set(pathStateKey, visibleState)
  useSessionStore.setState({
    activeSessionPath: baseSession.path,
    activePhiSessionId: null,
    activeCwd: '/workspace',
    activeSessionGeneration: 3,
    activeAgentEventStateKey: pathStateKey,
    activeChatScrollResetKey: pathStateKey,
    agentEventState: visibleState
  })

  useSessionStore.getState().applyCurrentSession({
    path: baseSession.path,
    phiSessionId: 'phi-session-1',
    cwd: '/workspace',
    sessionGeneration: 3,
    permissionMode: 'auto',
    messages: []
  })

  const nextState = useSessionStore.getState()
  assert.equal(nextState.activeAgentEventStateKey, phiStateKey)
  assert.equal(nextState.activeChatScrollResetKey, pathStateKey)
  assert.deepEqual(
    nextState.agentEventState.messages.map((message) => message.id),
    ['user-local']
  )
  assert.deepEqual(
    sessionAgentEventStates.get(phiStateKey)?.messages.map((message) => message.id),
    ['user-local']
  )
})

test('current session keeps visible messages and scroll key when a fresh chat materializes', () => {
  const freshStateKey = sessionStateKey({
    phiSessionId: null,
    path: null,
    cwd: '/workspace',
    sessionGeneration: 4
  })
  const materializedStateKey = sessionStateKey({
    phiSessionId: 'phi-session-2',
    path: 'phi-session:phi-session-2',
    cwd: '/workspace',
    sessionGeneration: 4
  })
  const visibleState = createAgentEventReducerState([
    { id: 'user-local', role: 'user', content: 'first message' }
  ])

  sessionAgentEventStates.set(freshStateKey, visibleState)
  useSessionStore.setState({
    activeSessionPath: null,
    activePhiSessionId: null,
    activeCwd: '/workspace',
    activeSessionGeneration: 4,
    activeAgentEventStateKey: freshStateKey,
    activeChatScrollResetKey: freshStateKey,
    agentEventState: visibleState
  })

  useSessionStore.getState().applyCurrentSession({
    path: 'phi-session:phi-session-2',
    phiSessionId: 'phi-session-2',
    cwd: '/workspace',
    sessionGeneration: 4,
    permissionMode: 'auto',
    messages: []
  })

  const nextState = useSessionStore.getState()
  assert.equal(nextState.activeAgentEventStateKey, materializedStateKey)
  assert.equal(nextState.activeChatScrollResetKey, freshStateKey)
  assert.deepEqual(
    nextState.agentEventState.messages.map((message) => message.id),
    ['user-local']
  )
  assert.deepEqual(
    sessionAgentEventStates.get(materializedStateKey)?.messages.map((message) => message.id),
    ['user-local']
  )
})

test('chat interactions are wired to acknowledge the active session marker', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  const chatViewSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/chat/ChatView.tsx'),
    'utf8'
  )

  assert.match(appSource, /acknowledgeActiveSessionInteraction/)
  assert.match(appSource, /onAcknowledgeActiveSession=\{acknowledgeActiveSessionInteraction\}/)
  assert.match(chatViewSource, /onAcknowledgeActiveSession\?: \(\) => void/)
  assert.match(chatViewSource, /onPointerDownCapture=\{onAcknowledgeActiveSession\}/)
  assert.match(chatViewSource, /onFocusCapture=\{onAcknowledgeActiveSession\}/)
})
