import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  buildRemoteRuntimeRootCheckScript,
  checkRemoteRuntimeRoot,
  DEFAULT_REMOTE_RUNTIME_ROOT_CHECK_TIMEOUT_MS,
  parseRemoteRuntimeRootCheck
} from '../src/main/agent/workspace-host/runtime-root-check'
import type { RemoteExecResult } from '../src/main/agent/wrappers/remote-ssh-session'
import { runtimeRootCapabilityProfile } from '../src/main/agent/workspace-host/runtime-root-profile'
import { createLocalShellSession, type LocalShellSession } from './helpers/localShellSession'

function runWithInput(command: string, input: string, home?: string): Promise<RemoteExecResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      env: home ? { ...process.env, HOME: home } : process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }))
    child.stdin.end(input)
  })
}

function localSession(home?: string): LocalShellSession {
  const session = createLocalShellSession()
  session.execWithInput = (command, input) => {
    session.commands.push(command)
    return runWithInput(command, input, home)
  }
  return session
}

const START = '__PHI_RUNTIME_ROOT_CHECK_V1_BEGIN__'
const END = '__PHI_RUNTIME_ROOT_CHECK_V1_END__'

function output(rows: readonly string[]): string {
  return `login banner\n${START}\n${rows.join('\n')}\nprobe.complete=1\n${END}\nlogout noise`
}

function successfulRows(overrides: readonly string[] = []): readonly string[] {
  return [
    'path.expanded=/safe/runtime',
    'path.exists=1',
    'path.ancestor=/safe/runtime',
    'path.ancestor_writable=1',
    'path.owned=1',
    'path.group_or_other_writable=0',
    'path.symlink=0',
    'path.executable=1',
    'path.write_capacity=ok',
    'fs.type=ext4',
    'fs.available_kib=20000000',
    'fs.disk_use_percent=20',
    'fs.inode_use_percent=10',
    'fs.shared=0',
    'cache.entry_count=3',
    'cache.bytes=4096',
    ...overrides
  ]
}

describe('remote runtime root check', () => {
  it('checks a missing root from its nearest existing ancestor without creating it', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'phi-runtime-root-'))
    const configuredRoot = join(parent, 'missing', 'runtime')
    const canonicalRoot = join(await realpath(parent), 'missing', 'runtime')
    const session = localSession()

    try {
      const result = await checkRemoteRuntimeRoot(session, configuredRoot)

      assert.equal(result.status, 'checked')
      assert.equal(result.expandedPath, canonicalRoot)
      assert.equal(result.exists, false)
      assert.equal(result.nearestExistingAncestor, await realpath(parent))
      assert.equal(result.ancestorWritable, true)
      assert.equal(result.hardErrors.length, 0)
      assert.equal(session.commands.at(-1), 'sh -s')
      assert.deepEqual(await readdir(parent), [])
    } finally {
      await session.close()
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('bounds a slow capacity probe, degrades it to unknown, and removes every probe file', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'phi-runtime-root-slow-probe-'))
    const configuredRoot = join(parent, 'missing', 'runtime')
    const session = localSession()
    const script = buildRemoteRuntimeRootCheckScript(configuredRoot)
    const startedAt = Date.now()

    try {
      const result = await checkRemoteRuntimeRoot(session, configuredRoot, {
        capacityProbeDelaySeconds: 2,
        capacityProbeTimeoutSeconds: 1,
        timeoutMs: 5_000
      })

      assert.equal(DEFAULT_REMOTE_RUNTIME_ROOT_CHECK_TIMEOUT_MS, 30_000)
      assert.match(script, /phi_capacity_index[^\n]*-le 8/u)
      assert.doesNotMatch(script, /-le 200/u)
      assert.ok(Date.now() - startedAt < 2_500)
      assert.equal(result.status, 'checked')
      assert.equal(result.writeCapacity, null)
      assert.deepEqual(result.hardErrors, [])
      assert.deepEqual(await readdir(parent), [])
    } finally {
      await session.close()
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('expands ~/ against the remote HOME supplied to the shell', async () => {
    const home = await mkdtemp(join(tmpdir(), 'phi-runtime-home-'))
    const session = localSession(home)

    try {
      const result = await checkRemoteRuntimeRoot(session, '~/.phi/runtime')

      assert.equal(result.status, 'checked')
      assert.equal(result.expandedPath, join(await realpath(home), '.phi', 'runtime'))
      assert.equal(result.nearestExistingAncestor, await realpath(home))
      assert.equal(result.exists, false)
      assert.deepEqual(await readdir(home), [])
    } finally {
      await session.close()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('returns a canonical path when missing path segments contain a dot', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'phi-runtime-dot-'))
    const configuredRoot = `${parent}/missing/./runtime`
    const session = localSession()

    try {
      const result = await checkRemoteRuntimeRoot(session, configuredRoot)

      assert.equal(result.expandedPath, join(await realpath(parent), 'missing', 'runtime'))
    } finally {
      await session.close()
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('passes a configured path containing a shell quote as stdin data', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'phi-runtime-quote-'))
    const configuredRoot = join(parent, "researcher's runtime")
    const session = localSession()

    try {
      const result = await checkRemoteRuntimeRoot(session, configuredRoot)

      assert.equal(result.status, 'checked')
      assert.equal(result.expandedPath, join(await realpath(parent), "researcher's runtime"))
      assert.equal(result.hardErrors.length, 0)
    } finally {
      await session.close()
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('detects an existing root reached through a symbolic link', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'phi-runtime-symlink-'))
    const target = join(parent, 'target')
    const linked = join(parent, 'linked')
    await mkdir(target)
    await symlink(target, linked)
    const session = localSession()

    try {
      const result = await checkRemoteRuntimeRoot(session, linked)

      assert.equal(result.status, 'checked')
      assert.equal(result.exists, true)
      assert.equal(result.expandedPath, await realpath(target))
      assert.equal(result.hasSymlink, true)
      assert.ok(result.warnings.some(({ code }) => code === 'symlink'))
    } finally {
      await session.close()
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('turns unsafe and constrained filesystem facts into stable soft warnings', () => {
    const result = parseRemoteRuntimeRootCheck(
      output([
        'path.expanded=/cluster/home/example/.phi/runtime',
        'path.exists=1',
        'path.ancestor=/cluster/home/example/.phi/runtime',
        'path.ancestor_writable=1',
        'path.owned=0',
        'path.group_or_other_writable=1',
        'path.symlink=1',
        'path.executable=0',
        'path.write_capacity=ok',
        'fs.type=nfs4',
        'fs.available_kib=1024',
        'fs.disk_use_percent=95',
        'fs.inode_use_percent=42',
        'fs.shared=1',
        'cache.entry_count=2',
        'cache.bytes=2048'
      ]),
      '~/.phi/runtime'
    )

    assert.equal(result.status, 'checked')
    assert.equal(result.fsType, 'nfs4')
    assert.equal(result.computeNodeVisibility, 'unknown')
    assert.deepEqual(
      result.warnings.map(({ code }) => code),
      [
        'not-owned',
        'group-or-other-writable',
        'symlink',
        'low-space',
        'high-disk-use',
        'noexec',
        'shared-filesystem-info'
      ]
    )
    assert.ok(result.warnings.every(({ message, consequence }) => message && consequence))
  })

  it('uses configurable space and disk-use warning thresholds', () => {
    const result = parseRemoteRuntimeRootCheck(
      output(successfulRows(['fs.available_kib=1500', 'fs.disk_use_percent=80'])),
      '/runtime',
      { lowSpaceKiB: 2000, highDiskUsePercent: 80 }
    )

    assert.deepEqual(
      result.warnings.map(({ code }) => code),
      ['low-space', 'high-disk-use']
    )
  })

  it('reports an unwritable nearest ancestor as a hard error', () => {
    const result = parseRemoteRuntimeRootCheck(
      output([
        'path.expanded=/readonly/runtime',
        'path.exists=0',
        'path.ancestor=/readonly',
        'path.ancestor_writable=0',
        'hard.error=ancestor-not-writable'
      ]),
      '/readonly/runtime'
    )

    assert.equal(result.ancestorWritable, false)
    assert.deepEqual(
      result.hardErrors.map(({ code }) => code),
      ['ancestor-not-writable']
    )
  })

  it('reports quota and no-space capacity failures as a hard error and cleans the probe', async () => {
    for (const [mode, capacity] of [
      ['edquot', 'quota-exceeded'],
      ['no-space', 'no-space']
    ] as const) {
      const parent = await mkdtemp(join(tmpdir(), `phi-runtime-${mode}-`))
      const session = localSession()

      try {
        const result = await checkRemoteRuntimeRoot(session, join(parent, 'runtime'), {
          capacityProbeFailureMode: mode
        })

        assert.equal(result.status, 'checked')
        assert.equal(result.writeCapacity, capacity)
        assert.deepEqual(
          result.hardErrors.map(({ code }) => code),
          ['write-capacity-exhausted']
        )
        assert.match(
          result.hardErrors[0]?.message ?? '',
          /服务器上该位置的写入空间或文件数配额已用尽；请在 设置 → 远程主机 把运行时目录改到有空间的位置（例如工作区所在文件系统），或清理旧环境/
        )
        assert.deepEqual(await readdir(parent), [])
      } finally {
        await session.close()
        await rm(parent, { recursive: true, force: true })
      }
    }
  })

  it('treats read-only as a hard capacity error but leaves unknown failures non-blocking', async () => {
    for (const mode of ['read-only', 'other'] as const) {
      const parent = await mkdtemp(join(tmpdir(), `phi-runtime-${mode}-`))
      const session = localSession()

      try {
        const result = await checkRemoteRuntimeRoot(session, join(parent, 'runtime'), {
          capacityProbeFailureMode: mode
        })

        assert.equal(result.status, 'checked')
        assert.equal(result.writeCapacity, mode)
        assert.deepEqual(
          result.hardErrors.map(({ code }) => code),
          mode === 'read-only' ? ['write-capacity-exhausted'] : []
        )
        assert.deepEqual(await readdir(parent), [])
      } finally {
        await session.close()
        await rm(parent, { recursive: true, force: true })
      }
    }
  })

  it('reports package-cache entries and preserves the count when byte sizing is unavailable', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'phi-runtime-cache-'))
    const root = join(parent, 'runtime')
    const cache = join(root, 'pkgs')
    const session = localSession()
    await mkdir(join(cache, 'extracted-package'), { recursive: true })
    await writeFile(join(cache, 'package.tar.bz2'), 'cached package')

    try {
      const result = await checkRemoteRuntimeRoot(session, root)

      assert.equal(result.status, 'checked')
      assert.equal(result.packageCache.entryCount, 2)
      assert.ok(result.packageCache.bytes === null || result.packageCache.bytes > 0)
      assert.deepEqual(await readdir(root), ['pkgs'])
      assert.deepEqual(await readdir(parent), ['runtime'])
    } finally {
      await session.close()
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('parses cache bytes when available and keeps them nullable after a du timeout', () => {
    const sized = parseRemoteRuntimeRootCheck(output(successfulRows()), '/runtime')
    const timedOut = parseRemoteRuntimeRootCheck(
      output(successfulRows().filter((row) => !row.startsWith('cache.bytes='))),
      '/runtime'
    )

    assert.deepEqual(sized.packageCache, { entryCount: 3, bytes: 4096 })
    assert.deepEqual(timedOut.packageCache, { entryCount: 3, bytes: null })
    assert.deepEqual(runtimeRootCapabilityProfile('host', timedOut).packageCache, {
      entryCount: 3,
      bytes: null
    })
  })

  it('detects an unwritable real ancestor without creating the runtime root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'phi-runtime-readonly-'))
    const configuredRoot = join(parent, 'missing', 'runtime')
    const session = localSession()
    await chmod(parent, 0o555)

    try {
      const result = await checkRemoteRuntimeRoot(session, configuredRoot)

      assert.equal(result.exists, false)
      assert.equal(result.ancestorWritable, false)
      assert.deepEqual(
        result.hardErrors.map(({ code }) => code),
        ['ancestor-not-writable']
      )
      assert.deepEqual(await readdir(parent), [])
    } finally {
      await chmod(parent, 0o755)
      await session.close()
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('detects a real group-or-other-writable ancestor as a soft warning', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'phi-runtime-shared-'))
    const session = localSession()
    await chmod(parent, 0o777)

    try {
      const result = await checkRemoteRuntimeRoot(session, join(parent, 'runtime'))

      assert.equal(result.groupOrOtherWritable, true)
      assert.ok(result.warnings.some(({ code }) => code === 'group-or-other-writable'))
      assert.equal(result.hardErrors.length, 0)
    } finally {
      await chmod(parent, 0o755)
      await session.close()
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('rejects invalid configured roots before executing a remote command', async () => {
    const invalidRoots = ['', 'relative/path', '/safe/../escape', '/line\nbreak', '/nul\0byte']
    let executions = 0
    const session = {
      async execWithInput(): Promise<RemoteExecResult> {
        executions += 1
        return { stdout: '', stderr: '', code: 0, signal: null }
      }
    }

    for (const configured of invalidRoots) {
      const result = await checkRemoteRuntimeRoot(session, configured)
      assert.equal(result.status, 'checked')
      assert.deepEqual(
        result.hardErrors.map(({ code }) => code),
        ['invalid-configured-root']
      )
    }
    assert.equal(executions, 0)
  })

  it('reports an unexpandable remote HOME as a hard error', async () => {
    const session = localSession('relative-home')

    try {
      const result = await checkRemoteRuntimeRoot(session, '~/runtime')

      assert.equal(result.status, 'checked')
      assert.deepEqual(
        result.hardErrors.map(({ code }) => code),
        ['unable-to-expand']
      )
      assert.equal(result.expandedPath, null)
    } finally {
      await session.close()
    }
  })

  it('ignores login noise but treats missing or truncated sentinel blocks as incomplete', () => {
    const complete = parseRemoteRuntimeRootCheck(output(successfulRows()), '/safe/runtime')
    const missing = parseRemoteRuntimeRootCheck('login banner\npath.exists=1', '/safe/runtime')
    const truncated = parseRemoteRuntimeRootCheck(
      `${START}\npath.expanded=/private/leak\npath.exists=1`,
      '/safe/runtime'
    )
    const missingRows = parseRemoteRuntimeRootCheck(
      output(['path.expanded=/safe/runtime', 'path.exists=1']),
      '/safe/runtime'
    )

    assert.equal(complete.status, 'checked')
    assert.equal(complete.expandedPath, '/safe/runtime')
    for (const result of [missing, truncated, missingRows]) {
      assert.equal(result.status, 'incomplete')
      assert.equal(result.expandedPath, null)
      assert.equal(result.exists, null)
      assert.deepEqual(result.warnings, [])
    }
  })

  it('distinguishes an internal timeout from a failed remote check', async () => {
    const timeout = await checkRemoteRuntimeRoot(
      { execWithInput: () => new Promise(() => undefined) },
      '/runtime',
      { timeoutMs: 10 }
    )
    const failed = await checkRemoteRuntimeRoot(
      {
        async execWithInput() {
          return { stdout: output(['path.exists=1']), stderr: '', code: 1, signal: null }
        }
      },
      '/runtime'
    )

    assert.equal(timeout.status, 'timed-out')
    assert.equal(failed.status, 'failed')
    assert.equal(timeout.exists, null)
    assert.equal(failed.exists, null)
  })
})
