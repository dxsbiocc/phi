import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeHandlerError, writerBusyProtocolError } from '../src/kernel/protocol/errors'
import { acquireFromOlderBuild } from '../src/kernel/sessions/superseded-writer'
import {
  SessionWriterBusyError,
  writeSessionWriterLockSync
} from '../src/kernel/sessions/writer-lock'
import { getProviderErrorDisplay } from '../src/renderer/src/lib/providerErrors'

const OWN = '/home/u/.phi/runtime/kernel/0.1.0/new/phi-kernel'
const OLDER = '/home/u/.phi/runtime/kernel/0.1.0/old/phi-kernel'
const HOLDER = 424242

function lockedBy(t: test.TestContext, pid = HOLDER): string {
  const directory = mkdtempSync(join(tmpdir(), 'phi-superseded-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'session.lock')
  writeSessionWriterLockSync(path, {
    pid,
    kernelInstanceId: 'old-instance',
    startedAt: 'linux:1',
    hostname: hostname()
  })
  return path
}

function busyUntil(attempts: number): { acquire: () => Promise<string>; calls: () => number } {
  let calls = 0
  return {
    acquire: async () => {
      calls += 1
      if (calls <= attempts) throw new SessionWriterBusyError()
      return 'lock'
    },
    calls: () => calls
  }
}

test('a kernel of an older build is asked to release the session, then the lock is taken', async (t) => {
  const path = lockedBy(t)
  const signalled: number[] = []
  const attempt = busyUntil(2)
  const lock = await acquireFromOlderBuild(path, attempt.acquire, {
    ownExecutable: OWN,
    executableOf: async () => OLDER,
    signal: (pid) => signalled.push(pid),
    pollMs: 1,
    waitMs: 1_000
  })
  assert.equal(lock, 'lock')
  assert.deepEqual(signalled, [HOLDER])
  assert.equal(attempt.calls(), 3)
})

test('a busy older kernel keeps its session and the error names it', async (t) => {
  const path = lockedBy(t)
  const error = await acquireFromOlderBuild(path, busyUntil(Infinity).acquire, {
    ownExecutable: OWN,
    executableOf: async () => OLDER,
    signal: () => undefined,
    pollMs: 1,
    waitMs: 20
  }).catch((caught: unknown) => caught)
  assert.ok(error instanceof SessionWriterBusyError)
  const wire = normalizeHandlerError(writerBusyProtocolError(error))
  assert.equal(wire?.code, 'SESSION_BUSY')
  assert.match(wire?.message ?? '', /older Phi kernel is still running a task/)
  assert.doesNotMatch(wire?.message ?? '', /active run/)
  const display = getProviderErrorDisplay(wire?.message ?? '')
  assert.notEqual(display.description, getProviderErrorDisplay('boom').description)
})

test('a kernel of the same build, or a process that is not a kernel, is never signalled', async (t) => {
  for (const executable of [OWN, '/usr/bin/python3', undefined]) {
    const path = lockedBy(t)
    const signalled: number[] = []
    const attempt = busyUntil(Infinity)
    const error = await acquireFromOlderBuild(path, attempt.acquire, {
      ownExecutable: OWN,
      executableOf: async () => executable,
      signal: (pid) => signalled.push(pid),
      pollMs: 1,
      waitMs: 20
    }).catch((caught: unknown) => caught)
    assert.ok(error instanceof SessionWriterBusyError)
    assert.deepEqual(signalled, [])
    assert.equal(attempt.calls(), 1)
    const wire = normalizeHandlerError(writerBusyProtocolError(error))
    assert.match(wire?.message ?? '', /Another Phi kernel is using this session/)
  }
})

test('an unrelated busy error keeps the generic text', () => {
  const wire = normalizeHandlerError({
    code: 'SESSION_BUSY',
    message: 'x',
    detail: { reason: 'nope' }
  })
  assert.equal(wire?.message, 'The requested session already has an active run.')
})
