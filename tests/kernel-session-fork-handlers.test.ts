import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { JsonValue, KernelRequestFrame } from '../src/shared/kernel-protocol'
import type { KernelCallContext, KernelMethodHandler } from '../src/kernel/protocol'
import { kernelSessionPaths } from '../src/kernel/sessions'
import { createWorkerKernelAdapter } from '../src/kernel/worker'

const context: KernelCallContext = {
  controllerGeneration: 1,
  connectionId: 'fork-test',
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

type WorkerSession = {
  kind: 'memory' | 'persistent'
  history: JsonValue[]
}

function forkFixture(): {
  root: string
  cwd: string
  agentDir: string
  sessions: Map<string, WorkerSession>
  adapter: ReturnType<typeof createWorkerKernelAdapter>
} {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-fork-handler-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd)
  const sessions = new Map<string, WorkerSession>()
  const adapter = createWorkerKernelAdapter({
    agentDir,
    kernelInstanceId: 'fork-kernel',
    processStartedAt: 'fork-test-process',
    acquireSessionLockGuard: acquireTestGuard,
    callWorker: async (method, params) => {
      const input = params as Record<string, unknown>
      if (method === 'session.create') {
        const sessionManager = input.sessionManager as { kind: 'memory' | 'persistent' }
        sessions.set(String(input.sessionId), { kind: sessionManager.kind, history: [] })
      } else if (method === 'session.fork') {
        const source = sessions.get(String(input.sourceSessionId))
        assert.ok(source)
        sessions.set(String(input.targetSessionId), {
          kind: (input.sessionManager as { kind: 'memory' | 'persistent' }).kind,
          history: structuredClone(source.history)
        })
      } else if (method === 'session.dispose') {
        sessions.delete(String(input.sessionId))
      }
      return undefined
    },
    readSessionState: async (sessionId) => ({
      cwd,
      messages: sessions.get(sessionId)?.history ?? []
    })
  })
  return { root, cwd, agentDir, sessions, adapter }
}

test('session.fork copies a memory session by request identity and leaves its source unchanged', async () => {
  const fixture = forkFixture()
  try {
    const source = (await handler(fixture.adapter.handlers, 'session.create')(
      {
        cwd: fixture.cwd,
        model: { provider: 'provider', id: 'model' },
        sessionManager: { kind: 'memory' }
      },
      context,
      request('session.create')
    )) as { sessionId: string }
    fixture.sessions
      .get(source.sessionId)
      ?.history.push({ role: 'user', content: 'memory history' })
    const original = structuredClone(fixture.sessions.get(source.sessionId)?.history)

    const fork = (await handler(fixture.adapter.handlers, 'session.fork')(
      {},
      context,
      request('session.fork', source.sessionId)
    )) as { sessionId: string }

    assert.notEqual(fork.sessionId, source.sessionId)
    assert.deepEqual(fixture.sessions.get(fork.sessionId)?.history, original)
    assert.deepEqual(fixture.sessions.get(source.sessionId)?.history, original)
    fixture.sessions.get(fork.sessionId)?.history.push({ role: 'user', content: 'fork only' })
    assert.deepEqual(fixture.sessions.get(source.sessionId)?.history, original)
  } finally {
    await fixture.adapter.closeAll()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('session.fork gives a persistent target an independent writer lock', async () => {
  const fixture = forkFixture()
  try {
    const source = (await handler(fixture.adapter.handlers, 'session.create')(
      {
        cwd: fixture.cwd,
        model: { provider: 'provider', id: 'model' },
        sessionManager: { kind: 'persistent' }
      },
      context,
      request('session.create')
    )) as { sessionId: string }
    fixture.sessions
      .get(source.sessionId)
      ?.history.push({ role: 'user', content: 'persistent history' })
    const original = structuredClone(fixture.sessions.get(source.sessionId)?.history)

    const fork = (await handler(fixture.adapter.handlers, 'session.fork')(
      {},
      context,
      request('session.fork', source.sessionId)
    )) as { sessionId: string }
    const sourceLock = kernelSessionPaths(fixture.agentDir, source.sessionId).lock
    const forkLock = kernelSessionPaths(fixture.agentDir, fork.sessionId).lock

    assert.notEqual(fork.sessionId, source.sessionId)
    assert.notEqual(sourceLock, forkLock)
    assert.equal(existsSync(sourceLock), true)
    assert.equal(existsSync(forkLock), true)
    assert.equal(JSON.parse(readFileSync(sourceLock, 'utf8')).kernelInstanceId, 'fork-kernel')
    assert.equal(JSON.parse(readFileSync(forkLock, 'utf8')).kernelInstanceId, 'fork-kernel')
    assert.deepEqual(fixture.sessions.get(fork.sessionId)?.history, original)
    assert.deepEqual(fixture.sessions.get(source.sessionId)?.history, original)

    await handler(fixture.adapter.handlers, 'session.close')(
      {},
      context,
      request('session.close', source.sessionId)
    )
    assert.equal(existsSync(sourceLock), false)
    assert.equal(existsSync(forkLock), true)
  } finally {
    await fixture.adapter.closeAll()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
