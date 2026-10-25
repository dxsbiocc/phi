import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { JsonValue, KernelRequestFrame } from '../src/shared/kernel-protocol'
import type { KernelCallContext, KernelMethodHandler } from '../src/kernel/protocol'
import { createWorkerKernelAdapter } from '../src/kernel/worker'
import { requestHost, sendEvent, setWorkerOutbound } from '../src/main/agent/engine/in-process/ipc'
import { pendingAuthPrompts, pendingToolApprovals } from '../src/main/agent/engine/in-process/state'

const context: KernelCallContext = {
  controllerGeneration: 1,
  connectionId: 'test',
  trusted: true
}

function request(method: string, sessionId?: string): KernelRequestFrame {
  return {
    kind: 'request',
    id: `${method}-request`,
    method,
    params: {},
    generation: 1,
    ...(sessionId ? { sessionId } : {})
  }
}

function handler(
  handlers: ReturnType<typeof createWorkerKernelAdapter>['handlers'],
  method: keyof typeof handlers
): KernelMethodHandler {
  const value = handlers[method]
  assert.equal(typeof value, 'function')
  return value as KernelMethodHandler
}

test('worker adapter creates kernel-owned sessions with trusted entry values', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'phi-kernel-worker-'))
  const calls: Array<{ method: string; params: unknown }> = []
  const adapter = createWorkerKernelAdapter({
    agentDir: '/trusted/agent',
    callWorker: async (method, params) => {
      calls.push({ method, params })
      return { sessionId: 'ignored-worker-id', state: {} }
    }
  })
  try {
    const result = await handler(adapter.handlers, 'session.create')(
      {
        cwd,
        model: { provider: 'provider', id: 'model' },
        sessionManager: { kind: 'memory' }
      },
      context,
      request('session.create')
    )
    assert.equal(typeof (result as { sessionId?: unknown }).sessionId, 'string')
    const params = calls[0].params as Record<string, unknown>
    assert.equal(calls[0].method, 'session.create')
    assert.equal(params.agentDir, '/trusted/agent')
    assert.equal(params.cwd, cwd)
    assert.equal(params.sessionId, (result as { sessionId: string }).sessionId)
    assert.deepEqual(params.sessionManager, { kind: 'memory', cwd })

    await assert.rejects(
      async () =>
        handler(adapter.handlers, 'session.create')(
          {
            cwd: 'relative',
            model: { provider: 'provider', id: 'model' },
            sessionManager: { kind: 'memory' }
          },
          context,
          request('session.create')
        ),
      (error: { code?: string }) => error.code === 'INVALID_PARAMS'
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('worker adapter returns prompt acceptance immediately and maps abort to cancelled', async () => {
  let finishPrompt!: () => void
  const promptFinished = new Promise<void>((resolve) => {
    finishPrompt = resolve
  })
  const calls: string[] = []
  const adapter = createWorkerKernelAdapter({
    agentDir: '/trusted/agent',
    callWorker: async (method) => {
      calls.push(method)
      if (method === 'session.prompt') await promptFinished
      return undefined
    }
  })

  const started = await handler(adapter.handlers, 'session.prompt')(
    { text: 'hello' },
    context,
    request('session.prompt', 'session-1')
  )
  assert.equal(calls[0], 'session.prompt')
  assert.equal(typeof (started as { runId?: unknown }).runId, 'string')

  const aborted = await handler(adapter.handlers, 'session.abort')(
    {},
    context,
    request('session.abort', 'session-1')
  )
  assert.deepEqual(aborted, { cancelled: true })
  finishPrompt()
  assert.equal(
    await (started as unknown as { completion: PromiseLike<string> }).completion,
    'cancelled'
  )
})

test('worker adapter projects snapshots and atomically rejects concurrent duplicate approvals', async () => {
  let approvalPending = true
  let approvalCalls = 0
  let releaseCalls!: () => void
  const bothCallsEntered = new Promise<void>((resolve) => {
    releaseCalls = resolve
  })
  const calls: Array<{ method: string; params: unknown }> = []
  const adapter = createWorkerKernelAdapter({
    agentDir: '/trusted/agent',
    callWorker: async (method, params) => {
      calls.push({ method, params })
      if (method !== 'toolApproval.result') return undefined
      approvalCalls += 1
      if (approvalCalls === 2) releaseCalls()
      await bothCallsEntered
      if (!approvalPending) return false
      approvalPending = false
      return true
    },
    readSessionState: async () => ({
      sessionFile: '/private/history.jsonl',
      messages: [{ role: 'assistant', content: 'hello' }],
      model: { provider: 'provider', id: 'model', name: 'Model', reasoning: false },
      thinkingLevel: 'high',
      cwd: '/project'
    })
  })

  const snapshot = await handler(adapter.handlers, 'session.snapshot')(
    {},
    context,
    request('session.snapshot', 'session-1')
  )
  assert.deepEqual(snapshot, {
    sessionId: 'session-1',
    messages: [{ role: 'assistant', content: 'hello' }],
    model: { provider: 'provider', id: 'model' },
    thinkingLevel: 'high',
    cwd: '/project'
  })

  pendingToolApprovals.set('approval-1', () => undefined)
  const responses = await Promise.allSettled([
    handler(adapter.handlers, 'approval.respond')(
      { approvalId: 'approval-1', decision: 'denied' },
      context,
      request('approval.respond')
    ),
    handler(adapter.handlers, 'approval.respond')(
      { approvalId: 'approval-1', decision: 'approved' },
      context,
      request('approval.respond')
    )
  ])
  pendingToolApprovals.delete('approval-1')
  assert.deepEqual(
    responses.map((response) => response.status),
    ['fulfilled', 'rejected']
  )
  assert.deepEqual(
    calls.find((call) => call.method === 'toolApproval.result'),
    {
      method: 'toolApproval.result',
      params: {
        requestId: 'approval-1',
        result: { block: true, reason: 'User denied tool execution' }
      }
    }
  )
  const rejected = responses[1]
  assert.equal(rejected.status, 'rejected')
  assert.equal((rejected.reason as { code?: string }).code, 'INVALID_PARAMS')
})

test('worker outbound maps legacy events and host requests onto the protocol core', async () => {
  const events: Array<{ type: string; payload: JsonValue; routing: unknown }> = []
  const host: Array<{ capability: string; params: JsonValue; context: unknown }> = []
  const adapter = createWorkerKernelAdapter({
    agentDir: '/trusted/agent',
    callWorker: async () => undefined
  })
  const unbind = adapter.bind({
    emitEvent(type: string, payload: JsonValue, routing: unknown) {
      events.push({ type, payload, routing })
      return undefined
    },
    async requestHost(capability: string, params: JsonValue, context: unknown) {
      host.push({ capability, params, context })
      return { ok: true }
    }
  } as never)
  try {
    sendEvent('sessionEvent', { type: 'agent_start' }, { sessionId: 'session-1' })
    sendEvent(
      'toolApproval',
      {
        requestId: 'approval-1',
        toolCallId: 'tool-1',
        toolName: 'write',
        input: { path: 'file.txt' }
      },
      { sessionId: 'session-1' }
    )
    assert.deepEqual(
      await requestHost(
        'desktop.example',
        { value: 1 },
        { originSessionId: 'session-1', agentRunId: 'run-1' }
      ),
      { ok: true }
    )

    assert.deepEqual(
      events.map((event) => event.type),
      ['session.event', 'approval.requested']
    )
    assert.deepEqual(host, [
      {
        capability: 'desktop.example',
        params: { value: 1 },
        context: { sessionId: 'session-1', agentRunId: 'run-1' }
      }
    ])
  } finally {
    unbind()
  }
})

test('worker outbound drops notification-only events and rejects unavailable auth prompts', async () => {
  const diagnostics: string[] = []
  const adapter = createWorkerKernelAdapter({
    agentDir: '/trusted/agent',
    callWorker: async () => undefined,
    diagnostic: (message) => diagnostics.push(message)
  })
  const unbind = adapter.bind({
    emitEvent() {
      return undefined
    },
    async requestHost() {
      return null
    }
  } as never)
  let rejectPrompt!: (error: Error) => void
  const prompt = new Promise<string>((_resolve, reject) => {
    rejectPrompt = reject
  })
  pendingAuthPrompts.set('auth-1', { resolve: () => undefined, reject: rejectPrompt })
  try {
    assert.doesNotThrow(() =>
      sendEvent('authPrompt', { providerId: 'test' }, { requestId: 'auth-1' })
    )
    await assert.rejects(prompt, /authentication prompt unavailable in kernel v1/)

    assert.doesNotThrow(() => sendEvent('authNotify', { step: 1 }))
    assert.doesNotThrow(() => sendEvent('authNotify', { step: 2 }))
    assert.doesNotThrow(() => sendEvent('desktopMcpProgress', { progress: 1 }))
    assert.doesNotThrow(() => sendEvent('desktopMcpProgress', { progress: 2 }))
    assert.doesNotThrow(() => sendEvent('sessionState', {}))
    assert.doesNotThrow(() => sendEvent('sessionState', {}))
    assert.deepEqual(
      diagnostics.map(
        (message) => message.match(/authPrompt|authNotify|desktopMcpProgress|sessionState/)?.[0]
      ),
      ['authPrompt', 'authNotify', 'desktopMcpProgress', 'sessionState']
    )
  } finally {
    pendingAuthPrompts.delete('auth-1')
    unbind()
    setWorkerOutbound(undefined)
  }
})
