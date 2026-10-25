import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { KernelRequestFrame } from '../src/shared/kernel-protocol'
import type { KernelCallContext, KernelMethodHandler } from '../src/kernel/protocol'
import { createWorkerKernelAdapter } from '../src/kernel/worker'

const context: KernelCallContext = {
  controllerGeneration: 1,
  connectionId: 'test',
  trusted: true
}

const lifecycleContext: KernelCallContext = {
  ...context,
  connectionId: 'kernel-lifecycle'
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

test('lifecycle abort persists a terminal receipt before prompt completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-worker-lifecycle-abort-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd)
  const never = new Promise<void>(() => undefined)
  const adapter = createWorkerKernelAdapter({
    agentDir,
    processStartedAt: 'darwin:test-process',
    acquireSessionLockGuard: acquireTestGuard,
    callWorker: async (method) => {
      if (method === 'session.prompt') await never
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
    const started = (await handler(adapter.handlers, 'session.prompt')(
      { text: 'held', clientRunKey: 'grace-key' },
      context,
      request('session.prompt', created.sessionId)
    )) as unknown as { runId: string }

    await handler(adapter.handlers, 'session.abort')(
      {},
      lifecycleContext,
      request('session.abort', created.sessionId)
    )

    const receipts = readFileSync(
      join(agentDir, 'phi-kernel', 'sessions', created.sessionId, 'runs.jsonl'),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(receipts.at(-1), {
      runId: started.runId,
      state: 'terminal',
      status: 'cancelled',
      at: receipts.at(-1).at
    })
  } finally {
    await adapter.closeAll().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

test('lifecycle approval denial makes cancelled authoritative before releasing the run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-worker-lifecycle-approval-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd)
  let releasePrompt!: () => void
  const promptReleased = new Promise<void>((resolve) => {
    releasePrompt = resolve
  })
  const adapter = createWorkerKernelAdapter({
    agentDir,
    processStartedAt: 'darwin:test-process',
    acquireSessionLockGuard: acquireTestGuard,
    callWorker: async (method) => {
      if (method === 'session.prompt') await promptReleased
      if (method === 'toolApproval.result') {
        releasePrompt()
        return true
      }
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
    const started = (await handler(adapter.handlers, 'session.prompt')(
      { text: 'approval blocked', clientRunKey: 'approval-grace-key' },
      context,
      request('session.prompt', created.sessionId)
    )) as unknown as { runId: string; completion: PromiseLike<string> }
    const denialRequest = request('approval.respond', created.sessionId)
    denialRequest.runId = started.runId
    await handler(adapter.handlers, 'approval.respond')(
      {
        approvalId: 'approval-grace',
        decision: 'denied',
        reason: 'client did not return'
      },
      lifecycleContext,
      denialRequest
    )
    assert.equal(await started.completion, 'cancelled')

    const abortRequest = request('session.abort', created.sessionId)
    abortRequest.runId = started.runId
    await handler(adapter.handlers, 'session.abort')({}, lifecycleContext, abortRequest)

    const receipts = readFileSync(
      join(agentDir, 'phi-kernel', 'sessions', created.sessionId, 'runs.jsonl'),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(receipts.filter((receipt) => receipt.state === 'terminal').length, 1)
    assert.equal(receipts.at(-1).status, 'cancelled')
  } finally {
    await adapter.closeAll().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

test('closeAll disposes loaded sessions, terminalizes active receipts, and releases locks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-worker-close-all-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd)
  const never = new Promise<void>(() => undefined)
  const calls: string[] = []
  const adapter = createWorkerKernelAdapter({
    agentDir,
    processStartedAt: 'darwin:test-process',
    acquireSessionLockGuard: acquireTestGuard,
    callWorker: async (method) => {
      calls.push(method)
      if (method === 'session.prompt') await never
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
    const started = (await handler(adapter.handlers, 'session.prompt')(
      { text: 'held', clientRunKey: 'shutdown-key' },
      context,
      request('session.prompt', created.sessionId)
    )) as unknown as { runId: string }
    const directory = join(agentDir, 'phi-kernel', 'sessions', created.sessionId)

    await adapter.closeAll()
    await adapter.closeAll()

    const receipts = readFileSync(join(directory, 'runs.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(receipts.at(-1).runId, started.runId)
    assert.equal(receipts.at(-1).status, 'cancelled')
    assert.equal(existsSync(join(directory, 'writer.lock')), false)
    assert.equal(calls.filter((method) => method === 'session.abort').length, 1)
    assert.equal(calls.filter((method) => method === 'session.dispose').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
