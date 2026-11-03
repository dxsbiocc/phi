import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import { KernelSessionRepository } from '../src/kernel/sessions'
import { createHistoryHandlers } from '../src/kernel/worker/history-handlers'
import type { KernelMethodHandler } from '../src/kernel/protocol'

function runManagerProbe(
  operation: 'create' | 'open',
  path: string,
  cwd: string,
  agentDir: string,
  message = ''
): void {
  const script = [
    "import { makeSessionManager } from './src/main/agent/engine/in-process/session-factory'",
    'const { PROBE_OPERATION: operation, PROBE_PATH: path, PROBE_CWD: cwd, PROBE_AGENT_DIR: agentDir, PROBE_MESSAGE: message } = process.env',
    "const manager = await makeSessionManager(operation === 'create' ? { kind: 'persistent', path } : { kind: 'open', path, requireExisting: true, suppressBreadcrumb: true }, cwd, agentDir)",
    "if (operation === 'create') manager.appendMessage({ role: 'user', content: message, timestamp: Date.now() })",
    'await manager.close()'
  ].join('\n')
  execFileSync(resolveBunExecutable(), ['-e', script], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      PROBE_OPERATION: operation,
      PROBE_PATH: path,
      PROBE_CWD: cwd,
      PROBE_AGENT_DIR: agentDir,
      PROBE_MESSAGE: message
    },
    stdio: ['ignore', 'ignore', 'inherit']
  })
}

function bunJournalValidator(agentDir: string): (path: string, cwd: string) => Promise<void> {
  return async (path, cwd) => {
    runManagerProbe('open', path, cwd, agentDir)
  }
}

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
  runManagerProbe('create', source, cwd, agentDir, 'adopt me')
  const repository = new KernelSessionRepository(
    agentDir,
    'history-handler',
    undefined,
    'test-process'
  )
  const handler = createHistoryHandlers({
    repository,
    allowedSourceRoots: [sourceRoot],
    migrationTestHooks: { validateJournal: bunJournalValidator(agentDir) }
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
  runManagerProbe('create', source, cwd, agentDir, 'busy')
  // Real process start tokens: a fake token makes the live holder look like a reused PID.
  const left = new KernelSessionRepository(agentDir, 'left')
  const right = new KernelSessionRepository(agentDir, 'right')
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
      validateJournal: bunJournalValidator(agentDir)
    })
    await left.open(held.sessionId)
    const handler = createHistoryHandlers({
      repository: right,
      allowedSourceRoots: [sourceRoot],
      migrationTestHooks: { validateJournal: bunJournalValidator(agentDir) }
    })['session.adopt']
    await assert.rejects(invoke(handler, input), (error: unknown) => {
      assert.deepEqual(error, {
        code: 'SESSION_BUSY',
        message: 'Another Phi kernel is using this session.',
        detail: { reason: 'other_kernel_owner' }
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
