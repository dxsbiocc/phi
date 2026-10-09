import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWorkspaceHostRemoteSession } from '../src/main/agent/workspace-host/remote-session'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import type { HostCommand, WorkspaceHost } from '../src/main/agent/workspace-host/types'
import { createLocalShellSession, installSetsidShim } from './helpers/localShellSession'

test('remote request sessions execute commands through WorkspaceHost', async () => {
  const calls: Array<{
    command: HostCommand
    cwd: string
    timeoutMs?: number
    maxOutputBytes?: number
  }> = []
  const host = {
    fs: {} as WorkspaceHost['fs'],
    exec: {
      async run(command, options) {
        calls.push({
          command,
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes
        })
        return {
          stdout: 'host output',
          stderr: '',
          code: 0,
          signal: null,
          truncated: false
        }
      },
      async spawnBackground() {
        throw new Error('not used')
      }
    },
    capabilities() {
      throw new Error('not used')
    }
  } satisfies WorkspaceHost

  const session = createWorkspaceHostRemoteSession(host, '/remote/project', {
    defaultTimeoutMs: 10_000
  })
  const result = await session.exec('printf legacy-request')

  assert.equal(result.stdout, 'host output')
  assert.deepEqual(calls, [
    {
      command: ['bash', '-c', 'printf legacy-request'],
      cwd: '/remote/project',
      timeoutMs: 10_000,
      maxOutputBytes: 8 * 1024 * 1024
    }
  ])
})

test('closing a remote request session aborts its in-flight host command', async () => {
  let observedSignal: AbortSignal | undefined
  const host = {
    fs: {} as WorkspaceHost['fs'],
    exec: {
      async run(_command, options) {
        observedSignal = options.signal
        return new Promise<Awaited<ReturnType<WorkspaceHost['exec']['run']>>>((resolve) => {
          const completed = setTimeout(
            () =>
              resolve({
                stdout: 'late',
                stderr: '',
                code: 0,
                signal: null,
                truncated: false
              }),
            50
          )
          options.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(completed)
              resolve({
                stdout: '',
                stderr: '',
                code: null,
                signal: 'SIGTERM',
                truncated: false,
                terminationReason: 'cancelled'
              })
            },
            { once: true }
          )
        })
      },
      async spawnBackground() {
        throw new Error('not used')
      }
    },
    capabilities() {
      throw new Error('not used')
    }
  } satisfies WorkspaceHost
  const session = createWorkspaceHostRemoteSession(host, '/remote/project')

  const pending = session.exec('sleep 60')
  await session.close()

  assert.equal(observedSignal?.aborted, true)
  await assert.rejects(pending, /SSH 连接已关闭；远端操作结果可能尚未确认/)
})

test('remote request sessions preserve bounded and control SSH timeout errors', async () => {
  const host = {
    fs: {} as WorkspaceHost['fs'],
    exec: {
      async run() {
        return {
          stdout: '',
          stderr: '',
          code: null,
          signal: 'SIGKILL',
          truncated: false,
          terminationReason: 'timeout' as const
        }
      },
      async spawnBackground() {
        throw new Error('not used')
      }
    },
    capabilities() {
      throw new Error('not used')
    }
  } satisfies WorkspaceHost
  const session = createWorkspaceHostRemoteSession(host, '/remote/project')
  assert.ok(session.execBounded)

  await assert.rejects(
    session.execBounded('sleep 60', { timeoutMs: 50, maxOutputBytes: 1024 }),
    /SSH 命令超时；远端命令结果可能尚未确认/
  )
  await assert.rejects(session.exec('sleep 60'), /ssh 超时；远端操作结果可能尚未确认/)
})

test('SshHost carries a legacy remote request without executing in the local anchor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-host-remote-session-'))
  const shim = await mkdtemp(join(tmpdir(), 'phi-host-remote-session-shim-'))
  const restoreSetsid = installSetsidShim(shim)
  try {
    const canonicalRoot = await realpath(root)
    const host = new SshHost({
      remoteRoot: root,
      canonicalRoot,
      connect: async () => createLocalShellSession(canonicalRoot)
    })
    const session = createWorkspaceHostRemoteSession(host, canonicalRoot)

    const result = await session.exec('printf host-routed')

    assert.equal(result.code, 0)
    assert.equal(result.stdout, 'host-routed')
  } finally {
    restoreSetsid()
    await rm(shim, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('SshHost carries legacy stdin writes through host filesystem and execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-host-remote-input-'))
  const shim = await mkdtemp(join(tmpdir(), 'phi-host-remote-input-shim-'))
  const restoreSetsid = installSetsidShim(shim)
  try {
    const canonicalRoot = await realpath(root)
    const host = new SshHost({
      remoteRoot: root,
      canonicalRoot,
      connect: async () => {
        const session = createLocalShellSession(canonicalRoot)
        session.execWithInput = async (command, input) => {
          const { spawn } = await import('node:child_process')
          return new Promise((resolve) => {
            const child = spawn('bash', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
            let stdout = ''
            let stderr = ''
            child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
            child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
            child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }))
            child.stdin.end(input)
          })
        }
        return session
      }
    })
    const session = createWorkspaceHostRemoteSession(host, canonicalRoot)
    assert.ok(session.execWithInput)

    const result = await session.execWithInput('cat > written.txt', 'host input')

    assert.equal(result.code, 0)
    assert.equal(await readFile(join(root, 'written.txt'), 'utf8'), 'host input')
  } finally {
    restoreSetsid()
    await rm(shim, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})
