import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import {
  createInstalledHelperTransferConnect,
  FileTransferCoordinator,
  FileTransferRegistry,
  uploadRemoteFile
} from '../src/main/agent/transfer'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'
import type { TransferStdioProcess } from '../src/main/agent/transfer/remote-upload-types'
import { createLocalShellSession } from './helpers/localShellSession'

function closingUploadProcess(): TransferStdioProcess {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let settled = false
  let resolveClosed!: (result: { code: number | null; signal: string | null }) => void
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveClosed = resolve
  })
  const settle = (): void => {
    if (settled) return
    settled = true
    stdout.end()
    stderr.end('mux_client_request_session: read from master failed: Message too long\n')
    resolveClosed({ code: 255, signal: null })
  }
  const stdin = new Writable({
    highWaterMark: 1024 * 1024,
    write(_chunk, _encoding, callback) {
      callback()
      queueMicrotask(() => {
        stdin.destroy()
        settle()
      })
    }
  })
  return {
    stdin,
    stdout,
    stderr,
    closed,
    async close() {
      stdin.destroy()
      settle()
      await closed
    }
  }
}

/** Long enough that the healthy retry is not mistaken for a stall when the host is loaded. */
const STALL_LIMIT_MS = 2_000
const STALL_DEADLINE_MS = 30_000

function stallingUploadProcess(process: TransferStdioProcess): {
  process: TransferStdioProcess
  release(): void
} {
  let writes = 0
  let releaseWrite: (() => void) | undefined
  const stdin = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      writes += 1
      if (writes === 1) {
        process.stdin.write(chunk, callback)
        return
      }
      releaseWrite = callback
    },
    final(callback) {
      process.stdin.end(callback)
    }
  })
  const release = (): void => {
    releaseWrite?.()
    releaseWrite = undefined
  }
  return {
    process: {
      stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      closed: process.closed,
      async close() {
        stdin.destroy()
        await process.close()
      }
    },
    release
  }
}

function slowUploadProcess(
  process: TransferStdioProcess,
  writeDelayMs: number
): TransferStdioProcess {
  const stdin = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      process.stdin.write(chunk, (error) => {
        setTimeout(() => callback(error), writeDelayMs)
      })
    },
    final(callback) {
      process.stdin.end(callback)
    }
  })
  return {
    stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    closed: process.closed,
    async close() {
      stdin.destroy()
      await process.close()
    }
  }
}

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

test('remote upload retries once when the SSH stream closes mid-write', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-upload-retry-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-upload-retry-remote-'))
  const source = join(localRoot, 'source.bin')
  const destination = join(remoteRoot, 'destination.bin')
  const content = Buffer.alloc(512 * 1024 + 19, 0x2a)
  const digest = createHash('sha256').update(content).digest('hex')
  writeFileSync(source, content)
  const actualSession = createLocalShellSession(remoteRoot)
  const actualOpenStdio = actualSession.openStdio!.bind(actualSession)
  let streamsOpened = 0
  const session = {
    ...actualSession,
    async openStdio(command: string) {
      streamsOpened += 1
      if (streamsOpened === 1) return closingUploadProcess()
      assert.equal(existsSync(destination), false, 'a failed attempt must not publish its partial')
      return actualOpenStdio(command)
    }
  } as RemoteSshSession
  const coordinator = new FileTransferCoordinator({
    registry: new FileTransferRegistry(join(localRoot, 'registry.json')),
    policy: {
      chunkSizeBytes: 256 * 1024,
      checkpointBytes: 256 * 1024,
      progressBytes: 1,
      progressIntervalMs: 0
    }
  })
  try {
    const result = await uploadRemoteFile({
      session,
      localPath: source,
      remotePath: destination,
      remoteRoot,
      canonicalRoot: realpathSync(remoteRoot),
      hostKey: 'retry-host',
      workspaceId: 'retry-workspace',
      transferId: 'consumer-retry',
      expectedSha256: digest,
      coordinator,
      forceSsh: true,
      reuseVerifiedDestination: true,
      retryOnce: true
    })

    assert.equal(streamsOpened, 2)
    assert.equal(result.sha256, digest)
    assert.deepEqual(readFileSync(destination), content)
  } finally {
    await actualSession.close()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
  }
})

test('remote upload aborts a stalled SSH write and resumes from its verified checkpoint', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-upload-stall-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-upload-stall-remote-'))
  const source = join(localRoot, 'source.bin')
  const destination = join(remoteRoot, 'destination.bin')
  const content = Buffer.alloc(768 * 1024 + 19, 0x4b)
  const digest = createHash('sha256').update(content).digest('hex')
  writeFileSync(source, content)
  const actualSession = createLocalShellSession(remoteRoot)
  const actualOpenStdio = actualSession.openStdio!.bind(actualSession)
  let streamsOpened = 0
  let releaseStall = (): void => undefined
  const session = {
    ...actualSession,
    async openStdio(command: string) {
      streamsOpened += 1
      const process = await actualOpenStdio(command)
      if (streamsOpened !== 1) return process
      const stalled = stallingUploadProcess(process)
      releaseStall = stalled.release
      return stalled.process
    }
  } as RemoteSshSession
  const controller = new AbortController()
  const coordinator = new FileTransferCoordinator({
    registry: new FileTransferRegistry(join(localRoot, 'registry.json')),
    policy: {
      chunkSizeBytes: 256 * 1024,
      checkpointBytes: 256 * 1024,
      progressBytes: 1,
      progressIntervalMs: 0,
      idleTimeoutMs: STALL_LIMIT_MS
    }
  })
  const failureCodes: string[] = []
  const started = Date.now()
  const upload = uploadRemoteFile({
    session,
    localPath: source,
    remotePath: destination,
    remoteRoot,
    canonicalRoot: realpathSync(remoteRoot),
    hostKey: 'stall-host',
    workspaceId: 'stall-workspace',
    transferId: 'consumer-stall',
    expectedSha256: digest,
    coordinator,
    forceSsh: true,
    signal: controller.signal,
    maxAttempts: 2,
    retryBackoffMs: 1,
    onEvent: (event) => {
      if (event.state === 'failed' && event.error) failureCodes.push(event.error.code)
    }
  })
  try {
    const result = await Promise.race([
      upload,
      delay(STALL_DEADLINE_MS).then(() => {
        throw new Error('stalled transfer did not settle within its watchdog')
      })
    ])

    assert.ok(Date.now() - started < STALL_DEADLINE_MS)
    assert.equal(streamsOpened, 2)
    assert.deepEqual(failureCodes, ['TRANSFER_STALLED'])
    assert.ok(result.resumedFrom >= 256 * 1024)
    assert.equal(result.sha256, digest)
    assert.deepEqual(readFileSync(destination), content)
  } finally {
    releaseStall()
    controller.abort()
    await upload.catch(() => undefined)
    await actualSession.close()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
  }
})

test('remote upload watchdog permits a slow stream that keeps acknowledging bytes', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-upload-slow-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-upload-slow-remote-'))
  const source = join(localRoot, 'source.bin')
  const destination = join(remoteRoot, 'destination.bin')
  const content = Buffer.alloc(768 * 1024 + 19, 0x71)
  const digest = createHash('sha256').update(content).digest('hex')
  writeFileSync(source, content)
  const actualSession = createLocalShellSession(remoteRoot)
  const actualOpenStdio = actualSession.openStdio!.bind(actualSession)
  const session = {
    ...actualSession,
    async openStdio(command: string) {
      return slowUploadProcess(await actualOpenStdio(command), 100)
    }
  } as RemoteSshSession
  const coordinator = new FileTransferCoordinator({
    registry: new FileTransferRegistry(join(localRoot, 'registry.json')),
    policy: {
      chunkSizeBytes: 256 * 1024,
      checkpointBytes: 256 * 1024,
      progressBytes: 1,
      progressIntervalMs: 0,
      idleTimeoutMs: 500
    }
  })
  const phases: string[] = []
  try {
    const result = await uploadRemoteFile({
      session,
      localPath: source,
      remotePath: destination,
      remoteRoot,
      canonicalRoot: realpathSync(remoteRoot),
      hostKey: 'slow-host',
      workspaceId: 'slow-workspace',
      transferId: 'consumer-slow',
      expectedSha256: digest,
      coordinator,
      forceSsh: true,
      onPhaseTiming: (timing) => {
        assert.ok(timing.elapsedMs >= 0)
        phases.push(timing.phase)
      }
    })

    assert.equal(result.sha256, digest)
    assert.deepEqual(readFileSync(destination), content)
    assert.deepEqual(phases, ['manifest', 'chunk', 'verify', 'publish'])
  } finally {
    await actualSession.close()
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
    // A cancel can land before any checkpoint, so 0 is a valid durable offset to resume from.
    const { durableOffset } = JSON.parse(
      readFileSync(
        join(remoteRoot, '.destination.bin.phi-transfer-consumer-resume.part.json'),
        'utf8'
      )
    ) as { durableOffset: number }

    const resumed = await uploadRemoteFile({ ...request, coordinator: coordinator() })

    assert.equal(resumed.resumedFrom, durableOffset)
    assert.deepEqual(readFileSync(destination), content)
  } finally {
    await session.close()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
  }
})

test('a remote script that refuses the stream reports its own reason, not the broken pipe', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'phi-upload-refused-local-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-upload-refused-remote-'))
  const source = join(localRoot, 'source.bin')
  const destination = join(remoteRoot, 'destination.bin')
  const content = Buffer.alloc(8 * 1024 * 1024 + 19, 0x52)
  writeFileSync(source, content)
  const actualSession = createLocalShellSession(remoteRoot)
  const session = {
    ...actualSession,
    async openStdio(command: string) {
      // The stream script checks its partial first, so it exits before reading any byte.
      const partial = join(remoteRoot, '.destination.bin.phi-transfer-consumer-refused.part')
      rmSync(partial, { force: true })
      return actualSession.openStdio!(command)
    }
  } as RemoteSshSession
  try {
    await assert.rejects(
      uploadRemoteFile({
        session,
        localPath: source,
        remotePath: destination,
        remoteRoot,
        canonicalRoot: realpathSync(remoteRoot),
        hostKey: 'refused-host',
        workspaceId: 'refused-workspace',
        transferId: 'consumer-refused',
        expectedSha256: createHash('sha256').update(content).digest('hex'),
        coordinator: new FileTransferCoordinator({
          registry: new FileTransferRegistry(join(localRoot, 'registry.json')),
          policy: { chunkSizeBytes: 256 * 1024, checkpointBytes: 256 * 1024 }
        }),
        forceSsh: true
      }),
      (error: unknown) => (error as { code?: unknown }).code === 'INVALID_PARTIAL'
    )
  } finally {
    await actualSession.close()
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
