import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

const BUN_CHILD_TEST_ENV = 'PHI_KERNEL_SESSION_FORK_BUN_TEST'
const bunRuntime = 'Bun' in globalThis
const selectedBunTest = bunRuntime ? process.env[BUN_CHILD_TEST_ENV] : undefined

function it(name: string, body: (context: TestContext) => void | Promise<void>): void {
  if (bunRuntime) {
    if (!selectedBunTest || selectedBunTest === name) test(name, body)
    return
  }
  test(name, () => {
    execFileSync(
      resolveBunExecutable(),
      ['test', '--timeout', '60000', fileURLToPath(import.meta.url), '--test-name-pattern', name],
      {
        cwd: resolve('.'),
        env: { ...process.env, [BUN_CHILD_TEST_ENV]: name },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
  })
}

const forkModule = bunRuntime
  ? await import('../src/main/agent/engine/in-process/session-fork')
  : undefined
const factoryModule = bunRuntime
  ? await import('../src/main/agent/engine/in-process/session-factory')
  : undefined
const { cloneSessionManagerForFork } =
  forkModule ?? ({} as typeof import('../src/main/agent/engine/in-process/session-fork'))
const { makeSessionManager } =
  factoryModule ?? ({} as typeof import('../src/main/agent/engine/in-process/session-factory'))

type SessionManager = Awaited<ReturnType<typeof makeSessionManager>>

function appendAssistant(manager: SessionManager, text: string): void {
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'fixture',
    model: 'fixture-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: Date.now()
  })
}

function appendHistory(manager: SessionManager): void {
  manager.appendMessage({ role: 'user', content: 'remember this', timestamp: Date.now() })
  manager.appendCustomEntry('phi-test', { retained: true })
}

it('memory session fork clones full history and leaves the source unchanged', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'phi-kernel-memory-fork-'))
  const source = await makeSessionManager({ kind: 'memory' }, cwd, join(cwd, 'agent'))
  try {
    appendHistory(source)
    const sourceBefore = structuredClone(source.getBranch())

    const fork = await cloneSessionManagerForFork(source, { kind: 'memory' })
    assert.deepEqual(fork.getBranch(), sourceBefore)
    assert.deepEqual(source.getBranch(), sourceBefore)

    fork.appendMessage({ role: 'user', content: 'fork only', timestamp: Date.now() })
    assert.equal(fork.getBranch().length, sourceBefore.length + 1)
    assert.deepEqual(source.getBranch(), sourceBefore)
  } finally {
    await source.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

it('persistent session fork copies full history into the requested journal without changing source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-persistent-fork-'))
  const cwd = join(root, 'project')
  const sourceDir = join(root, 'source')
  const targetPath = join(root, 'target', 'journal.jsonl')
  const source = await makeSessionManager(
    { kind: 'persistent', path: join(sourceDir, 'journal.jsonl') },
    cwd,
    join(root, 'agent')
  )
  try {
    appendHistory(source)
    await source.ensureOnDisk()
    await source.flush()
    const sourcePath = source.getSessionFile()
    assert.ok(sourcePath)
    const sourceBytes = readFileSync(sourcePath)
    const sourceBefore = structuredClone(source.getBranch())

    const fork = await cloneSessionManagerForFork(source, {
      kind: 'persistent',
      path: targetPath
    })
    assert.equal(fork.getSessionFile(), targetPath)
    assert.deepEqual(fork.getBranch(), sourceBefore)
    assert.deepEqual(source.getBranch(), sourceBefore)
    assert.deepEqual(readFileSync(sourcePath), sourceBytes)

    fork.appendMessage({ role: 'user', content: 'fork only', timestamp: Date.now() })
    await fork.flush()
    assert.equal(fork.getBranch().length, sourceBefore.length + 1)
    assert.deepEqual(source.getBranch(), sourceBefore)
    assert.deepEqual(readFileSync(sourcePath), sourceBytes)
    await fork.close()
  } finally {
    await source.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('selected-turn persistent fork keeps exactly through the selected reply and leaves source unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-selected-fork-'))
  const cwd = join(root, 'project')
  const sourcePath = join(root, 'source', 'journal.jsonl')
  const targetPath = join(root, 'target', 'journal.jsonl')
  const source = await makeSessionManager(
    { kind: 'persistent', path: sourcePath },
    cwd,
    join(root, 'agent')
  )
  let fork: SessionManager | undefined
  try {
    source.appendMessage({ role: 'user', content: 'first question', timestamp: Date.now() })
    appendAssistant(source, 'first reply')
    source.appendCustomEntry('reply-metadata', { retained: true })
    source.appendMessage({ role: 'user', content: 'second question', timestamp: Date.now() })
    appendAssistant(source, 'second reply')
    source.appendMessage({ role: 'user', content: 'third question', timestamp: Date.now() })
    appendAssistant(source, 'third reply')
    await source.ensureOnDisk()
    await source.flush()

    const sourceBefore = structuredClone(source.getBranch())
    const sourceBytes = readFileSync(sourcePath)
    const nextUserIndex = sourceBefore.findIndex(
      (entry) =>
        entry.type === 'message' &&
        entry.message.role === 'user' &&
        entry.message.content === 'second question'
    )
    assert.notEqual(nextUserIndex, -1)

    fork = await cloneSessionManagerForFork(
      source,
      { kind: 'persistent', path: targetPath },
      {
        userMessages: ['first question', 'second question'],
        selectedIndex: 0
      }
    )

    assert.deepEqual(fork.getBranch(), sourceBefore.slice(0, nextUserIndex))
    assert.deepEqual(source.getBranch(), sourceBefore)
    assert.deepEqual(readFileSync(sourcePath), sourceBytes)
  } finally {
    await fork?.close()
    await source.close()
    rmSync(root, { recursive: true, force: true })
  }
})
