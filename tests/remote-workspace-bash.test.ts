import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Project } from '../src/main/agent/projects'
import { ensureRemoteProjectAnchor } from '../src/main/agent/remote-project-anchor'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import {
  buildRemoteBashCommand,
  RemoteWorkspaceBashManager
} from '../src/main/agent/remote-workspace-bash'
import {
  buildRemoteWorkspaceBashTool,
  PHI_REMOTE_BASH_DESCRIPTION
} from '../src/main/agent/remote-workspace-bash-tool'
import type { RemoteBashManagerDependencies } from '../src/main/agent/remote-workspace-bash'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'

function fixture(): {
  root: string
  anchor: string
  dependencies: RemoteBashManagerDependencies
  calls: string[]
  closed: () => number
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'phi-remote-bash-'))
  const agentDir = join(base, 'phi')
  const root = join(base, 'server-project')
  mkdirSync(root)
  const location = {
    kind: 'ssh' as const,
    hostProfileId: 'host-a',
    remoteRoot: root,
    canonicalRoot: realpathSync(root)
  }
  const project = {
    id: 'project-a',
    name: 'Remote',
    location,
    workingDirectory: root,
    workingDirectoryRealPath: location.canonicalRoot,
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: '2026-09-24T00:00:00.000Z'
  } as Project
  const manifest = {
    sessionId: 'session-a',
    kind: 'project',
    projectId: project.id,
    projectLocation: location,
    cwd: ensureRemoteProjectAnchor(project.id, agentDir)
  } as PhiSessionManifest
  const calls: string[] = []
  let closeCount = 0
  const remoteHome = join(base, 'remote-home')
  mkdirSync(remoteHome)
  // The command is `bash -lc …`, so the stand-in host gets its own empty HOME: the login
  // shell must not source the developer's profile. Like the real SSH session, it honours the
  // manager's timeout; a short fixed one turned slow starts under load into a null exit code,
  // which the manager rightly reports as an unknown result.
  const runShell = (command: string, timeoutMs = 60_000): ReturnType<typeof spawnSync> =>
    spawnSync('bash', ['-c', command], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 1_000_000,
      env: { ...process.env, HOME: remoteHome }
    })
  const dependencies: RemoteBashManagerDependencies = {
    agentDir,
    getManifest: (id) => (id === manifest.sessionId ? manifest : null),
    getProject: (id) => (id === project.id ? project : undefined),
    getHostProfile: (id) =>
      id === 'host-a' ? { id, label: 'Cluster A', hostAlias: 'cluster-a' } : undefined,
    connectImpl: async (): Promise<RemoteSshSession> => ({
      exec: async (command) => {
        calls.push(command)
        const result = runShell(command)
        return {
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          code: result.status,
          signal: result.signal
        }
      },
      execBounded: async (command, options) => {
        calls.push(command)
        const result = runShell(command, options.timeoutMs)
        const stdout = Buffer.from(result.stdout ?? '')
        const stderr = Buffer.from(result.stderr ?? '')
        const retainedStdout = stdout.subarray(0, options.maxOutputBytes)
        const retainedStderr = stderr.subarray(
          0,
          Math.max(0, options.maxOutputBytes - retainedStdout.byteLength)
        )
        return {
          stdout: retainedStdout.toString('utf-8'),
          stderr: retainedStderr.toString('utf-8'),
          code: result.status,
          signal: result.signal,
          stdoutTruncated: retainedStdout.byteLength < stdout.byteLength,
          stderrTruncated: retainedStderr.byteLength < stderr.byteLength
        }
      },
      readTextFile: async () => {
        throw new Error('unbounded read not allowed')
      },
      writeTextFile: async () => {
        throw new Error('not used')
      },
      mkdirp: async () => {
        throw new Error('not used')
      },
      exists: async () => {
        throw new Error('not used')
      },
      uploadFile: async () => {
        throw new Error('not used')
      },
      close: async () => {
        closeCount += 1
      }
    })
  }
  return {
    root,
    anchor: manifest.cwd,
    dependencies,
    calls,
    closed: () => closeCount,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

function request(
  command: string,
  requestId = 'request-1'
): {
  sessionId: string
  projectId: string
  toolCallId: string
  requestId: string
  command: string
} {
  return {
    sessionId: 'session-a',
    projectId: 'project-a',
    toolCallId: `tool-${requestId}`,
    requestId,
    command
  }
}

test('ordinary Bash command writes and reads a marker on the selected SSH project', async () => {
  const sample = fixture()
  try {
    const manager = new RemoteWorkspaceBashManager(sample.dependencies)
    const write = await manager.run(request('printf remote-marker > marker.txt'))
    assert.equal(write.status, 'completed')
    if (write.status !== 'completed') throw new Error('expected completed command')
    assert.equal(write.exitCode, 0)
    assert.equal(write.hostAlias, 'cluster-a')
    assert.equal(write.cwd, realpathSync(sample.root))
    assert.equal(readFileSync(join(sample.root, 'marker.txt'), 'utf-8'), 'remote-marker')
    assert.equal(existsSync(join(sample.anchor, 'marker.txt')), false)
    const read = await manager.run(request('cat marker.txt', 'request-2'))
    assert.equal(read.status, 'completed')
    if (read.status !== 'completed') throw new Error('expected completed command')
    assert.equal(read.stdout, 'remote-marker')
    assert.equal(sample.closed(), 2)
  } finally {
    sample.cleanup()
  }
})

test('nonzero exit, stderr, and bounded output remain distinguishable', async () => {
  const sample = fixture()
  try {
    const manager = new RemoteWorkspaceBashManager(sample.dependencies)
    const failed = await manager.run(request('printf failed >&2; exit 7'))
    assert.equal(failed.status, 'completed')
    if (failed.status !== 'completed') throw new Error('expected completed command')
    assert.equal(failed.exitCode, 7)
    assert.equal(failed.stderr, 'failed')
    const large = await manager.run(request('head -c 300000 /dev/zero | tr "\\0" x', 'request-2'))
    assert.equal(large.status, 'completed')
    if (large.status !== 'completed') throw new Error('expected completed command')
    assert.equal(large.stdoutTruncated, true)
    assert.equal(Buffer.byteLength(large.stdout), 256 * 1024)
  } finally {
    sample.cleanup()
  }
})

test('cwd, PTY, async, host override, and unbounded timeout are rejected', async () => {
  const sample = fixture()
  try {
    const manager = new RemoteWorkspaceBashManager(sample.dependencies)
    for (const input of [
      { ...request('pwd'), cwd: '/tmp' },
      { ...request('pwd'), pty: true },
      { ...request('pwd'), async: true },
      { ...request('pwd'), host: 'attacker' },
      { ...request('pwd'), timeout: 0 }
    ]) {
      await assert.rejects(manager.run(input))
    }
    assert.equal(
      sample.calls.some((command) => command.includes('pwd\n')),
      false
    )
  } finally {
    sample.cleanup()
  }
})

test('approval gate runs before connection and a missing grant has no side effects', async () => {
  const sample = fixture()
  try {
    const approved = new Set(['tool-request-2'])
    const manager = new RemoteWorkspaceBashManager({
      ...sample.dependencies,
      beforeRun: (input) => {
        if (!approved.delete(input.toolCallId)) throw new Error('approval required')
      }
    })
    await assert.rejects(manager.run(request('touch denied.txt')), /approval required/)
    assert.equal(sample.calls.length, 0)
    const allowed = await manager.run(request('touch allowed.txt', 'request-2'))
    assert.equal(allowed.status, 'completed')
    await assert.rejects(manager.run(request('touch again.txt', 'request-2')), /approval required/)
  } finally {
    sample.cleanup()
  }
})

test('timeout, connection loss, and cancellation preserve unknown-result semantics', async () => {
  const sample = fixture()
  try {
    const connect = sample.dependencies.connectImpl
    assert.ok(connect)
    const timeoutManager = new RemoteWorkspaceBashManager({
      ...sample.dependencies,
      connectImpl: async (config) => {
        const session = await connect(config)
        return {
          ...session,
          execBounded: async () => {
            throw new Error('SSH 命令超时；远端命令结果可能尚未确认')
          }
        }
      }
    })
    const timeout = await timeoutManager.run(request('sleep 2'))
    assert.equal(timeout.status, 'unknown')
    if (timeout.status !== 'unknown') throw new Error('expected unknown result')
    assert.equal(timeout.reason, 'timeout')
    const disconnected = new RemoteWorkspaceBashManager({
      ...sample.dependencies,
      connectImpl: async (config) => {
        const session = await connect(config)
        return {
          ...session,
          execBounded: async () => {
            throw new Error('SSH connection dropped')
          }
        }
      }
    })
    const lost = await disconnected.run(request('echo maybe', 'request-2'))
    assert.equal(lost.status, 'unknown')
    if (lost.status !== 'unknown') throw new Error('expected unknown result')
    assert.equal(lost.reason, 'connection_lost')

    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const cancellable = new RemoteWorkspaceBashManager({
      ...sample.dependencies,
      connectImpl: async (config) => {
        const session = await connect(config)
        return {
          ...session,
          execBounded: async (_command, options) => {
            started()
            await new Promise<void>((_, reject) => {
              options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true
              })
            })
            throw new Error('unreachable')
          }
        }
      }
    })
    const pending = cancellable.run(request('sleep 60', 'request-3'))
    await ready
    assert.equal(
      cancellable.cancel({
        sessionId: 'session-a',
        projectId: 'project-a',
        requestId: 'request-3'
      }),
      true
    )
    const cancelled = await pending
    assert.equal(cancelled.status, 'unknown')
    if (cancelled.status !== 'unknown') throw new Error('expected unknown result')
    assert.equal(cancelled.reason, 'cancelled')
    assert.match(cancelled.message, /远端命令可能仍在运行/)
  } finally {
    sample.cleanup()
  }
})

test('session stop and app shutdown abort local SSH waits without a remote-kill claim', async () => {
  const sample = fixture()
  try {
    const connect = sample.dependencies.connectImpl
    assert.ok(connect)
    let signalStarted!: () => void
    let ready = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    const manager = new RemoteWorkspaceBashManager({
      ...sample.dependencies,
      connectImpl: async (config) => {
        const session = await connect(config)
        return {
          ...session,
          execBounded: async (_command, options) => {
            signalStarted()
            await new Promise<void>((_, reject) =>
              options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true
              })
            )
            throw new Error('unreachable')
          }
        }
      }
    })
    const first = manager.run(request('sleep 60', 'session-stop'))
    await ready
    manager.cancelSession('session-a')
    const stopped = await first
    assert.equal(stopped.status, 'unknown')
    if (stopped.status !== 'unknown') throw new Error('expected unknown result')
    assert.equal(stopped.reason, 'cancelled')

    ready = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    const second = manager.run(request('sleep 60', 'app-shutdown'))
    await ready
    manager.cancelAll()
    const shutdown = await second
    assert.equal(shutdown.status, 'unknown')
    if (shutdown.status !== 'unknown') throw new Error('expected unknown result')
    assert.equal(shutdown.reason, 'cancelled')
  } finally {
    sample.cleanup()
  }
})

test('Bash shell quoting keeps the fixed root check and command intact', () => {
  const script = buildRemoteBashCommand("/cluster/it's work", "/cluster/it's work", 'printf ok', {
    SAMPLE: "a'b"
  })
  assert.match(script, /bash -lc/)
  assert.match(script, /printf ok/)
  assert.match(script, /SAMPLE/)
})

test('same-name Bash tool preserves command parameters and reports completed or unknown outcomes', async () => {
  const calls: Array<{ toolCallId: string; command: string }> = []
  const tool = buildRemoteWorkspaceBashTool(async (toolCallId, input) => {
    calls.push({ toolCallId, command: input.command })
    return {
      status: 'completed',
      hostAlias: 'cluster-a',
      cwd: '/data/project',
      exitCode: 7,
      stdout: 'partial',
      stderr: 'failed',
      stdoutTruncated: true,
      stderrTruncated: false,
      wallTimeMs: 20
    }
  })
  assert.equal(tool.name, 'bash')
  assert.equal(tool.description, PHI_REMOTE_BASH_DESCRIPTION)
  assert.deepEqual(tool.parameters.required, ['command'])
  const result = await tool.execute('tool-1', { command: 'exit 7' }, undefined, {} as never)
  assert.deepEqual(calls, [{ toolCallId: 'tool-1', command: 'exit 7' }])
  assert.equal(result.isError, true)
  assert.match(String(result.content[0]?.text), /Command exited with code 7/)
  assert.match(String(result.content[0]?.text), /stdout truncated/)
  assert.equal((result.details as { exitCode: number }).exitCode, 7)

  const unknown = buildRemoteWorkspaceBashTool(async () => ({
    status: 'unknown',
    reason: 'cancelled',
    message: '远端结果未知',
    wallTimeMs: 10
  }))
  const lost = await unknown.execute('tool-2', { command: 'sleep 60' }, undefined, {} as never)
  assert.equal(lost.isError, true)
  assert.equal((lost.details as { resultUnknown: boolean }).resultUnknown, true)
})
