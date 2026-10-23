import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createInstalledHelperTransferConnect,
  FileTransferCoordinator,
  FileTransferRegistry,
  uploadRemoteFile
} from '../src/main/agent/transfer'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'
import { createLocalShellSession } from './helpers/localShellSession'

test('installed helper reuse refuses a directory without its expected ready marker', async () => {
  const commands: string[] = []
  let helperStarts = 0
  const session = {
    async execBounded(command: string) {
      commands.push(command)
      if (command.includes('.phi-ready.json')) {
        return {
          stdout: '',
          stderr: '',
          code: 73,
          signal: null,
          stdoutTruncated: false,
          stderrTruncated: false
        }
      }
      return {
        stdout: `PHI_HELPER_HEX=${Buffer.from('/home/test/.phi/remote/0.1.0/phi-helper').toString('hex')}\n`,
        stderr: '',
        code: 0,
        signal: null,
        stdoutTruncated: false,
        stderrTruncated: false
      }
    },
    async openStdio() {
      helperStarts += 1
      return {} as never
    }
  } as unknown as RemoteSshSession

  await assert.rejects(
    () =>
      createInstalledHelperTransferConnect(session, '/work/project', {
        schema: 1,
        kind: 'remote-helper',
        version: '0.1.0',
        sha256: 'a'.repeat(64)
      })(),
    /remote helper unavailable/i
  )
  assert.equal(commands.length, 1)
  assert.match(commands[0] ?? '', /\.phi-ready\.json/)
  assert.equal(helperStarts, 0)
})

test('remote upload adapter streams through pure SSH and reports transfer progress', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-upload-adapter-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-upload-adapter-remote-'))
  const source = join(localRoot, 'source.bin')
  const destination = join(remoteRoot, 'destination.bin')
  const content = Buffer.concat([Buffer.from('streamed\0'), Buffer.alloc(2 * 1024 * 1024, 0x5a)])
  const digest = createHash('sha256').update(content).digest('hex')
  writeFileSync(source, content)
  const session = createLocalShellSession(remoteRoot)
  const coordinator = new FileTransferCoordinator({
    registry: new FileTransferRegistry(join(localRoot, 'registry.json')),
    policy: {
      chunkSizeBytes: 256 * 1024,
      checkpointBytes: 256 * 1024,
      progressBytes: 1,
      progressIntervalMs: 0
    }
  })
  const events: string[] = []
  let helperConnections = 0
  try {
    const result = await uploadRemoteFile({
      session,
      localPath: source,
      remotePath: destination,
      remoteRoot,
      canonicalRoot: realpathSync(remoteRoot),
      hostKey: 'test-host',
      workspaceId: 'test-workspace',
      transferId: 'consumer-upload',
      expectedSha256: digest,
      coordinator,
      forceSsh: true,
      helperConnect: async () => {
        helperConnections += 1
        throw new Error('helper must not be used for bootstrap')
      },
      onEvent: (event) => events.push(event.state)
    })

    assert.equal(result.sha256, digest)
    assert.deepEqual(readFileSync(destination), content)
    assert.equal(helperConnections, 0)
    assert.ok(events.includes('transferring'))
    assert.ok(events.includes('verifying'))
    assert.ok(events.includes('publishing'))
  } finally {
    await session.close()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
  }
})

test('remote upload cancellation retains one stable partial and a new coordinator resumes it', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-upload-resume-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-upload-resume-remote-'))
  const source = join(localRoot, 'source.bin')
  const destination = join(remoteRoot, 'destination.bin')
  const registryPath = join(localRoot, 'registry.json')
  const content = Buffer.alloc(8 * 1024 * 1024 + 19, 0x36)
  writeFileSync(source, content)
  const session = createLocalShellSession(remoteRoot)
  const controller = new AbortController()
  const request = {
    session,
    localPath: source,
    remotePath: destination,
    remoteRoot,
    canonicalRoot: realpathSync(remoteRoot),
    hostKey: 'resume-host',
    workspaceId: 'resume-workspace',
    transferId: 'consumer-resume',
    expectedSha256: createHash('sha256').update(content).digest('hex')
  } as const
  const coordinator = (): FileTransferCoordinator =>
    new FileTransferCoordinator({
      registry: new FileTransferRegistry(registryPath),
      policy: {
        chunkSizeBytes: 256 * 1024,
        checkpointBytes: 256 * 1024,
        progressBytes: 1,
        progressIntervalMs: 0
      }
    })
  try {
    await assert.rejects(
      uploadRemoteFile({
        ...request,
        coordinator: coordinator(),
        signal: controller.signal,
        onEvent: (event) => {
          if (event.state === 'transferring' && event.bytesTransferred > 0) controller.abort()
        }
      }),
      (error: unknown) => (error as { code?: unknown }).code === 'ABORTED'
    )
    assert.equal(existsSync(destination), false)

    const resumed = await uploadRemoteFile({ ...request, coordinator: coordinator() })

    assert.ok(resumed.resumedFrom > 0)
    assert.deepEqual(readFileSync(destination), content)
  } finally {
    await session.close()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
  }
})

test('remote upload reuse rejects a local source that does not match the staged digest', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-upload-reuse-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-upload-reuse-remote-'))
  const source = join(localRoot, 'source.bin')
  const destination = join(remoteRoot, 'destination.bin')
  writeFileSync(source, 'different local bytes')
  writeFileSync(destination, 'verified staged bytes')
  const expectedSha256 = createHash('sha256').update('verified staged bytes').digest('hex')
  const session = createLocalShellSession(remoteRoot)
  try {
    await assert.rejects(
      uploadRemoteFile({
        session,
        localPath: source,
        remotePath: destination,
        remoteRoot,
        canonicalRoot: realpathSync(remoteRoot),
        hostKey: 'reuse-host',
        workspaceId: 'reuse-workspace',
        transferId: 'consumer-reuse-mismatch',
        expectedSha256,
        reuseVerifiedDestination: true
      }),
      (error: unknown) => (error as { code?: unknown }).code === 'HASH_MISMATCH'
    )
    assert.equal(readFileSync(destination, 'utf8'), 'verified staged bytes')
  } finally {
    await session.close()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
  }
})
