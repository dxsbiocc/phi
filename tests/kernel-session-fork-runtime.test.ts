import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { cloneSessionManagerForFork } from '../src/main/agent/engine/in-process/session-fork'
import { makeSessionManager } from '../src/main/agent/engine/in-process/session-factory'

type SessionManager = Awaited<ReturnType<typeof makeSessionManager>>

function appendHistory(manager: SessionManager): void {
  manager.appendMessage({ role: 'user', content: 'remember this', timestamp: Date.now() })
  manager.appendCustomEntry('phi-test', { retained: true })
}

test('memory session fork clones full history and leaves the source unchanged', async () => {
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

test('persistent session fork copies full history into the requested journal without changing source', async () => {
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
