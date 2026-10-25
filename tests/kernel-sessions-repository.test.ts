import assert from 'node:assert/strict'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { SessionCreateParams } from '../src/shared/kernel-protocol'

const {
  KernelSessionRepository,
  SessionWriterBusyError,
  kernelSessionPaths,
  readManifest,
  readReceipts,
  writeManifestAtomic
} = await import('../src/kernel/sessions')

const heldGuardPaths = new Set<string>()

function acquireTestGuard(path: string): { acquired: boolean; release(): void } {
  const acquired = !heldGuardPaths.has(path)
  if (acquired) heldGuardPaths.add(path)
  let released = false
  return {
    acquired,
    release() {
      if (released) return
      released = true
      if (acquired) heldGuardPaths.delete(path)
    }
  }
}

type Fixture = {
  root: string
  cwd: string
  agentDir: string
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-sessions-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd)
  return { root, cwd, agentDir }
}

function makeRepository(
  agentDir: string,
  kernelInstanceId: string
): InstanceType<typeof KernelSessionRepository> {
  return new KernelSessionRepository(agentDir, kernelInstanceId, acquireTestGuard, 'test-process')
}

function persistentParams(cwd: string): SessionCreateParams {
  return {
    cwd,
    model: { provider: 'test-provider', id: 'test-model' },
    thinkingLevel: 'high',
    sessionManager: { kind: 'persistent' }
  }
}

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

function jsonLines(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('persistent create uses the exact private repository layout', async () => {
  const { root, cwd, agentDir } = fixture()
  const repository = makeRepository(agentDir, 'kernel-layout')
  try {
    const session = await repository.create('layout-session', persistentParams(cwd))
    const paths = kernelSessionPaths(agentDir, 'layout-session')

    assert.deepEqual(
      {
        directory: session.directory,
        journal: session.journalPath,
        manifest: session.manifestPath,
        receipts: session.receiptsPath,
        lock: session.lock.path
      },
      paths
    )
    assert.deepEqual(readdirSync(paths.directory).sort(), [
      'runs.jsonl',
      'session.json',
      'writer.lock'
    ])
    assert.equal(mode(join(agentDir, 'phi-kernel')), 0o700)
    assert.equal(mode(join(agentDir, 'phi-kernel', 'sessions')), 0o700)
    assert.equal(mode(paths.directory), 0o700)
    assert.equal(mode(paths.manifest), 0o600)
    assert.equal(mode(paths.receipts), 0o600)
    assert.equal(mode(paths.lock), 0o600)
  } finally {
    await repository.close('layout-session')
    rmSync(root, { recursive: true, force: true })
  }
})

test('accepted receipt is fsync-visible when acceptRun resolves and identifies a running duplicate', async () => {
  const { root, cwd, agentDir } = fixture()
  const repository = makeRepository(agentDir, 'kernel-accepted')
  try {
    const session = await repository.create('receipt-session', persistentParams(cwd))
    await repository.acceptRun(session, 'run-accepted', 'client-key')

    assert.deepEqual(jsonLines(session.receiptsPath), [
      {
        runId: 'run-accepted',
        clientRunKey: 'client-key',
        state: 'accepted',
        at: session.runs.get('run-accepted')?.accepted.at
      }
    ])
    assert.deepEqual(repository.findDuplicate(session, 'client-key'), {
      runId: 'run-accepted',
      status: 'running'
    })
  } finally {
    await repository.close('receipt-session')
    rmSync(root, { recursive: true, force: true })
  }
})

test('terminal receipt and manifest are fsync-visible when finishRun resolves', async () => {
  const { root, cwd, agentDir } = fixture()
  const repository = makeRepository(agentDir, 'kernel-terminal')
  try {
    const session = await repository.create('terminal-session', persistentParams(cwd))
    await repository.acceptRun(session, 'run-terminal', 'terminal-key')
    await repository.finishRun(session, 'run-terminal', 'completed')

    const receipts = await readReceipts(session.receiptsPath)
    assert.equal(receipts.length, 2)
    assert.deepEqual(receipts[1], session.runs.get('run-terminal')?.terminal)
    assert.deepEqual((await readManifest(session.manifestPath, 'terminal-session')).lastRun, {
      runId: 'run-terminal',
      status: 'completed'
    })
    assert.deepEqual(repository.findDuplicate(session, 'terminal-key'), {
      runId: 'run-terminal',
      status: 'completed'
    })
  } finally {
    await repository.close('terminal-session')
    rmSync(root, { recursive: true, force: true })
  }
})

test('racing run finalizers append exactly one authoritative terminal receipt', async () => {
  const { root, cwd, agentDir } = fixture()
  const repository = makeRepository(agentDir, 'kernel-terminal-race')
  try {
    const session = await repository.create('terminal-race-session', persistentParams(cwd))
    await repository.acceptRun(session, 'run-terminal-race', 'terminal-race-key')

    await Promise.all([
      repository.finishRun(session, 'run-terminal-race', 'completed'),
      repository.finishRun(session, 'run-terminal-race', 'cancelled')
    ])

    const receipts = await readReceipts(session.receiptsPath)
    assert.equal(receipts.length, 2)
    assert.equal(
      receipts.filter(
        (receipt) => receipt.state === 'terminal' && receipt.runId === 'run-terminal-race'
      ).length,
      1
    )
    assert.deepEqual((await readManifest(session.manifestPath, 'terminal-race-session')).lastRun, {
      runId: 'run-terminal-race',
      status: receipts[1].state === 'terminal' ? receipts[1].status : undefined
    })
  } finally {
    await repository.close('terminal-race-session')
    rmSync(root, { recursive: true, force: true })
  }
})

test('reopen records one unknown terminal receipt for an interrupted accepted run', async () => {
  const { root, cwd, agentDir } = fixture()
  const first = makeRepository(agentDir, 'kernel-before-crash')
  const second = makeRepository(agentDir, 'kernel-after-crash')
  const third = makeRepository(agentDir, 'kernel-second-reopen')
  try {
    const created = await first.create('interrupted-session', persistentParams(cwd))
    await first.acceptRun(created, 'interrupted-run', 'interrupted-key')
    await first.close('interrupted-session')

    const recovered = await second.open('interrupted-session')
    assert.deepEqual(await readReceipts(recovered.receiptsPath), [
      recovered.runs.get('interrupted-run')?.accepted,
      {
        runId: 'interrupted-run',
        state: 'terminal',
        status: 'unknown',
        at: recovered.runs.get('interrupted-run')?.terminal?.at,
        reason: 'kernel exited before completion'
      }
    ])
    assert.deepEqual(recovered.manifest.lastRun, {
      runId: 'interrupted-run',
      status: 'unknown'
    })
    assert.deepEqual(second.findDuplicate(recovered, 'interrupted-key'), {
      runId: 'interrupted-run',
      status: 'unknown'
    })
    await second.close('interrupted-session')

    const reopened = await third.open('interrupted-session')
    assert.equal((await readReceipts(reopened.receiptsPath)).length, 2)
  } finally {
    await first.close('interrupted-session')
    await second.close('interrupted-session')
    await third.close('interrupted-session')
    rmSync(root, { recursive: true, force: true })
  }
})

test('reopen truncates an unterminated receipt fragment before future appends', async () => {
  const { root, cwd, agentDir } = fixture()
  const first = makeRepository(agentDir, 'kernel-fragment-first')
  const second = makeRepository(agentDir, 'kernel-fragment-second')
  try {
    const created = await first.create('fragment-session', persistentParams(cwd))
    await first.close('fragment-session')
    appendFileSync(created.receiptsPath, '{"runId":"partial')

    const reopened = await second.open('fragment-session')
    assert.deepEqual(await readReceipts(reopened.receiptsPath), [])
    await second.acceptRun(reopened, 'next-run', 'next-key')
    await second.finishRun(reopened, 'next-run', 'completed')
    assert.equal((await readReceipts(reopened.receiptsPath)).length, 2)
  } finally {
    await first.close('fragment-session')
    await second.close('fragment-session')
    rmSync(root, { recursive: true, force: true })
  }
})

test('close and reopen preserve history metadata and last run', async () => {
  const { root, cwd, agentDir } = fixture()
  const first = makeRepository(agentDir, 'kernel-history-first')
  const second = makeRepository(agentDir, 'kernel-history-second')
  try {
    const created = await first.create('history-session', persistentParams(cwd))
    created.manifest = { ...created.manifest, title: 'Durable history' }
    await writeManifestAtomic(created.manifestPath, created.manifest)
    await first.acceptRun(created, 'history-run')
    await first.finishRun(created, 'history-run', 'failed')
    const createdAt = created.manifest.createdAt
    await first.close('history-session')

    const reopened = await second.open('history-session')
    assert.equal(reopened.manifest.cwd, cwd)
    assert.equal(reopened.manifest.createdAt, createdAt)
    assert.equal(reopened.manifest.title, 'Durable history')
    assert.deepEqual(reopened.manifest.model, {
      provider: 'test-provider',
      id: 'test-model'
    })
    assert.equal(reopened.manifest.thinkingLevel, 'high')
    assert.deepEqual(reopened.manifest.lastRun, {
      runId: 'history-run',
      status: 'failed'
    })
  } finally {
    await first.close('history-session')
    await second.close('history-session')
    rmSync(root, { recursive: true, force: true })
  }
})

test('two repositories allow exactly one writer and hand off after close', async () => {
  const { root, cwd, agentDir } = fixture()
  const seed = makeRepository(agentDir, 'kernel-seed')
  const left = makeRepository(agentDir, 'kernel-left')
  const right = makeRepository(agentDir, 'kernel-right')
  try {
    await seed.create('contended-session', persistentParams(cwd))
    await seed.close('contended-session')

    const contenders = await Promise.allSettled([
      left.open('contended-session'),
      right.open('contended-session')
    ])
    const winnerIndex = contenders.findIndex((result) => result.status === 'fulfilled')
    const loserIndex = contenders.findIndex((result) => result.status === 'rejected')
    assert.notEqual(winnerIndex, -1)
    assert.notEqual(loserIndex, -1)
    const loser = contenders[loserIndex]
    assert.equal(loser.status, 'rejected')
    assert.ok(loser.reason instanceof SessionWriterBusyError)

    const winner = winnerIndex === 0 ? left : right
    const waiting = winnerIndex === 0 ? right : left
    await winner.close('contended-session')
    assert.equal((await waiting.open('contended-session')).manifest.sessionId, 'contended-session')
  } finally {
    await seed.close('contended-session')
    await left.close('contended-session')
    await right.close('contended-session')
    rmSync(root, { recursive: true, force: true })
  }
})

test('sessions list repairs a truncated manifest from a minimal valid OMP journal', async () => {
  const { root, cwd, agentDir } = fixture()
  const repository = makeRepository(agentDir, 'kernel-repair')
  try {
    const session = await repository.create('repair-session', persistentParams(cwd))
    const timestamp = '2026-10-25T01:02:03.000Z'
    writeFileSync(
      session.journalPath,
      `${JSON.stringify({
        type: 'session',
        version: 3,
        id: 'repair-session',
        timestamp,
        cwd
      })}\n`,
      { mode: 0o600 }
    )
    await repository.close('repair-session')
    writeFileSync(`${session.manifestPath}.tmp.interrupted`, '{"schemaVersion":1', {
      mode: 0o600
    })
    writeFileSync(session.manifestPath, '{', { mode: 0o600 })

    const journalUpdatedAt = statSync(session.journalPath).mtime.toISOString()
    const expectedUpdatedAt =
      Date.parse(timestamp) >= Date.parse(journalUpdatedAt) ? timestamp : journalUpdatedAt
    assert.deepEqual(await repository.list(), {
      sessions: [
        {
          sessionId: 'repair-session',
          cwd,
          createdAt: timestamp,
          updatedAt: expectedUpdatedAt,
          loaded: false
        }
      ]
    })
    assert.equal((await readManifest(session.manifestPath, 'repair-session')).cwd, cwd)
    assert.equal(existsSync(`${session.manifestPath}.tmp.interrupted`), true)
  } finally {
    await repository.close('repair-session')
    rmSync(root, { recursive: true, force: true })
  }
})

test('sessions list reports an unrepairable entry without dropping healthy sessions', async () => {
  const { root, cwd, agentDir } = fixture()
  const repository = makeRepository(agentDir, 'kernel-corrupt-list')
  try {
    await repository.create('healthy-session', persistentParams(cwd))
    await repository.close('healthy-session')
    const corrupt = kernelSessionPaths(agentDir, 'corrupt-session')
    mkdirSync(corrupt.directory, { mode: 0o700 })
    writeFileSync(corrupt.manifest, '{', { mode: 0o600 })
    writeFileSync(corrupt.journal, '{"type":"message"}\n', { mode: 0o600 })

    const { sessions } = await repository.list()
    assert.equal(sessions.length, 2)
    const healthy = sessions.find((entry) => entry.sessionId === 'healthy-session')
    assert.ok(healthy && !('error' in healthy))
    assert.equal(healthy.cwd, cwd)
    assert.equal(healthy.loaded, false)
    assert.deepEqual(
      sessions.find((entry) => entry.sessionId === 'corrupt-session'),
      {
        sessionId: 'corrupt-session',
        error: {
          code: 'CORRUPT_SESSION',
          message: 'session metadata cannot be read or repaired'
        }
      }
    )
  } finally {
    await repository.close('healthy-session')
    rmSync(root, { recursive: true, force: true })
  }
})
