import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const {
  SessionWriterBusyError,
  acquireSessionWriterLock,
  currentProcessStartedAt,
  writeSessionWriterLockSync
} = await import('../src/kernel/sessions')

function lockFixture(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-writer-lock-'))
  const directory = join(root, 'session')
  mkdirSync(directory)
  return { root, path: join(directory, 'writer.lock') }
}

test('same-host lock with a dead pid is taken over without stale debris', async () => {
  const { root, path } = lockFixture()
  try {
    writeSessionWriterLockSync(path, {
      pid: 2_147_483_647,
      kernelInstanceId: 'dead-kernel',
      startedAt: 'provably-not-the-current-process',
      hostname: hostname()
    })

    const lock = await acquireSessionWriterLock({
      path,
      kernelInstanceId: 'replacement-kernel',
      startedAt: 'test-process'
    })
    assert.equal(lock.body.kernelInstanceId, 'replacement-kernel')
    assert.deepEqual(readdirSync(join(root, 'session')), ['writer.lock'])
    await lock.release()
    assert.equal(existsSync(path), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('lock held by the current live process is rejected', async () => {
  const { root, path } = lockFixture()
  try {
    writeSessionWriterLockSync(path, {
      pid: process.pid,
      kernelInstanceId: 'live-kernel',
      // The real start token: a live holder must be recognised as live by the OS check.
      startedAt: await currentProcessStartedAt(),
      hostname: hostname()
    })

    await assert.rejects(
      acquireSessionWriterLock({ path, kernelInstanceId: 'contender-kernel' }),
      SessionWriterBusyError
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('lock from a foreign host is never stolen even when its pid is absent locally', async () => {
  const { root, path } = lockFixture()
  try {
    writeSessionWriterLockSync(path, {
      pid: 2_147_483_647,
      kernelInstanceId: 'foreign-kernel',
      startedAt: 'foreign-start-time',
      hostname: `${hostname()}-foreign`
    })

    await assert.rejects(
      acquireSessionWriterLock({
        path,
        kernelInstanceId: 'local-contender',
        startedAt: 'test-process'
      }),
      SessionWriterBusyError
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
