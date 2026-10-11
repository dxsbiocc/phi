import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FileTransferManager,
  FileTransferRegistry,
  type PartialInspection,
  type TransferCopyOptions,
  type TransferDataPlane,
  type TransferDataPlaneSession,
  type TransferEvent,
  type TransferManifest,
  type TransferPreflight,
  type TransferRequest,
  type TransferSourceIdentity
} from '../src/main/agent/transfer'

const DIGEST = 'a'.repeat(64)

class GeneratedSession implements TransferDataPlaneSession {
  readonly destinationKey: string
  readonly partialLocator: string
  readonly manifestLocator: string
  readonly identity: TransferSourceIdentity
  private manifest: TransferManifest | null = null
  private partialExists = false
  private partialSize = 0
  maxChunkSize = 0
  chunkCount = 0
  readonly checkpointOffsets: number[] = []

  constructor(
    transferId: string,
    readonly totalBytes: number,
    private readonly callbackBytes: number,
    private readonly advanceClock: () => void = () => undefined
  ) {
    this.destinationKey = `virtual-destination:${transferId}`
    this.partialLocator = `virtual-partial:${transferId}`
    this.manifestLocator = `virtual-manifest:${transferId}`
    this.identity = {
      kind: 'generated-v1',
      device: 'generated',
      inode: transferId,
      size: totalBytes,
      mtime: 'immutable'
    }
  }

  async preflight(): Promise<TransferPreflight> {
    return {
      sourceIdentity: this.identity,
      expectedSize: this.totalBytes,
      sourceHashAvailable: true,
      destinationHashAvailable: true,
      destinationAvailableBytes: Number.MAX_SAFE_INTEGER
    }
  }

  async inspectSource(): Promise<TransferSourceIdentity> {
    return this.identity
  }

  async loadManifest(): Promise<TransferManifest | null> {
    return this.manifest
  }

  async writeManifest(manifest: TransferManifest): Promise<void> {
    this.manifest = manifest
    this.checkpointOffsets.push(manifest.durableOffset)
  }

  async removeManifest(): Promise<void> {
    this.manifest = null
  }

  async inspectPartial(): Promise<PartialInspection> {
    return this.partialExists
      ? {
          kind: 'file',
          size: this.partialSize,
          ownerId: typeof process.getuid === 'function' ? process.getuid() : null
        }
      : { kind: 'missing', size: 0, ownerId: null }
  }

  async createPartial(): Promise<void> {
    this.partialExists = true
  }

  async truncatePartial(size: number): Promise<void> {
    this.partialSize = size
  }

  async hashPartialRange(): Promise<string> {
    return DIGEST
  }

  async copy(options: TransferCopyOptions): Promise<void> {
    this.maxChunkSize = Math.max(this.maxChunkSize, options.chunkSize)
    let position = options.offset
    let lastCheckpoint = position
    let lastProgress = null as null | {
      offset: number
      chunkOffset: number
      chunkSize: number
      chunkSha256: string
    }
    while (position < this.totalBytes) {
      if (options.signal.aborted) throw new DOMException('cancelled', 'AbortError')
      const size = Math.min(this.callbackBytes, this.totalBytes - position)
      const progress = {
        offset: position + size,
        chunkOffset: position,
        chunkSize: size,
        chunkSha256: DIGEST
      }
      this.chunkCount += 1
      this.partialSize = progress.offset
      this.advanceClock()
      if (await options.onChunk(progress)) {
        await options.onCheckpoint(progress)
        lastCheckpoint = progress.offset
      }
      lastProgress = progress
      position = progress.offset
    }
    if (lastProgress !== null && lastCheckpoint !== lastProgress.offset) {
      await options.onCheckpoint(lastProgress)
    }
  }

  async hashSource(): Promise<string> {
    return DIGEST
  }

  async hashPartial(): Promise<string> {
    return DIGEST
  }

  async publish(): Promise<void> {
    this.partialExists = false
  }

  async discard(): Promise<void> {
    this.partialExists = false
    this.manifest = null
  }
}

class GeneratedDataPlane implements TransferDataPlane {
  readonly id = 'generated'
  readonly sessions = new Map<string, GeneratedSession>()

  constructor(
    private readonly totalBytes: number,
    private readonly callbackBytes: number,
    private readonly advanceClock: () => void = () => undefined
  ) {}

  destinationKey(request: TransferRequest): string {
    return `virtual-destination:${request.transferId}`
  }

  async open(request: TransferRequest): Promise<TransferDataPlaneSession> {
    const session = new GeneratedSession(
      request.transferId,
      this.totalBytes,
      this.callbackBytes,
      this.advanceClock
    )
    this.sessions.set(request.transferId, session)
    return session
  }
}

function generatedRequest(transferId: string): TransferRequest {
  return {
    transferId,
    direction: 'download',
    hostKey: 'generated-host',
    dataPlaneId: 'generated',
    source: {
      kind: 'remote-workspace-path',
      hostId: 'authorized-host',
      workspaceId: 'authorized-workspace',
      relativePath: 'generated.bin'
    },
    destination: { kind: 'local-path', path: `/authorized/${transferId}.bin` },
    expectedSha256: DIGEST
  }
}

test('generated 3 GiB transfer keeps the raw data window bounded to the 8 MiB chunk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-generated-'))
  try {
    const totalBytes = 3 * 1024 * 1024 * 1024 + 3 * 1024 * 1024
    const plane = new GeneratedDataPlane(totalBytes, 8 * 1024 * 1024)
    const result = await new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [plane]
    }).enqueue(generatedRequest('generated-large')).completion
    const session = plane.sessions.get('generated-large')!

    assert.equal(result.bytes, totalBytes)
    assert.equal(session.maxChunkSize, 8 * 1024 * 1024)
    assert.equal(session.chunkCount, Math.ceil(totalBytes / (8 * 1024 * 1024)))
    assert.ok(
      session.checkpointOffsets
        .slice(1)
        .every((offset, index, offsets) => offset - (offsets[index - 1] ?? 0) <= 64 * 1024 * 1024)
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checkpoint interval persists progress after five seconds even below 64 MiB', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-checkpoint-time-'))
  try {
    let now = 0
    const plane = new GeneratedDataPlane(16 * 1024 * 1024, 1024 * 1024, () => {
      now += 1_000
    })
    await new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [plane],
      now: () => now
    }).enqueue(generatedRequest('checkpoint-time')).completion

    assert.deepEqual(plane.sessions.get('checkpoint-time')!.checkpointOffsets, [
      0,
      5 * 1024 * 1024,
      10 * 1024 * 1024,
      15 * 1024 * 1024,
      16 * 1024 * 1024
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('progress events require both 250 ms and 1 MiB since the previous event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-progress-'))
  try {
    let now = 0
    const captured: Array<Readonly<{ at: number; event: TransferEvent }>> = []
    const plane = new GeneratedDataPlane(4 * 1024 * 1024, 512 * 1024, () => {
      now += 100
    })
    await new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [plane],
      now: () => now,
      onEvent: (event) => captured.push({ at: now, event })
    }).enqueue(generatedRequest('progress-throttle')).completion

    const progress = captured.filter(
      ({ event }) => event.state === 'transferring' && event.bytesTransferred > 0
    )
    assert.deepEqual(
      progress.map(({ at, event }) => ({ at, bytes: event.bytesTransferred })),
      [
        { at: 300, bytes: 1.5 * 1024 * 1024 },
        { at: 600, bytes: 3 * 1024 * 1024 }
      ]
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
