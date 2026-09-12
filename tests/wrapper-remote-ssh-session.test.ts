import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildExistsCommand,
  buildMkdirpCommand,
  buildReadTextFileCommand,
  buildSession,
  buildTruncateLastByteCommand,
  buildWriteTextFileCommand,
  shellQuote
} from '../src/main/agent/wrappers/remote-ssh-session'
import type { Client } from 'ssh2'

/**
 * Runs a command exactly the way `remote-ssh-session.ts`'s real `exec()`
 * would send it to the remote shell — but through a REAL local `bash`,
 * not the in-memory fakes every other test in this suite uses. That
 * distinction matters: this project shipped with a fatal `& &&` bash
 * syntax error in `buildDetachedLaunchCommand` and a file-corrupting bug
 * in the heredoc writer, and 494 passing tests caught neither, because no
 * test had ever actually executed a generated command string. These tests
 * exist specifically to close that gap — see remote-ssh-session.ts's
 * `buildWriteTextFileCommand` doc comment for the bug this caught.
 */
function runInRealBash(command: string): { stdout: string; code: number } {
  try {
    const stdout = execSync(command, { shell: '/bin/bash', encoding: 'utf-8' })
    return { stdout, code: 0 }
  } catch (error) {
    const err = error as { stdout?: string; status?: number }
    return { stdout: err.stdout ?? '', code: err.status ?? 1 }
  }
}

function withTempDir<T>(callback: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'phi-remote-ssh-session-realbash-'))
  try {
    return callback(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('every generated command is syntactically valid bash (bash -n)', () => {
  withTempDir((dir) => {
    const path = join(dir, 'file.txt')
    const commands = [
      buildMkdirpCommand(dir),
      buildExistsCommand(path),
      buildReadTextFileCommand(path),
      buildWriteTextFileCommand(path, 'hello\n').script,
      buildTruncateLastByteCommand(path)
    ]
    for (const command of commands) {
      const result = runInRealBash(`bash -n -c ${shellQuote(command)}`)
      assert.equal(result.code, 0, `expected valid syntax for: ${command}`)
    }
  })
})

test('buildMkdirpCommand actually creates the directory when run', () => {
  withTempDir((dir) => {
    const nested = join(dir, 'a', 'b', 'c')
    const result = runInRealBash(buildMkdirpCommand(nested))
    assert.equal(result.code, 0)
    assert.equal(runInRealBash(buildExistsCommand(nested)).code, 0)
  })
})

test('buildExistsCommand reports true/false via exit code, matching RemoteSshSession.exists', () => {
  withTempDir((dir) => {
    assert.equal(runInRealBash(buildExistsCommand(dir)).code, 0)
    assert.equal(runInRealBash(buildExistsCommand(join(dir, 'nope'))).code, 1)
  })
})

const CONTENT_CASES: Record<string, string> = {
  trailingNewline: `line with 'quotes'\nand a $VAR and \`backticks\` and "double quotes"\n`,
  noTrailingNewline: 'no trailing newline here',
  emptyString: '',
  multipleTrailingNewlines: 'a\nb\n\n\n',
  jsonLike: `${JSON.stringify({ a: 1, b: [1, 2, 3] }, null, 2)}\n`,
  containsHeredocMarkerLiterally: 'before\n__PHI_EOF__\nafter\n'
}

for (const [label, content] of Object.entries(CONTENT_CASES)) {
  test(`writeTextFile's generated commands round-trip byte-for-byte in a real shell: ${label}`, () => {
    withTempDir((dir) => {
      const path = join(dir, 'file.txt')
      const { script, needsTruncate } = buildWriteTextFileCommand(path, content)

      const writeResult = runInRealBash(script)
      assert.equal(writeResult.code, 0, `write failed: ${writeResult.stdout}`)

      if (needsTruncate) {
        const truncateResult = runInRealBash(buildTruncateLastByteCommand(path))
        assert.equal(truncateResult.code, 0)
      }

      const readResult = runInRealBash(buildReadTextFileCommand(path))
      assert.equal(readResult.code, 0)
      assert.equal(readResult.stdout, content)
      // Cross-check against the filesystem directly too, not just `cat`'s stdout.
      assert.equal(readFileSync(path, 'utf-8'), content)
    })
  })
}

test('shellQuote neutralizes command substitution and expansion attempts', () => {
  withTempDir((dir) => {
    const maliciousLookingContent = '$(touch pwned); `touch pwned2`; $HOME; ${PATH}'
    const path = join(dir, 'file.txt')
    const { script } = buildWriteTextFileCommand(path, `${maliciousLookingContent}\n`)

    runInRealBash(script)

    assert.equal(runInRealBash(buildExistsCommand(join(dir, 'pwned'))).code, 1)
    assert.equal(runInRealBash(buildExistsCommand(join(dir, 'pwned2'))).code, 1)
    assert.equal(readFileSync(path, 'utf-8'), `${maliciousLookingContent}\n`)
  })
})

// --- exec() timeout ---------------------------------------------------
//
// Found by actually running this code against a real (flaky) cluster
// network: when the underlying connection goes half-open mid-command (TCP
// still "open" per the OS, but no data flowing), ssh2 never fires `close`
// on the exec channel — the old code's exec() promise hung forever, no
// error, no timeout, nothing. `readyTimeoutMs` only ever bounded the
// initial handshake. These tests drive `buildSession` directly against a
// minimal fake `Client` so the hang scenario is reproducible without a
// real flaky network.

interface FakeStreamControls {
  stream: unknown
  emitData: (chunk: Buffer) => void
  emitClose: (code: number | null, signal: string | null) => void
}

function makeFakeStream(): FakeStreamControls {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {}
  const stderrHandlers: Record<string, Array<(...args: unknown[]) => void>> = {}
  const stderr = {
    on(event: string, cb: (...args: unknown[]) => void) {
      ;(stderrHandlers[event] ??= []).push(cb)
      return stderr
    }
  }
  const stream = {
    on(event: string, cb: (...args: unknown[]) => void) {
      ;(handlers[event] ??= []).push(cb)
      return stream
    },
    stderr
  }
  return {
    stream,
    emitData: (chunk) => handlers.data?.forEach((cb) => cb(chunk)),
    emitClose: (code, signal) => handlers.close?.forEach((cb) => cb(code, signal))
  }
}

function makeFakeClient(
  execImpl: (command: string, callback: (err: Error | undefined, stream: unknown) => void) => void
): Client {
  const fakeClient = {
    exec: execImpl,
    once: () => fakeClient,
    end: () => true
  }
  return fakeClient as unknown as Client
}

test('exec() rejects with a clear error instead of hanging forever when client.exec itself never calls back', async () => {
  const client = makeFakeClient(() => {
    // Simulates the exec REQUEST itself getting lost on a dead connection.
  })
  const session = buildSession(client, 50)

  await assert.rejects(() => session.exec('echo hi'), /远程命令执行超时/)
})

test('exec() rejects with a clear error instead of hanging forever when the channel opens but never closes', async () => {
  const client = makeFakeClient((_command, callback) => {
    const { stream } = makeFakeStream()
    // Simulates the connection dying after the channel opened but before
    // the command finished — exactly what was observed against a real
    // cluster: `close` never fires.
    callback(undefined, stream)
  })
  const session = buildSession(client, 50)

  await assert.rejects(() => session.exec('echo hi'), /远程命令执行超时/)
})

test('exec() still resolves normally well within the timeout, and clears its timer', async () => {
  const client = makeFakeClient((_command, callback) => {
    const controls = makeFakeStream()
    callback(undefined, controls.stream)
    controls.emitData(Buffer.from('hello\n'))
    controls.emitClose(0, null)
  })
  const session = buildSession(client, 10_000)

  const result = await session.exec('echo hello')
  assert.deepEqual(result, { stdout: 'hello\n', stderr: '', code: 0, signal: null })
})

test('exec() does not throw or double-settle if a close event arrives after the timeout already fired', async () => {
  let lateClose: (() => void) | undefined
  const client = makeFakeClient((_command, callback) => {
    const controls = makeFakeStream()
    callback(undefined, controls.stream)
    lateClose = () => controls.emitClose(0, null)
  })
  const session = buildSession(client, 20)

  await assert.rejects(() => session.exec('echo hi'), /远程命令执行超时/)
  // Should be a silent no-op, not an unhandled rejection or a crash.
  assert.doesNotThrow(() => lateClose?.())
})
