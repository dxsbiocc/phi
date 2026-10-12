import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWorkspaceHostRemoteSession } from '../src/main/agent/workspace-host/remote-session'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import type { HostCommand, WorkspaceHost } from '../src/main/agent/workspace-host/types'
import { FileTransferCoordinator, FileTransferRegistry } from '../src/main/agent/transfer'
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

test('remote request session uploads delegate to the host streaming transfer adapter', async () => {
  const uploads: Array<{ localPath: string; remotePath: string; transferId?: string }> = []
  const host = {
    fs: {
      async writeAtomic() {
        throw new Error('whole-file writes must not be used for uploads')
      }
    } as unknown as WorkspaceHost['fs'],
    exec: {} as WorkspaceHost['exec'],
    transfer: {
      async uploadFile(localPath, remotePath, options) {
        uploads.push({ localPath, remotePath, transferId: options?.transferId })
      }
    },
    capabilities() {
      throw new Error('not used')
    }
  } satisfies WorkspaceHost
  const session = createWorkspaceHostRemoteSession(host, '/remote/project')

  await session.uploadFile('/local/archive.bin', '/remote/project/archive.bin', {
    transferId: 'workspace-host-upload'
  })

  assert.deepEqual(uploads, [
    {
      localPath: '/local/archive.bin',
      remotePath: '/remote/project/archive.bin',
      transferId: 'workspace-host-upload'
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

test('SshHost request sessions stream uploads through the transfer manager', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-host-remote-upload-'))
  const local = await mkdtemp(join(tmpdir(), 'phi-host-remote-upload-local-'))
  try {
    const canonicalRoot = await realpath(root)
    const source = join(local, 'payload.bin')
    const destination = join(root, 'payload.bin')
    const content = Buffer.alloc(2 * 1024 * 1024 + 17, 0x62)
    await writeFile(source, content)
    const host = new SshHost({
      remoteRoot: root,
      canonicalRoot,
      connect: async () => createLocalShellSession(canonicalRoot)
    })
    const session = createWorkspaceHostRemoteSession(host, canonicalRoot)
    const coordinator = new FileTransferCoordinator({
      registry: new FileTransferRegistry(join(local, 'registry.json')),
      policy: { chunkSizeBytes: 256 * 1024, checkpointBytes: 256 * 1024 }
    })

    const uploadOptions = {
      transferId: 'workspace-host-stream-upload',
      expectedSha256: createHash('sha256').update(content).digest('hex'),
      hostKey: 'test-host',
      workspaceId: 'test-workspace',
      coordinator,
      reuseVerifiedDestination: true
    } as const
    await session.uploadFile(source, destination, uploadOptions)

    assert.deepEqual(await readFile(destination), await readFile(source))
    const publishedInode = (await stat(destination)).ino
    await session.uploadFile(source, destination, uploadOptions)
    assert.equal((await stat(destination)).ino, publishedInode)
  } finally {
    await rm(local, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('SshHost request sessions reject upload roots outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-host-remote-upload-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'phi-host-remote-upload-outside-'))
  const local = await mkdtemp(join(tmpdir(), 'phi-host-remote-upload-source-'))
  try {
    const canonicalRoot = await realpath(root)
    const canonicalOutside = await realpath(outside)
    const source = join(local, 'payload.bin')
    const destination = join(canonicalOutside, 'escaped.bin')
    await writeFile(source, 'must stay inside the workspace')
    const host = new SshHost({
      remoteRoot: root,
      canonicalRoot,
      connect: async () => createLocalShellSession(canonicalRoot)
    })
    const session = createWorkspaceHostRemoteSession(host, canonicalRoot)

    await assert.rejects(
      session.uploadFile(source, destination, {
        transferId: 'workspace-host-root-escape',
        remoteRoot: canonicalOutside,
        canonicalRoot: canonicalOutside,
        hostKey: 'test-host',
        workspaceId: 'test-workspace'
      }),
      /outside the workspace root/
    )
    await assert.rejects(readFile(destination))
  } finally {
    await rm(local, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('SshHost upload reuse rejects a staging symlink without touching its target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-host-remote-upload-symlink-'))
  const local = await mkdtemp(join(tmpdir(), 'phi-host-remote-upload-symlink-local-'))
  try {
    const canonicalRoot = await realpath(root)
    const source = join(local, 'payload.bin')
    const target = join(canonicalRoot, 'other.bin')
    const staging = join(canonicalRoot, 'staging.bin')
    const content = 'verified staged bytes'
    await writeFile(source, content)
    await writeFile(target, content)
    await symlink(target, staging)
    const host = new SshHost({
      remoteRoot: root,
      canonicalRoot,
      connect: async () => createLocalShellSession(canonicalRoot)
    })
    const session = createWorkspaceHostRemoteSession(host, canonicalRoot)

    await assert.rejects(
      session.uploadFile(source, staging, {
        transferId: 'workspace-host-symlink-reuse',
        expectedSha256: createHash('sha256').update(content).digest('hex'),
        hostKey: 'test-host',
        workspaceId: 'test-workspace',
        reuseVerifiedDestination: true
      }),
      (error: unknown) => (error as { code?: unknown }).code === 'INVALID_REQUEST'
    )
    assert.equal(await readFile(target, 'utf8'), content)
  } finally {
    await rm(local, { recursive: true, force: true })
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
