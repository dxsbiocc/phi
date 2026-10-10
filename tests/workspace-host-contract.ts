import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type { WorkspaceHost } from '../src/main/agent/workspace-host/types'

export type WorkspaceHostFactory = (root: string) => WorkspaceHost | Promise<WorkspaceHost>

async function casLockPath(root: string, file: string): Promise<string> {
  const target = join(await realpath(root), file)
  const lockHash = createHash('sha256').update(target).digest('hex').slice(0, 32)
  return join(root, `.phi-cas-${lockHash}.lock`)
}

async function writeWhenStagingAppears(root: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    const entries = await readdir(root)
    if (entries.some((name) => name.startsWith('.phi-write-') || name.startsWith('.phi-edit-'))) {
      await writeFile(target, 'external')
      return
    }
    await delay(1)
  }
  throw new Error('timed out waiting for atomic write staging')
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await readFile(path, 'utf8').catch(() => '')
    if (value) return value
    await delay(20)
  }
  throw new Error(`timed out waiting for ${path}`)
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processExists(pid)) return
    await delay(20)
  }
  assert.fail(`process ${pid} survived background termination`)
}

function atomicWriteContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host atomically writes only the expected file version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-write-'))
    try {
      const host = await makeHost(root)
      const first = await host.fs.writeAtomic('result.txt', 'first')
      const second = await host.fs.writeAtomic('result.txt', 'second', {
        expectedHash: first.hash
      })

      assert.notEqual(second.hash, first.hash)
      assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'second')
      await assert.rejects(
        host.fs.writeAtomic('result.txt', 'stale', { expectedHash: first.hash }),
        {
          code: 'HASH_MISMATCH'
        }
      )
      assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'second')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

function concurrentAtomicWriteContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host lets only one concurrent expected-hash write win', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-cas-'))
    let host: WorkspaceHost | undefined
    let peer: WorkspaceHost | undefined
    try {
      host = await makeHost(root)
      const first = await host.fs.writeAtomic('result.txt', 'first')
      peer = await makeHost(root)
      let expectedHash = first.hash
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const contents = [`left-${attempt}`, `right-${attempt}`]
        const outcomes = await Promise.allSettled(
          contents.map((content, index) =>
            (index === 0 ? host : peer).fs.writeAtomic('result.txt', content, { expectedHash })
          )
        )
        const fulfilled = outcomes
          .map((outcome, index) => ({ outcome, index }))
          .filter((item) => item.outcome.status === 'fulfilled')
        const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')

        assert.equal(fulfilled.length, 1)
        assert.equal(rejected.length, 1)
        assert.equal((rejected[0] as PromiseRejectedResult).reason.code, 'HASH_MISMATCH')
        const winner = fulfilled[0]
        assert.ok(winner)
        assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), contents[winner.index])
        if (winner.outcome.status !== 'fulfilled') assert.fail('expected one successful CAS write')
        expectedHash = winner.outcome.value.hash
      }
    } finally {
      await peer?.close?.()
      await host?.close?.()
      await rm(root, { recursive: true, force: true })
    }
  })
}

function malformedAtomicWriteLockContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host rejects a malformed stale CAS lock without spinning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-cas-lock-'))
    let host: WorkspaceHost | undefined
    try {
      host = await makeHost(root)
      const first = await host.fs.writeAtomic('result.txt', 'first')
      const target = join(await realpath(root), 'result.txt')
      const lockPath = await casLockPath(root, 'result.txt')
      await mkdir(lockPath)
      await writeFile(join(lockPath, 'unexpected'), 'malformed')
      const stale = new Date(Date.now() - 180_000)
      await utimes(lockPath, stale, stale)
      const started = performance.now()

      await assert.rejects(
        host.fs.writeAtomic('result.txt', 'second', { expectedHash: first.hash })
      )
      assert.ok(performance.now() - started < 2_000)
      assert.equal(await readFile(target, 'utf8'), 'first')
    } finally {
      await host?.close?.()
      await rm(root, { recursive: true, force: true })
    }
  })
}

function activeAtomicWriteLockContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host never steals an old lock from a live owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-live-cas-lock-'))
    let host: WorkspaceHost | undefined
    try {
      host = await makeHost(root)
      const first = await host.fs.writeAtomic('result.txt', 'first')
      const lockPath = await casLockPath(root, 'result.txt')
      await mkdir(lockPath)
      await writeFile(join(lockPath, 'owner'), `${process.pid}:test-owner\n`)
      const old = new Date(Date.now() - 180_000)
      await utimes(lockPath, old, old)

      const pending = host.fs.writeAtomic('result.txt', 'second', { expectedHash: first.hash })
      await delay(100)
      const beforeRelease = await readFile(join(root, 'result.txt'), 'utf8')
      await rm(lockPath, { recursive: true, force: true })
      await pending

      assert.equal(beforeRelease, 'first')
      assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'second')
    } finally {
      await host?.close?.()
      await rm(root, { recursive: true, force: true })
    }
  })
}

function externalAtomicWriteConflictContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host preserves an external write made while staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-external-cas-'))
    let host: WorkspaceHost | undefined
    const target = join(root, 'result.txt')
    try {
      host = await makeHost(root)
      const first = await host.fs.writeAtomic('result.txt', 'first')
      const externalWrite = writeWhenStagingAppears(root, target)
      const pending = host.fs.writeAtomic('result.txt', 'x'.repeat(1024 * 1024), {
        expectedHash: first.hash
      })

      await externalWrite
      await assert.rejects(pending, { code: 'HASH_MISMATCH' })
      assert.equal(await readFile(target, 'utf8'), 'external')
    } finally {
      await host?.close?.()
      await rm(root, { recursive: true, force: true })
    }
  })
}

function rangeReadContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host reads an exact byte range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-range-'))
    try {
      await writeFile(join(root, 'data.bin'), Buffer.from('0123456789'))
      const host = await makeHost(root)

      assert.deepEqual(await host.fs.readRange('data.bin', { offset: 3, length: 4 }), {
        content: Buffer.from('3456'),
        bytesRead: 4,
        eof: false
      })
      assert.deepEqual(await host.fs.readRange('data.bin', { offset: 8, length: 8 }), {
        content: Buffer.from('89'),
        bytesRead: 2,
        eof: true
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

function listContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host lists directories with stable pagination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-list-'))
    try {
      await Promise.all([
        writeFile(join(root, 'beta.txt'), 'b'),
        writeFile(join(root, 'alpha.txt'), 'a'),
        writeFile(join(root, 'ä.txt'), 'unicode'),
        mkdir(join(root, 'nested'))
      ])
      const host = await makeHost(root)
      const first = await host.fs.list('.', { limit: 2 })
      const second = await host.fs.list('.', { limit: 2, cursor: first.nextCursor })

      assert.deepEqual(
        first.entries.map((entry) => [entry.name, entry.kind]),
        [
          ['alpha.txt', 'file'],
          ['beta.txt', 'file']
        ]
      )
      assert.equal(typeof first.nextCursor, 'string')
      assert.deepEqual(
        second.entries.map((entry) => [entry.name, entry.kind]),
        [
          ['nested', 'directory'],
          ['ä.txt', 'file']
        ]
      )
      assert.equal(second.nextCursor, undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

function globContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host globs nested files with stable relative paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-glob-'))
    try {
      await mkdir(join(root, 'nested', 'deeper'), { recursive: true })
      await Promise.all([
        writeFile(join(root, 'nested', 'one.txt'), 'one'),
        writeFile(join(root, 'nested', 'deeper', 'two.txt'), 'two'),
        writeFile(join(root, 'nested', 'skip.md'), 'skip')
      ])
      const host = await makeHost(root)

      assert.deepEqual(await host.fs.glob('**/*.txt'), ['nested/deeper/two.txt', 'nested/one.txt'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

function outputContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host bounds combined command output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-output-'))
    try {
      const host = await makeHost(root)
      const result = await host.exec.run(
        [
          process.execPath,
          '-e',
          "process.stdout.write('abcdefgh'); process.stderr.write('ijklmnop')"
        ],
        { cwd: '.', maxOutputBytes: 10 }
      )

      assert.equal(result.code, 0)
      assert.equal(result.signal, null)
      assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 10)
      assert.equal(result.truncated, true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

function timeoutContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host terminates commands after their timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-timeout-'))
    try {
      const host = await makeHost(root)
      const commandRuntimeMs = 60_000
      const timeoutMs = 300
      const terminationBoundMs = Math.min(commandRuntimeMs / 6, timeoutMs * 30)
      const started = performance.now()
      const result = await host.exec.run(
        [process.execPath, '-e', `setTimeout(() => undefined, ${commandRuntimeMs})`],
        { cwd: '.', timeoutMs }
      )
      const elapsedMs = performance.now() - started

      assert.equal(result.code, null)
      assert.ok(result.signal)
      assert.ok(
        elapsedMs < terminationBoundMs,
        `expected the ${timeoutMs}ms timeout to terminate the ${commandRuntimeMs}ms command ` +
          `within ${terminationBoundMs}ms, took ${elapsedMs}ms`
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

function cancellationContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host cancels commands through AbortSignal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-cancel-'))
    try {
      const host = await makeHost(root)
      const controller = new AbortController()
      const pending = host.exec.run(
        [process.execPath, '-e', 'setTimeout(() => undefined, 10_000)'],
        { cwd: '.', signal: controller.signal }
      )
      setTimeout(() => controller.abort(), 80)
      const result = await pending

      assert.equal(result.code, null)
      assert.ok(result.signal)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

function backgroundContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host terminates the entire background process group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-background-'))
    let handle: Awaited<ReturnType<WorkspaceHost['exec']['spawnBackground']>> | undefined
    let grandchildPid: number | undefined
    try {
      const host = await makeHost(root)
      const pidPath = join(root, 'grandchild.pid')
      const source = [
        "const { spawn } = require('node:child_process')",
        "const { writeFileSync } = require('node:fs')",
        "const grandchild = [\"const { writeFileSync } = require('node:fs')\", \"process.on('SIGTERM', () => {})\", 'writeFileSync(process.argv[1], String(process.pid))', 'setInterval(() => {}, 1000)'].join(';')",
        "spawn(process.execPath, ['-e', grandchild, process.argv[1]], { stdio: 'ignore' })",
        'setInterval(() => {}, 1000)'
      ].join(';')
      handle = await host.exec.spawnBackground([process.execPath, '-e', source, pidPath], {
        cwd: '.',
        maxOutputBytes: 1024
      })
      grandchildPid = Number(await waitForFile(pidPath))

      assert.equal((await handle.query()).running, true)
      const result = await handle.terminate()
      await waitForProcessExit(grandchildPid)
      assert.equal(result.code, null)
      assert.ok(result.signal)
      assert.equal((await handle.query()).running, false)
    } finally {
      await handle?.terminate().catch(() => undefined)
      if (grandchildPid && processExists(grandchildPid)) {
        try {
          process.kill(grandchildPid, 'SIGKILL')
        } catch {
          // The process exited between the liveness check and cleanup.
        }
      }
      await rm(root, { recursive: true, force: true })
    }
  })
}

function lifecycleContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host creates, stats, and removes workspace entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-lifecycle-'))
    try {
      const host = await makeHost(root)
      await host.fs.mkdirp('nested/deeper')
      await host.fs.writeAtomic('nested/deeper/value.txt', 'value')

      assert.deepEqual(await host.fs.stat('nested/deeper/value.txt'), {
        kind: 'file',
        size: 5
      })
      assert.equal((await host.fs.stat('nested')).kind, 'directory')
      await host.fs.remove('nested', { recursive: true })
      await assert.rejects(access(join(root, 'nested')))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

function modifiedAtContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host exposes mtime only when requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-mtime-'))
    try {
      await writeFile(join(root, 'value.txt'), 'value')
      const host = await makeHost(root)

      assert.equal((await host.fs.stat('value.txt')).modifiedAt, undefined)
      const modifiedAt = (await host.fs.stat('value.txt', { includeModifiedAt: true })).modifiedAt
      assert.equal(typeof modifiedAt, 'string')
      assert.ok(Number.isFinite(Date.parse(modifiedAt ?? '')))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

function pathBoundaryContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host rejects paths outside its root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'phi-workspace-host-outside-'))
    try {
      const host = await makeHost(root)
      const file = join(outside, 'outside.txt')
      await writeFile(file, 'outside')

      await assert.rejects(host.fs.readRange(file, { offset: 0, length: 1 }), {
        code: 'PATH_OUTSIDE_ROOT'
      })
      await assert.rejects(host.fs.writeAtomic(file, 'changed'), { code: 'PATH_OUTSIDE_ROOT' })
      await assert.rejects(host.fs.list(outside), { code: 'PATH_OUTSIDE_ROOT' })
      await assert.rejects(host.fs.glob('**/*', { cwd: outside }), {
        code: 'PATH_OUTSIDE_ROOT'
      })
      await assert.rejects(host.fs.mkdirp(join(outside, 'created')), {
        code: 'PATH_OUTSIDE_ROOT'
      })
      await assert.rejects(host.fs.remove(file), { code: 'PATH_OUTSIDE_ROOT' })
      await assert.rejects(host.fs.stat(file), { code: 'PATH_OUTSIDE_ROOT' })
      await assert.rejects(host.exec.run([process.execPath, '-e', ''], { cwd: outside }), {
        code: 'PATH_OUTSIDE_ROOT'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
}

function linkBoundaryContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host rejects symbolic links that escape its root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-link-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'phi-workspace-host-link-outside-'))
    try {
      const host = await makeHost(root)
      await writeFile(join(outside, 'secret.txt'), 'secret')
      await symlink(outside, join(root, 'escape'))

      await assert.rejects(host.fs.readRange('escape/secret.txt', { offset: 0, length: 6 }), {
        code: 'PATH_OUTSIDE_ROOT'
      })
      await assert.rejects(host.fs.writeAtomic('escape/new.txt', 'escaped'), {
        code: 'PATH_OUTSIDE_ROOT'
      })
      await assert.rejects(host.fs.list('escape'), { code: 'PATH_OUTSIDE_ROOT' })
      await assert.rejects(host.fs.glob('**/*', { cwd: 'escape' }), {
        code: 'PATH_OUTSIDE_ROOT'
      })
      await assert.rejects(host.fs.mkdirp('escape/new-directory'), {
        code: 'PATH_OUTSIDE_ROOT'
      })
      await assert.rejects(host.fs.remove('escape'), { code: 'PATH_OUTSIDE_ROOT' })
      await assert.rejects(host.fs.stat('escape'), { code: 'PATH_OUTSIDE_ROOT' })
      await assert.rejects(host.exec.run([process.execPath, '-e', ''], { cwd: 'escape' }), {
        code: 'PATH_OUTSIDE_ROOT'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
}

function capabilityContract(makeHost: WorkspaceHostFactory): void {
  test('workspace host reports core and optional capability states', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-capabilities-'))
    try {
      const host = await makeHost(root)
      const profile = host.capabilities()

      assert.ok(profile.platform.os)
      assert.ok(profile.platform.arch)
      assert.ok(Number.isFinite(Date.parse(profile.probedAt)))
      assert.equal(profile.fs.state, 'available')
      assert.equal(profile.exec.state, 'available')
      assert.equal(profile.background.state, 'available')
      assert.equal(profile.pty.state, 'unavailable')
      assert.equal(profile.watch.state, 'unavailable')
      assert.equal(profile.forwardPort.state, 'unavailable')
      assert.deepEqual(Object.keys(profile.toolchain).sort(), [
        'conda',
        'containerRuntime',
        'git',
        'java',
        'module',
        'nextflow',
        'sbatch'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

export function runWorkspaceHostContract(makeHost: WorkspaceHostFactory): void {
  atomicWriteContract(makeHost)
  concurrentAtomicWriteContract(makeHost)
  malformedAtomicWriteLockContract(makeHost)
  activeAtomicWriteLockContract(makeHost)
  externalAtomicWriteConflictContract(makeHost)
  rangeReadContract(makeHost)
  listContract(makeHost)
  globContract(makeHost)
  outputContract(makeHost)
  timeoutContract(makeHost)
  cancellationContract(makeHost)
  backgroundContract(makeHost)
  lifecycleContract(makeHost)
  modifiedAtContract(makeHost)
  pathBoundaryContract(makeHost)
  linkBoundaryContract(makeHost)
  capabilityContract(makeHost)
}
