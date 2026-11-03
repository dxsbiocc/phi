import assert from 'node:assert/strict'
import test from 'node:test'

import { registerWorkModeSelectionHost } from '../src/main/agent/plan/work-mode-selection-host'

test('automatic work mode selection writes and broadcasts its timeline event', async () => {
  let handler: ((params: unknown, context: { originSessionId?: string }) => unknown) | undefined
  const appended: Array<{ sessionId: string; event: Record<string, unknown> }> = []
  const broadcasts: unknown[] = []
  let notifications = 0
  registerWorkModeSelectionHost({
    host: {
      register: (_method, next) => {
        handler = next as typeof handler
        return () => undefined
      }
    },
    findActivePromptRunByRuntimeSessionId: () => ({
      phiSessionId: 'phi-1',
      runId: 'run-1',
      cancelled: false
    }),
    findPhiSessionById: () => ({ workMode: 'auto' }),
    appendSessionEvent: (sessionId, event) => {
      appended.push({ sessionId, event })
      return { ...event, eventId: 'event-1' }
    },
    broadcastSessionTimelineEvent: (sessionId, event) => broadcasts.push({ sessionId, event }),
    notifySessionChanged: () => notifications++
  })
  assert.ok(handler)
  await handler({ execute: true, reason: '  可拆分为独立任务  ' }, { originSessionId: 'runtime-1' })
  assert.deepEqual(appended, [
    {
      sessionId: 'phi-1',
      event: {
        type: 'work_mode_selected',
        runId: 'run-1',
        execute: true,
        reason: '可拆分为独立任务'
      }
    }
  ])
  assert.deepEqual(broadcasts, [
    {
      sessionId: 'phi-1',
      event: { ...appended[0]!.event, eventId: 'event-1' }
    }
  ])
  assert.equal(notifications, 1)
})

test('work mode selection host rejects stale, non-auto, remote, and invalid requests', async () => {
  let handler: ((params: unknown, context: { originSessionId?: string }) => unknown) | undefined
  let run: { phiSessionId: string; runId: string; cancelled: boolean } | null = {
    phiSessionId: 'phi-1',
    runId: 'run-1',
    cancelled: false
  }
  let manifest: { workMode?: string; projectLocation?: { kind: string } } = { workMode: 'auto' }
  registerWorkModeSelectionHost({
    host: {
      register: (_method, next) => {
        handler = next as typeof handler
        return () => undefined
      }
    },
    findActivePromptRunByRuntimeSessionId: () => run,
    findPhiSessionById: () => manifest,
    appendSessionEvent: () => ({}),
    broadcastSessionTimelineEvent: () => undefined,
    notifySessionChanged: () => undefined
  })
  assert.ok(handler)
  const call = (params: unknown, originSessionId = 'runtime-1'): Promise<unknown> =>
    Promise.resolve().then(() => handler!(params, { originSessionId }))
  await assert.rejects(call({ execute: true, reason: '' }), /Invalid/)
  run = null
  await assert.rejects(call({ execute: true, reason: 'reason' }), /no longer active/)
  run = { phiSessionId: 'phi-1', runId: 'run-1', cancelled: false }
  manifest = { workMode: 'direct' }
  await assert.rejects(call({ execute: false, reason: 'reason' }), /not active/)
  manifest = { workMode: 'auto', projectLocation: { kind: 'ssh' } }
  await assert.rejects(call({ execute: false, reason: 'reason' }), /not active/)
})

test('SSH automatic selection requires a trusted live run and call origin', async () => {
  let handler: import('../src/main/agent/engine/types').PhiHostRequestHandler | undefined
  let appended = 0
  const persisted: unknown[] = []
  registerWorkModeSelectionHost({
    host: {
      register: (_method, next) => {
        handler = next
        return () => undefined
      }
    },
    findActivePromptRunByRuntimeSessionId: () => ({
      phiSessionId: 'phi-1',
      runId: 'run-1',
      sessionGeneration: 3,
      cancelled: false
    }),
    findPhiSessionById: () => ({ workMode: 'auto', projectLocation: { kind: 'ssh' } }),
    persistPendingRemoteAutoPlan: (marker) => persisted.push(marker),
    appendSessionEvent: (_id, event) => {
      appended++
      return event
    },
    broadcastSessionTimelineEvent: () => undefined,
    notifySessionChanged: () => undefined
  })
  assert.ok(handler)
  const request = { execute: true, reason: 'Independent steps' }
  const origin = { originSessionId: 'runtime-1', agentRunId: 'run-1', toolCallId: 'call-1' }
  await assert.rejects(
    Promise.resolve().then(() => handler!(request, origin)),
    /not active/
  )
  await assert.rejects(
    Promise.resolve().then(() =>
      handler!(request, { ...origin, agentRunId: 'other', remoteOriginAuthenticated: true })
    ),
    /not active/
  )
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(
    Promise.resolve().then(() =>
      handler!(request, { ...origin, signal: cancelled.signal, remoteOriginAuthenticated: true })
    ),
    /no longer active/
  )
  assert.deepEqual(await handler(request, { ...origin, remoteOriginAuthenticated: true }), {
    ok: true,
    mode: 'plan_execute',
    reason: 'Independent steps'
  })
  assert.equal(appended, 1)
  assert.deepEqual(persisted, [
    {
      version: 1,
      phiSessionId: 'phi-1',
      runId: 'run-1',
      sessionGeneration: 3,
      mode: 'plan_execute'
    }
  ])
})

test('an SSH kernel session selects a plan like a local one, without the RPC pending marker', async () => {
  let handler: import('../src/main/agent/engine/types').PhiHostRequestHandler | undefined
  let appended = 0
  const persisted: unknown[] = []
  registerWorkModeSelectionHost({
    host: {
      register: (_method, next) => {
        handler = next
        return () => undefined
      }
    },
    findActivePromptRunByRuntimeSessionId: () => ({
      phiSessionId: 'phi-1',
      runId: 'run-1',
      sessionGeneration: 3,
      cancelled: false
    }),
    findPhiSessionById: () => ({ workMode: 'auto', projectLocation: { kind: 'ssh' } }),
    persistPendingRemoteAutoPlan: (marker) => persisted.push(marker),
    appendSessionEvent: (_id, event) => {
      appended++
      return event
    },
    broadcastSessionTimelineEvent: () => undefined,
    notifySessionChanged: () => undefined
  })
  assert.ok(handler)
  assert.deepEqual(
    await handler(
      { execute: false, reason: 'Needs a reviewed plan' },
      { originSessionId: 'runtime-1', kernelOrigin: true }
    ),
    { ok: true, mode: 'plan', reason: 'Needs a reviewed plan' }
  )
  assert.equal(appended, 1)
  assert.deepEqual(persisted, [])
})

test('SSH selection fails closed if pending plan persistence fails', async () => {
  let handler: import('../src/main/agent/engine/types').PhiHostRequestHandler | undefined
  let appended = 0
  registerWorkModeSelectionHost({
    host: {
      register: (_method, next) => {
        handler = next
        return () => undefined
      }
    },
    findActivePromptRunByRuntimeSessionId: () => ({
      phiSessionId: 'phi-1',
      runId: 'run-1',
      sessionGeneration: 3,
      cancelled: false
    }),
    findPhiSessionById: () => ({ workMode: 'auto', projectLocation: { kind: 'ssh' } }),
    persistPendingRemoteAutoPlan: () => {
      throw new Error('disk unavailable')
    },
    appendSessionEvent: () => {
      appended++
      return {}
    },
    broadcastSessionTimelineEvent: () => undefined,
    notifySessionChanged: () => undefined
  })
  assert.ok(handler)
  await assert.rejects(
    Promise.resolve().then(() =>
      handler!(
        { execute: false, reason: 'Need a plan' },
        {
          originSessionId: 'runtime-1',
          agentRunId: 'run-1',
          toolCallId: 'call-1',
          remoteOriginAuthenticated: true
        }
      )
    ),
    /disk unavailable/
  )
  assert.equal(appended, 0)
})
