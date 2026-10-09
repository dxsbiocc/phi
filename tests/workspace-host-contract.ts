import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type { WorkspaceHost } from '../src/main/agent/workspace-host/types'

export type WorkspaceHostFactory = (root: string) => WorkspaceHost | Promise<WorkspaceHost>

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
  rangeReadContract(makeHost)
  listContract(makeHost)
  globContract(makeHost)
  outputContract(makeHost)
  timeoutContract(makeHost)
  cancellationContract(makeHost)
  backgroundContract(makeHost)
  lifecycleContract(makeHost)
  pathBoundaryContract(makeHost)
  linkBoundaryContract(makeHost)
  capabilityContract(makeHost)
}
