import assert from 'node:assert/strict'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MAX_REMOTE_LOG_POLL_BYTES,
  readRemoteLogDelta,
  readRemoteLogTail,
  type RemoteLogCursor
} from '../src/main/agent/wrappers/remote-log'
import {
  MAX_REMOTE_LOG_RESPONSE_BYTES,
  readRemoteFileChunk
} from '../src/main/agent/wrappers/remote-ssh-log'
import { createLocalShellSession } from './helpers/localShellSession'

test('a 10 MiB log advances by byte offsets with no SSH response above 256 KiB', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-log-'))
  const path = join(root, 'big.log')
  const expected = 'x'.repeat(10 * 1024 * 1024) + '\nEND\n'
  writeFileSync(path, expected)
  const session = createLocalShellSession()
  const exec = session.exec
  let largestResponse = 0
  session.execBounded = async (command, options) => {
    const result = await exec(command)
    largestResponse = Math.max(largestResponse, Buffer.byteLength(result.stdout, 'utf8'))
    assert.ok(options.maxOutputBytes <= MAX_REMOTE_LOG_RESPONSE_BYTES)
    return { ...result, stdoutTruncated: false, stderrTruncated: false }
  }
  try {
    let cursor: RemoteLogCursor = { offset: 0 }
    const parts: string[] = []
    while (cursor.offset < Buffer.byteLength(expected)) {
      const delta = await readRemoteLogDelta(session, path, cursor)
      assert.ok(delta.bytesRead > 0)
      assert.ok(delta.bytesRead <= MAX_REMOTE_LOG_POLL_BYTES)
      parts.push(delta.text)
      cursor = delta.cursor
    }
    assert.equal(parts.join(''), expected)
    assert.equal(cursor.offset, Buffer.byteLength(expected))
    assert.ok(largestResponse <= MAX_REMOTE_LOG_RESPONSE_BYTES)
  } finally {
    await session.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a UTF-8 character split across pages and a reconnect is delivered exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-utf8-'))
  const path = join(root, 'unicode.log')
  writeFileSync(path, '甲乙丙\n')
  const firstSession = createLocalShellSession()
  try {
    const first = await readRemoteLogDelta(firstSession, path, { offset: 0 }, 4)
    assert.equal(first.text, '甲')
    assert.equal(first.cursor.offset, 4)
    assert.ok(first.cursor.pendingUtf8)
    const saved = JSON.parse(JSON.stringify(first.cursor)) as RemoteLogCursor
    await firstSession.close()
    const secondSession = createLocalShellSession()
    try {
      const second = await readRemoteLogDelta(secondSession, path, saved, 5)
      const third = await readRemoteLogDelta(secondSession, path, second.cursor, 1)
      assert.equal(first.text + second.text + third.text, '甲乙丙\n')
      assert.equal(third.cursor.offset, Buffer.byteLength('甲乙丙\n'))
      assert.equal(third.cursor.pendingUtf8, undefined)
    } finally {
      await secondSession.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('truncation and rotation reset the byte cursor with a visible diagnostic', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-rotate-'))
  const path = join(root, 'stdout.log')
  writeFileSync(path, 'before-rotation\n')
  const session = createLocalShellSession()
  try {
    const first = await readRemoteLogDelta(session, path, { offset: 0 })
    writeFileSync(path, 'new\n')
    const truncated = await readRemoteLogDelta(session, path, first.cursor)
    assert.equal(truncated.text, 'new\n')
    assert.match(truncated.diagnostics.join(''), /偏移.*超出/)
    renameSync(path, `${path}.1`)
    writeFileSync(path, 'rotated\n')
    const rotated = await readRemoteLogDelta(session, path, truncated.cursor)
    assert.equal(rotated.text, 'rotated\n')
    assert.match(rotated.diagnostics.join(''), /轮转/)
    assert.notEqual(rotated.cursor.identity, first.cursor.identity)
  } finally {
    await session.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy log tails read only the latest bounded page', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-tail-'))
  const path = join(root, 'stdout.log')
  writeFileSync(path, 'x'.repeat(10 * 1024 * 1024) + 'FINAL\n')
  const session = createLocalShellSession()
  session.readTextFile = async () => {
    throw new Error('unbounded read must not be used')
  }
  try {
    const tail = await readRemoteLogTail(session, path)
    assert.ok(Buffer.byteLength(tail) <= 195_000)
    assert.match(tail, /FINAL\n$/)
  } finally {
    await session.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a truncated transport reply is rejected without advancing the cursor', async () => {
  const fake = {
    execBounded: async () => ({
      stdout: 'PHI_LOG_V1\n',
      stderr: '',
      code: 0,
      signal: null,
      stdoutTruncated: true,
      stderrTruncated: false
    })
  } as unknown as ReturnType<typeof createLocalShellSession>
  await assert.rejects(
    readRemoteFileChunk(fake, '/cluster/stdout.log', { offset: 7, maxBytes: 20 }),
    /超过字节上限/
  )
})
