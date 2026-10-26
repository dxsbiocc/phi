import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { JsonValue, KernelRequestFrame } from '../src/shared/kernel-protocol'
import type { KernelCallContext, KernelMethodHandler } from '../src/kernel/protocol'
import { createWorkerKernelAdapter } from '../src/kernel/worker'
import {
  readModelAccessCatalog,
  requireAvailableModel
} from '../src/kernel/worker/model-access-handlers'
import type { KernelModelAccess } from '../src/kernel/model-access'
import { requestHost, sendEvent, setWorkerOutbound } from '../src/main/agent/engine/in-process/ipc'
import { pendingAuthPrompts, pendingToolApprovals } from '../src/main/agent/engine/in-process/state'

const context: KernelCallContext = {
  controllerGeneration: 1,
  connectionId: 'test',
  trusted: true
}

const acquireTestGuard = (): { acquired: true; release(): void } => ({
  acquired: true,
  release: () => undefined
})

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

test('worker adapter owns model, thinking, context and compaction controls during a run', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'phi-kernel-worker-model-controls-'))
  const calls: Array<{ method: string; params: unknown }> = []
  let releasePrompt!: () => void
  const promptBlocked = new Promise<void>((resolve) => {
    releasePrompt = resolve
  })
  let state = {
    messages: [] as JsonValue[],
    model: { provider: 'fixture', id: 'model-a' },
    thinkingLevel: 'medium',
    cwd
  }
  const models = [
    {
      provider: 'fixture',
      id: 'model-a',
      name: 'Model A',
      reasoning: true,
      input: ['text'] as Array<'text' | 'image'>,
      contextWindow: 32_000,
      maxTokens: 4_000
    },
    {
      provider: 'fixture',
      id: 'model-b',
      name: 'Model B',
      reasoning: true,
      input: ['text'] as Array<'text' | 'image'>,
      contextWindow: 32_000,
      maxTokens: 4_000
    }
  ]
  const adapter = createWorkerKernelAdapter({
    agentDir: '/trusted/agent',
    modelAccess: {
      authStorage: { credentials: { revalidate: async () => undefined } },
      modelRegistry: {},
      catalog: () => models,
      status: () => [{ provider: 'fixture', status: 'available' as const }],
      onChange: () => () => undefined,
      configure: () => undefined,
      close: () => undefined
    } as unknown as KernelModelAccess,
    callWorker: async (method, params) => {
      calls.push({ method, params })
      if (method === 'session.prompt') await promptBlocked
      if (method === 'session.setModel') {
        state = { ...state, model: (params as { model: typeof state.model }).model }
      }
      if (method === 'session.setThinkingLevel') {
        state = {
          ...state,
          thinkingLevel: (params as { level: string }).level
        }
      }
      if (method === 'session.contextUsage') {
        return { tokens: 100, contextWindow: 1_000, percent: 10 }
      }
      if (method === 'session.compact') {
        return { summary: { summary: 'compact', tokensBefore: 100, tokensAfter: 10 } }
      }
      if (method === 'session.getAutoCompaction') {
        return { enabled: true, thresholdPercent: 80, thresholdTokens: 800 }
      }
      if (method === 'session.setAutoCompaction') {
        return { enabled: false, thresholdPercent: 90, thresholdTokens: 900 }
      }
      return undefined
    },
    readSessionState: () => state
  })

  try {
    const created = (await handler(adapter.handlers, 'session.create')(
      {
        cwd,
        model: { provider: 'fixture', id: 'model-a' },
        sessionManager: { kind: 'memory' }
      },
      context,
      request('session.create')
    )) as { sessionId: string }
    const sessionId = created.sessionId
    const run = (await handler(adapter.handlers, 'session.prompt')(
      { text: 'hold', modelSelection: 'automatic', synthetic: false, userInitiated: true },
      context,
      request('session.prompt', sessionId)
    )) as unknown as { completion: PromiseLike<string> }
    assert.deepEqual((calls.at(-1)?.params as { options?: unknown }).options, {
      modelSelection: 'automatic',
      synthetic: false,
      userInitiated: true
    })

    const selected = await handler(adapter.handlers, 'session.setModel')(
      { model: { provider: 'fixture', id: 'model-b' } },
      context,
      request('session.setModel', sessionId)
    )
    assert.deepEqual((selected as { model: unknown }).model, {
      provider: 'fixture',
      id: 'model-b'
    })
    const thinking = await handler(adapter.handlers, 'session.setThinkingLevel')(
      { level: 'max' },
      context,
      request('session.setThinkingLevel', sessionId)
    )
    assert.equal((thinking as { thinkingLevel: string }).thinkingLevel, 'max')
    await assert.rejects(
      async () =>
        handler(adapter.handlers, 'session.setModel')(
          { model: { provider: 'fixture', id: 'missing' } },
          context,
          request('session.setModel', sessionId)
        ),
      (error: { code?: string }) => error.code === 'MODEL_UNAVAILABLE'
    )
    assert.deepEqual(state.model, { provider: 'fixture', id: 'model-b' })
    assert.deepEqual(
      await handler(adapter.handlers, 'session.contextUsage')(
        {},
        context,
        request('session.contextUsage', sessionId)
      ),
      { tokens: 100, contextWindow: 1_000, percent: 10 }
    )
    const compacted = await handler(adapter.handlers, 'session.compact')(
      {},
      context,
      request('session.compact', sessionId)
    )
    assert.deepEqual((compacted as { summary: unknown }).summary, {
      summary: 'compact',
      tokensBefore: 100,
      tokensAfter: 10
    })
    assert.deepEqual(
      await handler(adapter.handlers, 'session.getAutoCompaction')(
        {},
        context,
        request('session.getAutoCompaction', sessionId)
      ),
      { enabled: true, thresholdPercent: 80, thresholdTokens: 800 }
    )
    assert.deepEqual(
      await handler(adapter.handlers, 'session.setAutoCompaction')(
        { enabled: false, thresholdPercent: 90 },
        context,
        request('session.setAutoCompaction', sessionId)
      ),
      { enabled: false, thresholdPercent: 90, thresholdTokens: 900 }
    )
    releasePrompt()
    assert.equal(await run.completion, 'completed')
    assert.equal(
      calls.some((call) => call.method === 'session.setModel'),
      true,
      'model changes remain accepted while the active OMP turn continues'
    )
  } finally {
    releasePrompt()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('model access keeps broker disconnect reason internal except on auth errors', async () => {
  const models = [
    {
      provider: 'fixture',
      id: 'model-a',
      name: 'Model A',
      reasoning: true,
      input: ['text'] as Array<'text' | 'image'>,
      contextWindow: 32_000,
      maxTokens: 4_000
    }
  ]
  const modelAccess = {
    authStorage: { credentials: { revalidate: async () => undefined } },
    modelRegistry: {},
    catalog: () => models,
    status: () => [
      {
        provider: 'fixture',
        status: 'unauthenticated' as const,
        reason: 'desktop_credential_broker_not_connected' as const
      }
    ],
    onChange: () => () => undefined,
    close: () => undefined
  } as unknown as KernelModelAccess

  assert.deepEqual(readModelAccessCatalog(modelAccess).providers, [
    { provider: 'fixture', status: 'unauthenticated' }
  ])
  await assert.rejects(requireAvailableModel(modelAccess, { provider: 'fixture', id: 'model-a' }), {
    code: 'MODEL_UNAUTHENTICATED',
    message: 'The desktop credential broker is not connected.',
    detail: { reason: 'desktop_credential_broker_not_connected' }
  })
})

test('worker adapter returns prompt acceptance immediately and maps abort to cancelled', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'phi-kernel-worker-prompt-'))
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

  try {
    const created = (await handler(adapter.handlers, 'session.create')(
      {
        cwd,
        model: { provider: 'provider', id: 'model' },
        sessionManager: { kind: 'memory' }
      },
      context,
      request('session.create')
    )) as { sessionId: string }
    const started = await handler(adapter.handlers, 'session.prompt')(
      { text: 'hello' },
      context,
      request('session.prompt', created.sessionId)
    )
    assert.equal(calls.at(-1), 'session.prompt')
    assert.equal(typeof (started as { runId?: unknown }).runId, 'string')

    const aborted = await handler(adapter.handlers, 'session.abort')(
      {},
      context,
      request('session.abort', created.sessionId)
    )
    assert.deepEqual(aborted, { cancelled: true })
    finishPrompt()
    assert.equal(
      await (started as unknown as { completion: PromiseLike<string> }).completion,
      'cancelled'
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('worker adapter projects snapshots and atomically rejects concurrent duplicate approvals', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'phi-kernel-worker-snapshot-'))
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

  const created = (await handler(adapter.handlers, 'session.create')(
    {
      cwd,
      model: { provider: 'provider', id: 'model' },
      sessionManager: { kind: 'memory' }
    },
    context,
    request('session.create')
  )) as { sessionId: string }
  const snapshot = await handler(adapter.handlers, 'session.snapshot')(
    {},
    context,
    request('session.snapshot', created.sessionId)
  )
  assert.deepEqual(snapshot, {
    sessionId: created.sessionId,
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
  rmSync(cwd, { recursive: true, force: true })
})

test('worker adapter persists receipts, rejects durable duplicate keys, and releases locks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-worker-durable-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(cwd)
  let finishPrompt!: () => void
  const promptFinished = new Promise<void>((resolve) => {
    finishPrompt = resolve
  })
  const adapter = createWorkerKernelAdapter({
    agentDir,
    kernelInstanceId: 'kernel-instance-test',
    processStartedAt: 'darwin:test-process',
    acquireSessionLockGuard: acquireTestGuard,
    callWorker: async (method) => {
      if (method === 'session.prompt') await promptFinished
      return undefined
    }
  })
  try {
    const created = (await handler(adapter.handlers, 'session.create')(
      {
        cwd,
        model: { provider: 'provider', id: 'model' },
        sessionManager: { kind: 'persistent' }
      },
      context,
      request('session.create')
    )) as { sessionId: string }
    const directory = join(agentDir, 'phi-kernel', 'sessions', created.sessionId)
    assert.equal(
      JSON.parse(readFileSync(join(directory, 'writer.lock'), 'utf8')).kernelInstanceId,
      'kernel-instance-test'
    )
    const started = (await handler(adapter.handlers, 'session.prompt')(
      { text: 'hello', clientRunKey: 'client-run-1' },
      context,
      request('session.prompt', created.sessionId)
    )) as unknown as { runId: string; completion: PromiseLike<string> }

    const accepted = readFileSync(join(directory, 'runs.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(accepted, [
      {
        runId: started.runId,
        clientRunKey: 'client-run-1',
        state: 'accepted',
        at: accepted[0].at
      }
    ])
    assert.equal(typeof adapter.handlers.promptConflict, 'function')
    assert.deepEqual(
      await adapter.handlers.promptConflict?.(
        created.sessionId,
        { text: 'duplicate', clientRunKey: 'client-run-1' },
        context,
        request('session.prompt', created.sessionId)
      ),
      { runId: started.runId, status: 'running' }
    )
    assert.equal(
      await adapter.handlers.promptConflict?.(
        created.sessionId,
        { text: 'different', clientRunKey: 'client-run-2' },
        context,
        request('session.prompt', created.sessionId)
      ),
      undefined
    )
    await assert.rejects(
      async () =>
        handler(adapter.handlers, 'session.prompt')(
          { text: 'duplicate', clientRunKey: 'client-run-1' },
          context,
          request('session.prompt', created.sessionId)
        ),
      (error: { code?: string; detail?: unknown }) =>
        error.code === 'DUPLICATE_REQUEST' &&
        (error.detail as { runId?: string; status?: string }).runId === started.runId &&
        (error.detail as { status?: string }).status === 'running'
    )

    finishPrompt()
    assert.equal(await started.completion, 'completed')
    const receipts = readFileSync(join(directory, 'runs.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(receipts.length, 2)
    assert.deepEqual(receipts[1], {
      runId: started.runId,
      state: 'terminal',
      status: 'completed',
      at: receipts[1].at
    })
    const manifest = JSON.parse(readFileSync(join(directory, 'session.json'), 'utf8'))
    assert.deepEqual(manifest.lastRun, { runId: started.runId, status: 'completed' })
    assert.equal(statSync(directory).mode & 0o777, 0o700)
    assert.equal(statSync(join(directory, 'session.json')).mode & 0o777, 0o600)
    assert.equal(statSync(join(directory, 'runs.jsonl')).mode & 0o777, 0o600)

    await handler(adapter.handlers, 'session.close')(
      {},
      context,
      request('session.close', created.sessionId)
    )
    assert.equal(existsSync(join(directory, 'writer.lock')), false)
    assert.equal(existsSync(join(directory, 'session.json')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('worker adapter preserves lifecycle denial reasons without changing user denial wording', async () => {
  const calls: Array<{ method: string; params: unknown }> = []
  const adapter = createWorkerKernelAdapter({
    agentDir: '/trusted/agent',
    callWorker: async (method, params) => {
      calls.push({ method, params })
      return true
    }
  })

  await handler(adapter.handlers, 'approval.respond')(
    {
      approvalId: 'approval-lifecycle',
      decision: 'denied',
      reason: 'client did not return'
    },
    context,
    request('approval.respond')
  )
  await handler(adapter.handlers, 'approval.respond')(
    { approvalId: 'approval-user', decision: 'denied' },
    context,
    request('approval.respond')
  )

  assert.deepEqual(calls, [
    {
      method: 'toolApproval.result',
      params: {
        requestId: 'approval-lifecycle',
        result: { block: true, reason: 'client did not return' }
      }
    },
    {
      method: 'toolApproval.result',
      params: {
        requestId: 'approval-user',
        result: { block: true, reason: 'User denied tool execution' }
      }
    }
  ])
})

test('worker adapter recovers one UNKNOWN receipt and accepts a later run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-worker-recovery-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(cwd)
  const never = new Promise<void>(() => undefined)
  const first = createWorkerKernelAdapter({
    agentDir,
    processStartedAt: 'darwin:test-process',
    acquireSessionLockGuard: acquireTestGuard,
    callWorker: async (method) => {
      if (method === 'session.prompt') await never
      return undefined
    }
  })
  const unbind = first.bind({} as never)
  try {
    const created = (await handler(first.handlers, 'session.create')(
      {
        cwd,
        model: { provider: 'provider', id: 'model' },
        sessionManager: { kind: 'persistent' }
      },
      context,
      request('session.create')
    )) as { sessionId: string }
    const started = (await handler(first.handlers, 'session.prompt')(
      { text: 'interrupted', clientRunKey: 'interrupted-key' },
      context,
      request('session.prompt', created.sessionId)
    )) as unknown as { runId: string }
    unbind()

    let opens = 0
    const second = createWorkerKernelAdapter({
      agentDir,
      processStartedAt: 'darwin:test-process',
      acquireSessionLockGuard: acquireTestGuard,
      callWorker: async (method) => {
        if (method === 'session.create') opens += 1
        return undefined
      },
      readSessionState: async () => ({ cwd, messages: [] })
    })
    await handler(second.handlers, 'session.open')(
      { sessionId: created.sessionId },
      context,
      request('session.open')
    )
    await handler(second.handlers, 'session.open')(
      { sessionId: created.sessionId },
      context,
      request('session.open')
    )
    assert.equal(opens, 1)
    const snapshot = (await handler(second.handlers, 'session.snapshot')(
      {},
      context,
      request('session.snapshot', created.sessionId)
    )) as Record<string, unknown>
    assert.deepEqual(snapshot.lastRun, { runId: started.runId, status: 'unknown' })

    const receiptsPath = join(agentDir, 'phi-kernel', 'sessions', created.sessionId, 'runs.jsonl')
    const receipts = readFileSync(receiptsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(receipts.filter((receipt) => receipt.status === 'unknown').length, 1)
    assert.equal(receipts.at(-1).reason, 'kernel exited before completion')

    await assert.rejects(
      async () =>
        handler(second.handlers, 'session.prompt')(
          { text: 'duplicate', clientRunKey: 'interrupted-key' },
          context,
          request('session.prompt', created.sessionId)
        ),
      (error: { code?: string; detail?: unknown }) =>
        error.code === 'DUPLICATE_REQUEST' &&
        (error.detail as { status?: string }).status === 'unknown'
    )
    const next = (await handler(second.handlers, 'session.prompt')(
      { text: 'new run', clientRunKey: 'new-key' },
      context,
      request('session.prompt', created.sessionId)
    )) as unknown as { completion: PromiseLike<string> }
    assert.equal(await next.completion, 'completed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
