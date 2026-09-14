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

test('chat interactions are wired to acknowledge the active session marker', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  const chatViewSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/components/ChatView.tsx'),
    'utf8'
  )

  assert.match(appSource, /acknowledgeActiveSessionInteraction/)
  assert.match(appSource, /onAcknowledgeActiveSession=\{acknowledgeActiveSessionInteraction\}/)
  assert.match(chatViewSource, /onAcknowledgeActiveSession\?: \(\) => void/)
  assert.match(chatViewSource, /onPointerDownCapture=\{onAcknowledgeActiveSession\}/)
  assert.match(chatViewSource, /onFocusCapture=\{onAcknowledgeActiveSession\}/)
})
