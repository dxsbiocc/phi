import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { makeSessionManager } from '../src/main/agent/engine/in-process/session-factory'
import { KernelSessionRepository } from '../src/kernel/sessions'
import type { KernelMethodHandler, SessionPromptRun } from '../src/kernel/protocol'
import { createWorkerKernelAdapter } from '../src/kernel/worker'

function request(method: string, sessionId?: string): Parameters<KernelMethodHandler>[2] {
  return {
    kind: 'request',
    id: `${method}-request`,
    method,
    params: {},
    generation: 1,
    ...(sessionId ? { sessionId } : {})
  }
}

const context = { controllerGeneration: 1, connectionId: 'loopback-test', trusted: true }

test('A19 loopback faux provider opens adopted history, snapshots it, and continues', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-history-continuation-'))
  const cwd = join(root, 'project')
  const sourceRoot = join(root, 'source')
  const source = join(sourceRoot, 'journal.jsonl')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd)
  mkdirSync(sourceRoot)
  const sourceManager = await makeSessionManager(
    { kind: 'persistent', path: source },
    cwd,
    agentDir
  )
  sourceManager.appendMessage({ role: 'user', content: 'historic turn', timestamp: Date.now() })
  sourceManager.appendModeChange('plan_execute', { phase: 'executing' })
  sourceManager.appendCustomEntry('phi.plan-execution', {
    state: 'interrupted',
    completedSteps: ['inspect'],
    pendingSteps: ['apply', 'verify']
  })
  await sourceManager.close()

  const adopter = new KernelSessionRepository(
    agentDir,
    'adopter',
    undefined,
    'test-process',
    async (path, initialCwd) => {
      const manager = await makeSessionManager(
        { kind: 'open', path, requireExisting: true, suppressBreadcrumb: true },
        initialCwd,
        agentDir
      )
      await manager.close()
    }
  )
  const adopted = await adopter.adopt(
    {
      source: {
        kind: 'omp-journal',
        path: source,
        cwd,
        origin: 'desktop-local',
        phiSessionId: 'phi-loopback'
      },
      model: { provider: 'faux', id: 'loopback' }
    },
    { allowedSourceRoots: [sourceRoot] }
  )

  const managers = new Map<string, Awaited<ReturnType<typeof makeSessionManager>>>()
  const adapter = createWorkerKernelAdapter({
    agentDir,
    kernelInstanceId: 'loopback-kernel',
    processStartedAt: 'test-process',
    acquireSessionLockGuard: () => ({ acquired: true, release: () => undefined }),
    async callWorker(method, raw) {
      const params = raw as Record<string, unknown>
      const sessionId = String(params.sessionId)
      if (method === 'session.create') {
        managers.set(
          sessionId,
          await makeSessionManager(params.sessionManager, String(params.cwd), agentDir)
        )
        return { sessionId }
      }
      const manager = managers.get(sessionId)
      if (method === 'session.prompt' && manager) {
        manager.appendMessage({
          role: 'user',
          content: String(params.text),
          timestamp: Date.now()
        })
        manager.appendCustomMessageEntry(
          'faux-provider-result',
          'continued by loopback provider',
          true,
          { provider: 'faux', model: 'loopback' }
        )
        return undefined
      }
      if (method === 'session.dispose') {
        await manager?.close()
        managers.delete(sessionId)
        return undefined
      }
      if (method === 'session.abort') return undefined
      throw new Error(`unexpected worker method ${method}`)
    },
    readSessionState(sessionId) {
      const manager = managers.get(sessionId)
      if (!manager) throw new Error('loopback session is not loaded')
      return {
        cwd: manager.getCwd(),
        model: { provider: 'faux', id: 'loopback' },
        messages: manager.buildSessionContext().messages
      }
    }
  })
  try {
    const open = adapter.handlers['session.open'] as KernelMethodHandler
    const snapshot = adapter.handlers['session.snapshot'] as KernelMethodHandler
    const prompt = adapter.handlers['session.prompt'] as KernelMethodHandler
    assert.deepEqual(
      await open({ sessionId: adopted.sessionId }, context, request('session.open')),
      { sessionId: adopted.sessionId }
    )
    const before = (await snapshot(
      {},
      context,
      request('session.snapshot', adopted.sessionId)
    )) as { messages: unknown[] }
    assert.equal(before.messages.length, 1)

    const accepted = (await prompt(
      { text: 'continue safely', clientRunKey: 'loopback-run' },
      context,
      request('session.prompt', adopted.sessionId)
    )) as SessionPromptRun
    assert.equal(await accepted.completion, 'completed')
    const after = (await snapshot({}, context, request('session.snapshot', adopted.sessionId))) as {
      messages: unknown[]
      lastRun?: { status: string }
    }
    assert.equal(after.messages.length, 3)
    assert.equal(after.lastRun?.status, 'completed')
  } finally {
    await adapter.closeAll()
    await adopter.close(adopted.sessionId)
    rmSync(root, { recursive: true, force: true })
  }
})
