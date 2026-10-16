import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { capableUploadHelper } from './helpers/helperDataPlaneFixture'

import {
  HelperTransferDataPlane,
  type HelperTransferDataPlaneStatus
} from '../src/main/agent/transfer/helper-data-plane'
import { HelperDataPlaneProtocolClient } from '../src/main/agent/transfer/helper-data-plane-protocol'
import { FileTransferManager, FileTransferRegistry } from '../src/main/agent/transfer'
import type {
  TransferDataPlane,
  TransferDataPlaneSession
} from '../src/main/agent/transfer/data-plane'
import type { TransferRequest } from '../src/main/agent/transfer/types'
import type { RemoteStdioProcess } from '../src/main/agent/wrappers/remote-ssh-session'

function jsonFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.byteLength)
  return Buffer.concat([header, payload])
}

function fakeProcess(
  onRequest: (request: Record<string, unknown>, responses: PassThrough) => void
): RemoteStdioProcess {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let buffered = Buffer.alloc(0)
  let resolveClosed!: (value: { code: number | null; signal: string | null }) => void
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveClosed = resolve
  })
  stdin.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.byteLength >= 4) {
      const length = buffered.readUInt32BE(0)
      if (buffered.byteLength < length + 4) return
      const payload = buffered.subarray(4, length + 4)
      buffered = buffered.subarray(length + 4)
      onRequest(JSON.parse(payload.toString('utf8')) as Record<string, unknown>, stdout)
    }
  })
  return {
    stdin,
    stdout,
    stderr,
    closed,
    async close() {
      stdin.end()
      stdout.end()
      stderr.end()
      resolveClosed({ code: 0, signal: null })
    }
  }
}

function uploadRequest(dataPlaneId = 'helper'): TransferRequest {
  return {
    transferId: 'helper-old-fallback',
    direction: 'upload',
    hostKey: 'host-key',
    dataPlaneId,
    source: { kind: 'local-path', path: '/tmp/source.bin' },
    destination: {
      kind: 'remote-workspace-path',
      hostId: 'host-id',
      workspaceId: 'workspace-id',
      relativePath: 'result.bin'
    }
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

test('old helper capability negotiation degrades to pure SSH with a clear reason', async () => {
  const fallbackSession = {} as TransferDataPlaneSession
  let fallbackOpens = 0
  const fallback: TransferDataPlane = {
    id: 'ssh',
    destinationKey: () => 'ssh:destination',
    async open() {
      fallbackOpens += 1
      return fallbackSession
    }
  }
  const statuses: HelperTransferDataPlaneStatus[] = []
  const process = fakeProcess((request, responses) => {
    responses.write(
      jsonFrame({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'method not found: protocol.negotiate' }
      })
    )
  })
  const plane = new HelperTransferDataPlane({
    hostId: 'host-id',
    workspaceId: 'workspace-id',
    remoteRoot: '/srv/project',
    canonicalRoot: '/srv/project',
    connect: async () => process,
    fallback,
    onStatus: (status) => statuses.push(status)
  })

  assert.equal(await plane.open(uploadRequest()), fallbackSession)
  assert.equal(fallbackOpens, 1)
  assert.equal(plane.destinationKey(uploadRequest()), 'ssh:destination')
  assert.deepEqual(statuses.at(-1), {
    state: 'degraded',
    reason: 'Remote helper lacks transfer data-plane protocol v1; using pure SSH fallback'
  })
  await process.close()
})

test('unavailable helper connection degrades to pure SSH without exposing connection details', async () => {
  const fallbackSession = {} as TransferDataPlaneSession
  let fallbackOpens = 0
  const plane = new HelperTransferDataPlane({
    hostId: 'host-id',
    workspaceId: 'workspace-id',
    remoteRoot: '/srv/project',
    canonicalRoot: '/srv/project',
    connect: async () => {
      throw new Error('ssh://alice@private.example/path?token=secret')
    },
    fallback: {
      id: 'ssh',
      destinationKey: () => 'ssh:destination',
      async open() {
        fallbackOpens += 1
        return fallbackSession
      }
    }
  })

  assert.equal(await plane.open(uploadRequest()), fallbackSession)
  assert.equal(fallbackOpens, 1)
  assert.deepEqual(plane.status(), {
    state: 'degraded',
    reason: 'Remote helper unavailable; using pure SSH fallback'
  })
})

test('malformed helper negotiation fails closed instead of changing data planes', async () => {
  let fallbackOpens = 0
  const process = fakeProcess((request, responses) => {
    responses.write(
      jsonFrame({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32700, message: 'remote helper returned invalid JSON' }
      })
    )
  })
  const plane = new HelperTransferDataPlane({
    hostId: 'host-id',
    workspaceId: 'workspace-id',
    remoteRoot: '/srv/project',
    canonicalRoot: '/srv/project',
    connect: async () => process,
    fallback: {
      id: 'ssh',
      destinationKey: () => 'ssh:destination',
      async open() {
        fallbackOpens += 1
        return {} as TransferDataPlaneSession
      }
    }
  })

  await assert.rejects(plane.open(uploadRequest()), /invalid JSON/)
  assert.equal(fallbackOpens, 0)
  await process.close()
})

test('incompatible helper protocol degrades to pure SSH with a clear reason', async () => {
  const fallbackSession = {} as TransferDataPlaneSession
  let fallbackOpens = 0
  const process = fakeProcess((request, responses) => {
    responses.write(
      jsonFrame({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32602,
          message: 'no mutually supported helper protocol version',
          data: { code: 'UNSUPPORTED_PROTOCOL' }
        }
      })
    )
  })
  const plane = new HelperTransferDataPlane({
    hostId: 'host-id',
    workspaceId: 'workspace-id',
    remoteRoot: '/srv/project',
    canonicalRoot: '/srv/project',
    connect: async () => process,
    fallback: {
      id: 'ssh',
      destinationKey: () => 'ssh:destination',
      async open() {
        fallbackOpens += 1
        return fallbackSession
      }
    }
  })

  assert.equal(await plane.open(uploadRequest()), fallbackSession)
  assert.equal(fallbackOpens, 1)
  assert.deepEqual(plane.status(), {
    state: 'degraded',
    reason: 'Remote helper lacks transfer data-plane protocol v1; using pure SSH fallback'
  })
})

test('helper protocol rejects a backpressured write when the channel closes before drain', async () => {
  const stdin = new Writable({
    highWaterMark: 1,
    write() {
      // Intentionally never completes: the transport disconnect must release the request.
    }
  })
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let disconnect!: (value: { code: number | null; signal: string | null }) => void
  const process: RemoteStdioProcess = {
    stdin,
    stdout,
    stderr,
    closed: new Promise((resolve) => {
      disconnect = resolve
    }),
    async close() {
      stdout.end()
      stderr.end()
    }
  }
  const client = new HelperDataPlaneProtocolClient(process)
  const request = client.request('protocol.negotiate', { minVersion: 1, maxVersion: 1 })
  disconnect({ code: 255, signal: null })

  const outcome = await Promise.race([
    request.then(
      () => 'resolved',
      () => 'rejected'
    ),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100))
  ])
  assert.equal(outcome, 'rejected')
  assert.equal(stdin.listenerCount('drain'), 0)
  stdin.destroy()
})

test('helper protocol bounds a stalled control response with a timeout', async () => {
  const fixture = fakeProcess(() => undefined)
  let closes = 0
  const close = fixture.close.bind(fixture)
  fixture.close = async () => {
    closes += 1
    await close()
  }
  const client = new HelperDataPlaneProtocolClient(fixture, { requestTimeoutMs: 20 })

  const outcome = await Promise.race([
    client.request('protocol.negotiate', { minVersion: 1, maxVersion: 1 }).then(
      () => 'resolved',
      (error: Error) => error.message
    ),
    new Promise<'still pending'>((resolve) => setTimeout(() => resolve('still pending'), 100))
  ])
  assert.match(outcome, /timed out/)
  assert.equal(closes, 1)
  await fixture.close()
})

test('helper data plane rejects remote path traversal before opening a helper channel', async () => {
  let connections = 0
  const plane = new HelperTransferDataPlane({
    hostId: 'host-id',
    workspaceId: 'workspace-id',
    remoteRoot: '/srv/project',
    canonicalRoot: '/srv/project',
    connect: async () => {
      connections += 1
      return capableUploadHelper({
        files: new Map(),
        binaryChunkSizes: [],
        maxJsonBytes: 0
      })
    },
    fallback: {
      id: 'ssh',
      destinationKey: () => 'fallback',
      async open() {
        throw new Error('unexpected fallback')
      }
    }
  })
  const request: TransferRequest = {
    ...uploadRequest(),
    destination: {
      kind: 'remote-workspace-path',
      hostId: 'host-id',
      workspaceId: 'workspace-id',
      relativePath: '../outside.bin'
    }
  }

  await assert.rejects(plane.open(request), { code: 'INVALID_REQUEST' })
  assert.equal(connections, 0)
})

test('helper client rejects out-of-order and duplicate acknowledged offsets', async () => {
  for (const scenario of [
    { name: 'out-of-order', ackOffset: (offset: number) => offset + 1 },
    { name: 'duplicate', ackOffset: (offset: number) => (offset === 0 ? 0 : 0) }
  ]) {
    const root = mkdtempSync(join(tmpdir(), `phi-helper-${scenario.name}-`))
    const source = join(root, 'source.bin')
    const content = scenario.name === 'duplicate' ? Buffer.alloc(33, 0x2d) : Buffer.from('offset')
    writeFileSync(source, content)
    const state = {
      files: new Map<string, Buffer>(),
      binaryChunkSizes: [] as number[],
      maxJsonBytes: 0,
      ackOffset: scenario.ackOffset
    }
    const plane = new HelperTransferDataPlane({
      hostId: 'host-id',
      workspaceId: 'workspace-id',
      remoteRoot: '/srv/project',
      canonicalRoot: '/srv/project',
      maxReconnects: 0,
      connect: async () => capableUploadHelper(state),
      fallback: {
        id: 'ssh',
        destinationKey: () => 'fallback',
        async open() {
          throw new Error('unexpected fallback')
        }
      }
    })
    try {
      const request: TransferRequest = {
        ...uploadRequest(),
        transferId: `${scenario.name}-upload`,
        source: { kind: 'local-path', path: source },
        expectedSha256: sha256(content)
      }
      await assert.rejects(
        new FileTransferManager({
          registry: new FileTransferRegistry(join(root, 'registry.json')),
          dataPlanes: [plane],
          policy: { chunkSizeBytes: 32 }
        }).enqueue(request).completion,
        { code: 'TRANSFER_FAILED' }
      )
      assert.equal(state.files.has('result.bin'), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('helper upload uses fixed raw binary chunks and server-side atomic publish', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-helper-plane-'))
  const source = join(root, 'source.bin')
  const content = Buffer.concat([Buffer.alloc(8 * 1024 * 1024, 0xa5), Buffer.from([0, 1, 2])])
  writeFileSync(source, content)
  const state = {
    files: new Map<string, Buffer>(),
    binaryChunkSizes: [] as number[],
    maxJsonBytes: 0
  }
  const fallback: TransferDataPlane = {
    id: 'ssh',
    destinationKey: () => 'fallback',
    async open() {
      throw new Error('pure SSH fallback must not be used by a capable helper')
    }
  }
  const plane = new HelperTransferDataPlane({
    hostId: 'host-id',
    workspaceId: 'workspace-id',
    remoteRoot: '/srv/project',
    canonicalRoot: '/srv/project',
    connect: async () => capableUploadHelper(state),
    fallback
  })
  try {
    const request: TransferRequest = {
      ...uploadRequest(),
      transferId: 'binary-upload',
      source: { kind: 'local-path', path: source },
      expectedSha256: sha256(content)
    }
    const result = await new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [plane]
    }).enqueue(request).completion

    assert.equal(result.sha256, sha256(content))
    assert.deepEqual(state.binaryChunkSizes, [8 * 1024 * 1024, 3])
    assert.deepEqual(state.files.get('result.bin'), content)
    assert.ok(state.maxJsonBytes < 128 * 1024, 'file bytes must not be base64 encoded into JSON')
    assert.deepEqual(plane.status(), { state: 'available' })
    assert.deepEqual(readFileSync(source), content)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('helper upload keeps a bounded two-chunk window while honoring stream backpressure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-helper-window-'))
  const source = join(root, 'source.bin')
  const content = Buffer.alloc(65, 0x6b)
  writeFileSync(source, content)
  const state = {
    files: new Map<string, Buffer>(),
    binaryChunkSizes: [] as number[],
    maxJsonBytes: 0,
    ackDelayMs: 25,
    ackWhenInFlight: 2,
    inFlight: 0,
    maxInFlight: 0,
    forceBackpressure: true,
    binaryBackpressureWrites: 0,
    drainEvents: 0
  }
  const plane = new HelperTransferDataPlane({
    hostId: 'host-id',
    workspaceId: 'workspace-id',
    remoteRoot: '/srv/project',
    canonicalRoot: '/srv/project',
    connect: async () => capableUploadHelper(state),
    fallback: {
      id: 'ssh',
      destinationKey: () => 'fallback',
      async open() {
        throw new Error('unexpected fallback')
      }
    }
  })
  try {
    const request: TransferRequest = {
      ...uploadRequest(),
      transferId: 'window-upload',
      source: { kind: 'local-path', path: source },
      expectedSha256: sha256(content)
    }
    await new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [plane],
      policy: { chunkSizeBytes: 32 }
    }).enqueue(request).completion

    assert.equal(state.maxInFlight, 2)
    assert.ok(state.maxInFlight <= 2)
    assert.equal(state.binaryBackpressureWrites, 3)
    assert.ok(state.drainEvents >= 3)
    assert.deepEqual(state.binaryChunkSizes, [32, 32, 1])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('helper upload reconnects after a broken binary frame and resumes from the last ack', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-helper-reconnect-'))
  const source = join(root, 'source.bin')
  const content = Buffer.concat([Buffer.alloc(32, 0x35), Buffer.from('tail')])
  writeFileSync(source, content)
  const state = {
    files: new Map<string, Buffer>(),
    binaryChunkSizes: [] as number[],
    maxJsonBytes: 0,
    breakBinaryFrameOnce: true,
    binaryFrameBroken: false
  }
  const plane = new HelperTransferDataPlane({
    hostId: 'host-id',
    workspaceId: 'workspace-id',
    remoteRoot: '/srv/project',
    canonicalRoot: '/srv/project',
    connect: async () => capableUploadHelper(state),
    fallback: {
      id: 'ssh',
      destinationKey: () => 'fallback',
      async open() {
        throw new Error('unexpected fallback')
      }
    }
  })
  try {
    const request: TransferRequest = {
      ...uploadRequest(),
      transferId: 'reconnect-upload',
      source: { kind: 'local-path', path: source },
      expectedSha256: sha256(content)
    }
    const result = await new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [plane],
      policy: { chunkSizeBytes: 32 }
    }).enqueue(request).completion

    assert.equal(state.binaryFrameBroken, true)
    assert.equal(result.sha256, sha256(content))
    assert.deepEqual(state.files.get('result.bin'), content)
    assert.ok(
      state.binaryChunkSizes.filter((size) => size === 32).length >= 2,
      'the unacknowledged chunk must be resent after truncating the remote partial'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('helper download streams raw binary chunks and verifies the server SHA-256', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-helper-download-'))
  const destination = join(root, 'downloaded.bin')
  const content = Buffer.concat([Buffer.alloc(8 * 1024 * 1024, 0x9c), Buffer.from([0, 7, 0])])
  const state = {
    files: new Map<string, Buffer>([['source.bin', content]]),
    binaryChunkSizes: [] as number[],
    maxJsonBytes: 0
  }
  const plane = new HelperTransferDataPlane({
    hostId: 'host-id',
    workspaceId: 'workspace-id',
    remoteRoot: '/srv/project',
    canonicalRoot: '/srv/project',
    connect: async () => capableUploadHelper(state),
    fallback: {
      id: 'ssh',
      destinationKey: () => 'fallback',
      async open() {
        throw new Error('unexpected fallback')
      }
    }
  })
  try {
    const request: TransferRequest = {
      transferId: 'binary-download',
      direction: 'download',
      hostKey: 'host-key',
      dataPlaneId: plane.id,
      source: {
        kind: 'remote-workspace-path',
        hostId: 'host-id',
        workspaceId: 'workspace-id',
        relativePath: 'source.bin'
      },
      destination: { kind: 'local-path', path: destination }
    }
    const result = await new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [plane]
    }).enqueue(request).completion

    assert.equal(result.sha256, sha256(content))
    assert.deepEqual(readFileSync(destination), content)
    assert.deepEqual(state.binaryChunkSizes, [8 * 1024 * 1024, 3])
    assert.ok(state.maxJsonBytes < 128 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('helper download reconnects after a broken frame at the last confirmed offset', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-helper-download-reconnect-'))
  const destination = join(root, 'downloaded.bin')
  const content = Buffer.concat([Buffer.alloc(32, 0x4e), Buffer.from('tail')])
  const state = {
    files: new Map<string, Buffer>([['source.bin', content]]),
    binaryChunkSizes: [] as number[],
    maxJsonBytes: 0,
    breakDownloadAtOffset: 32,
    downloadBinaryFrameBroken: false,
    downloadRequestOffsets: [] as number[]
  }
  const plane = new HelperTransferDataPlane({
    hostId: 'host-id',
    workspaceId: 'workspace-id',
    remoteRoot: '/srv/project',
    canonicalRoot: '/srv/project',
    connect: async () => capableUploadHelper(state),
    fallback: {
      id: 'ssh',
      destinationKey: () => 'fallback',
      async open() {
        throw new Error('unexpected fallback')
      }
    }
  })
  try {
    const result = await new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [plane],
      policy: { chunkSizeBytes: 32 }
    }).enqueue({
      transferId: 'download-reconnect',
      direction: 'download',
      hostKey: 'host-key',
      dataPlaneId: plane.id,
      source: {
        kind: 'remote-workspace-path',
        hostId: 'host-id',
        workspaceId: 'workspace-id',
        relativePath: 'source.bin'
      },
      destination: { kind: 'local-path', path: destination }
    }).completion

    assert.equal(state.downloadBinaryFrameBroken, true)
    assert.deepEqual(state.downloadRequestOffsets, [0, 32, 32])
    assert.equal(result.sha256, sha256(content))
    assert.deepEqual(readFileSync(destination), content)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
