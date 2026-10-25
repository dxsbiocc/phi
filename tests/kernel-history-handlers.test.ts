import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { makeSessionManager } from '../src/main/agent/engine/in-process/session-factory'
import { KernelSessionRepository } from '../src/kernel/sessions'
import {
  createHistoryHandlers,
  validateHistoryJournal
} from '../src/kernel/worker/history-handlers'
import type { KernelMethodHandler } from '../src/kernel/protocol'

async function invoke(handler: KernelMethodHandler, params: unknown): Promise<unknown> {
  return handler(
    params as never,
    { controllerGeneration: 1, connectionId: 'test', trusted: true },
    { kind: 'request', id: 'request-1', method: 'session.create', params: {}, generation: 1 }
  )
}

test('history handler validates params and adopts through trusted source roots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-history-handler-'))
  const cwd = join(root, 'project')
  const sourceRoot = join(root, 'sources')
  const source = join(sourceRoot, 'source.jsonl')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd)
  mkdirSync(sourceRoot)
  const manager = await makeSessionManager({ kind: 'persistent', path: source }, cwd, agentDir)
  manager.appendMessage({ role: 'user', content: 'adopt me', timestamp: Date.now() })
  await manager.close()
  const repository = new KernelSessionRepository(
    agentDir,
    'history-handler',
    undefined,
    'test-process'
  )
  const handler = createHistoryHandlers({
    repository,
    allowedSourceRoots: [sourceRoot]
  })['session.adopt']
  try {
    await assert.rejects(invoke(handler, { source: {} }), (error: unknown) => {
      assert.deepEqual(error, {
        code: 'INVALID_PARAMS',
        message: 'The session adoption parameters are invalid.'
      })
      return true
    })
    const result = (await invoke(handler, {
      source: {
        kind: 'omp-journal',
        path: source,
        cwd,
        origin: 'desktop-local',
        phiSessionId: 'phi-handler-session'
      }
    })) as { sessionId: string; migration: { state: string; sourceSha256: string } }
    assert.match(result.sessionId, /^adopt-[a-f0-9]{48}$/)
    assert.equal(result.migration.state, 'complete')
    assert.match(result.migration.sourceSha256, /^[a-f0-9]{64}$/)
  } finally {
    for (const entry of (await repository.list()).sessions) await repository.close(entry.sessionId)
    rmSync(root, { recursive: true, force: true })
  }
})

test('history handler maps a held target writer to SESSION_BUSY', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-history-handler-busy-'))
  const cwd = join(root, 'project')
  const sourceRoot = join(root, 'sources')
  const source = join(sourceRoot, 'source.jsonl')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd)
  mkdirSync(sourceRoot)
  const manager = await makeSessionManager({ kind: 'persistent', path: source }, cwd, agentDir)
  manager.appendMessage({ role: 'user', content: 'busy', timestamp: Date.now() })
  await manager.close()
  const left = new KernelSessionRepository(agentDir, 'left', undefined, 'test-process')
  const right = new KernelSessionRepository(agentDir, 'right', undefined, 'test-process')
  const input = {
    source: {
      kind: 'omp-journal' as const,
      path: source,
      cwd,
      origin: 'desktop-local' as const,
      phiSessionId: 'phi-busy-session'
    }
  }
  try {
    const held = await left.adopt(input, {
      allowedSourceRoots: [sourceRoot],
      validateJournal: validateHistoryJournal
    })
    await left.open(held.sessionId)
    const handler = createHistoryHandlers({
      repository: right,
      allowedSourceRoots: [sourceRoot]
    })['session.adopt']
    await assert.rejects(invoke(handler, input), (error: unknown) => {
      assert.deepEqual(error, {
        code: 'SESSION_BUSY',
        message: 'Another kernel owns this session.'
      })
      return true
    })
    await left.close(held.sessionId)
  } finally {
    const sessionId = (await left.list()).sessions[0]?.sessionId
    if (sessionId) {
      await left.close(sessionId)
      await right.close(sessionId)
    }
    rmSync(root, { recursive: true, force: true })
  }
})
