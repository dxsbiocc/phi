import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FileTransferManager,
  FileTransferRegistry,
  LocalTransferDataPlane,
  type TransferCopyOptions,
  type TransferDataPlane,
  type TransferDataPlaneSession,
  type TransferEvent,
  type TransferRequest
} from '../src/main/agent/transfer'

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function makeManager(root: string, events: TransferEvent[] = []): FileTransferManager {
  return new FileTransferManager({
    registry: new FileTransferRegistry(join(root, 'registry.json')),
    dataPlanes: [new LocalTransferDataPlane()],
    onEvent: (event) => events.push(event)
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for transfer test condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

class GatedLocalDataPlane implements TransferDataPlane {
  readonly id = 'gated-local'
  readonly started: string[] = []
  maxActive = 0
  readonly maxByHost = new Map<string, number>()
  readonly maxByDestination = new Map<string, number>()
  private readonly local = new LocalTransferDataPlane()
  private readonly activeByHost = new Map<string, number>()
  private readonly activeByDestination = new Map<string, number>()
  private active = 0
  private released = false
  private releaseGate: (() => void) | null = null
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve
  })

  destinationKey(request: TransferRequest): string {
    return this.local.destinationKey(request)
  }

  async open(request: TransferRequest): Promise<TransferDataPlaneSession> {
    const session = await this.local.open(request)
    return new Proxy(session, {
      get: (target, property, receiver) => {
        if (property === 'copy') {
          return async (options: TransferCopyOptions): Promise<void> => {
            this.started.push(request.transferId)
            this.active += 1
            this.bump(this.activeByHost, this.maxByHost, request.hostKey)
            this.bump(this.activeByDestination, this.maxByDestination, target.destinationKey)
            this.maxActive = Math.max(this.maxActive, this.active)
            if (!this.released) await this.gate
            try {
              await target.copy(options)
            } finally {
              this.active -= 1
              this.drop(this.activeByHost, request.hostKey)
              this.drop(this.activeByDestination, target.destinationKey)
            }
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }

  releaseAll(): void {
    this.released = true
    this.releaseGate?.()
  }

  private bump(current: Map<string, number>, maxima: Map<string, number>, key: string): void {
    const count = (current.get(key) ?? 0) + 1
    current.set(key, count)
    maxima.set(key, Math.max(maxima.get(key) ?? 0, count))
  }

  private drop(current: Map<string, number>, key: string): void {
    const count = current.get(key) ?? 0
    if (count <= 1) current.delete(key)
    else current.set(key, count - 1)
  }
}

async function makeCancelledCheckpoint(
  root: string,
  transferId: string
): Promise<
  Readonly<{
    registry: FileTransferRegistry
    request: TransferRequest
    part: string
    manifest: string
  }>
> {
  const source = join(root, 'source.bin')
  const destination = join(root, 'saved.bin')
  writeFileSync(source, Buffer.alloc(3 * 1024 * 1024, 0x66))
  const registry = new FileTransferRegistry(join(root, 'registry.json'))
  const manager = new FileTransferManager({
    registry,
    dataPlanes: [new LocalTransferDataPlane()],
    policy: {
      chunkSizeBytes: 1024 * 1024,
      checkpointBytes: 1024 * 1024,
      progressBytes: 1,
      progressIntervalMs: 0
    },
    onEvent: (event) => {
      if (event.state === 'transferring' && event.bytesTransferred >= 1024 * 1024) handle.cancel()
    }
  })
  const request: TransferRequest = {
    transferId,
    direction: 'local',
    hostKey: 'local',
    dataPlaneId: 'local',
    source: { kind: 'local-path', path: source },
    destination: { kind: 'local-path', path: destination }
  }
  const handle = manager.enqueue(request)
  await assert.rejects(handle.completion, { code: 'ABORTED' })
  const part = join(root, `.saved.bin.phi-transfer-${transferId}.part`)
  return { registry, request, part, manifest: `${part}.json` }
}

test('local transfer streams, verifies, and publishes without leaving staging metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-success-'))
  try {
    const source = join(root, 'source.bin')
    const destination = join(root, 'saved.bin')
    const content = Buffer.from('verified transfer payload')
    writeFileSync(source, content)
    const events: TransferEvent[] = []
    const manager = makeManager(root, events)

    const result = await manager.enqueue({
      transferId: 'success-1',
      direction: 'local',
      hostKey: 'local',
      dataPlaneId: 'local',
      source: { kind: 'local-path', path: source },
      destination: { kind: 'local-path', path: destination },
      expectedSha256: sha256(content)
    }).completion

    assert.deepEqual(result, {
      transferId: 'success-1',
      state: 'saved',
      bytes: content.byteLength,
      resumedFrom: 0,
      sha256: sha256(content)
    })
    assert.deepEqual(readFileSync(destination), content)
    assert.equal(readFileSync(join(root, 'registry.json'), 'utf8').includes('success-1'), false)
    assert.deepEqual(
      events.map((event) => event.state),
      ['queued', 'preparing', 'transferring', 'verifying', 'publishing', 'saved']
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancel retains a stable 0600 partial and resume truncates beyond the durable checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-resume-'))
  try {
    const source = join(root, 'source.bin')
    const destination = join(root, 'saved.bin')
    const content = Buffer.alloc(10 * 1024 * 1024, 0x5a)
    writeFileSync(source, content)
    const registry = new FileTransferRegistry(join(root, 'registry.json'))
    const firstManager = new FileTransferManager({
      registry,
      dataPlanes: [new LocalTransferDataPlane()],
      policy: {
        chunkSizeBytes: 1024 * 1024,
        checkpointBytes: 2 * 1024 * 1024,
        progressBytes: 1,
        progressIntervalMs: 0
      },
      onEvent: (event) => {
        if (event.state === 'transferring' && event.bytesTransferred >= 2 * 1024 * 1024) {
          handle.cancel()
        }
      }
    })
    const handle = firstManager.enqueue({
      transferId: 'resume-1',
      direction: 'local',
      hostKey: 'local',
      dataPlaneId: 'local',
      source: { kind: 'local-path', path: source },
      destination: { kind: 'local-path', path: destination }
    })
    await assert.rejects(handle.completion, { code: 'ABORTED' })

    const part = join(root, '.saved.bin.phi-transfer-resume-1.part')
    const manifestPath = `${part}.json`
    assert.equal(statSync(part).mode & 0o777, 0o600)
    assert.equal(statSync(manifestPath).mode & 0o777, 0o600)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { durableOffset: number }
    assert.ok(manifest.durableOffset >= 2 * 1024 * 1024)
    appendFileSync(part, Buffer.from('not durable'))
    assert.ok(statSync(part).size > manifest.durableOffset)

    const resumed = await new FileTransferManager({
      registry,
      dataPlanes: [new LocalTransferDataPlane()],
      policy: { chunkSizeBytes: 1024 * 1024, checkpointBytes: 2 * 1024 * 1024 }
    }).enqueue({
      transferId: 'resume-1',
      direction: 'local',
      hostKey: 'local',
      dataPlaneId: 'local',
      source: { kind: 'local-path', path: source },
      destination: { kind: 'local-path', path: destination }
    }).completion

    assert.equal(resumed.resumedFrom, manifest.durableOffset)
    assert.deepEqual(readFileSync(destination), content)
    assert.deepEqual(
      readdirSync(root).filter((name) => name.includes('phi-transfer-resume-1')),
      []
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resume rejects a changed source identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-source-change-'))
  try {
    const source = join(root, 'source.bin')
    const destination = join(root, 'saved.bin')
    writeFileSync(source, Buffer.alloc(4 * 1024 * 1024, 0x11))
    const registry = new FileTransferRegistry(join(root, 'registry.json'))
    const firstManager = new FileTransferManager({
      registry,
      dataPlanes: [new LocalTransferDataPlane()],
      policy: {
        chunkSizeBytes: 1024 * 1024,
        checkpointBytes: 1024 * 1024,
        progressBytes: 1,
        progressIntervalMs: 0
      },
      onEvent: (event) => {
        if (event.state === 'transferring' && event.bytesTransferred >= 1024 * 1024) handle.cancel()
      }
    })
    const handle = firstManager.enqueue({
      transferId: 'changed-source',
      direction: 'local',
      hostKey: 'local',
      dataPlaneId: 'local',
      source: { kind: 'local-path', path: source },
      destination: { kind: 'local-path', path: destination }
    })
    await assert.rejects(handle.completion, { code: 'ABORTED' })
    writeFileSync(source, Buffer.alloc(4 * 1024 * 1024, 0x22))

    const resumed = new FileTransferManager({
      registry,
      dataPlanes: [new LocalTransferDataPlane()],
      policy: { chunkSizeBytes: 1024 * 1024, checkpointBytes: 1024 * 1024 }
    }).enqueue({
      transferId: 'changed-source',
      direction: 'local',
      hostKey: 'local',
      dataPlaneId: 'local',
      source: { kind: 'local-path', path: source },
      destination: { kind: 'local-path', path: destination }
    })
    await assert.rejects(resumed.completion, { code: 'SOURCE_CHANGED' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('hash mismatch fails closed and retains the registered partial', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-hash-mismatch-'))
  try {
    const source = join(root, 'source.bin')
    const destination = join(root, 'saved.bin')
    writeFileSync(source, 'actual bytes')
    const registry = new FileTransferRegistry(join(root, 'registry.json'))
    const handle = new FileTransferManager({
      registry,
      dataPlanes: [new LocalTransferDataPlane()]
    }).enqueue({
      transferId: 'wrong-hash',
      direction: 'local',
      hostKey: 'local',
      dataPlaneId: 'local',
      source: { kind: 'local-path', path: source },
      destination: { kind: 'local-path', path: destination },
      expectedSha256: sha256('different bytes')
    })

    await assert.rejects(handle.completion, { code: 'HASH_MISMATCH' })
    assert.equal(existsSync(destination), false)
    assert.equal(existsSync(join(root, '.saved.bin.phi-transfer-wrong-hash.part')), true)
    assert.deepEqual(
      (await registry.list()).map(({ transferId, status }) => ({ transferId, status })),
      [{ transferId: 'wrong-hash', status: 'failed' }]
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancel and delete removes only that transfer partial and manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-cancel-delete-'))
  try {
    const source = join(root, 'source.bin')
    const destination = join(root, 'saved.bin')
    const unrelated = join(root, '.saved.bin.phi-transfer-unrelated.part')
    writeFileSync(source, Buffer.alloc(3 * 1024 * 1024, 0x33))
    writeFileSync(unrelated, 'leave me alone')
    const registry = new FileTransferRegistry(join(root, 'registry.json'))
    const manager = new FileTransferManager({
      registry,
      dataPlanes: [new LocalTransferDataPlane()],
      policy: { chunkSizeBytes: 1024 * 1024, progressBytes: 1, progressIntervalMs: 0 },
      onEvent: (event) => {
        if (event.state === 'transferring' && event.bytesTransferred >= 1024 * 1024) {
          handle.cancel({ discardPartial: true })
        }
      }
    })
    const handle = manager.enqueue({
      transferId: 'delete-me',
      direction: 'local',
      hostKey: 'local',
      dataPlaneId: 'local',
      source: { kind: 'local-path', path: source },
      destination: { kind: 'local-path', path: destination }
    })

    await assert.rejects(handle.completion, { code: 'ABORTED' })
    assert.equal(existsSync(join(root, '.saved.bin.phi-transfer-delete-me.part')), false)
    assert.equal(existsSync(join(root, '.saved.bin.phi-transfer-delete-me.part.json')), false)
    assert.equal(readFileSync(unrelated, 'utf8'), 'leave me alone')
    assert.deepEqual(await registry.list(), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('publish rejects a target race without replacing the winner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-target-race-'))
  try {
    const source = join(root, 'source.bin')
    const destination = join(root, 'saved.bin')
    writeFileSync(source, 'transfer data')
    const manager = new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [new LocalTransferDataPlane()],
      onEvent: (event) => {
        if (event.state === 'publishing') writeFileSync(destination, 'race winner', { flag: 'wx' })
      }
    })

    const handle = manager.enqueue({
      transferId: 'target-race',
      direction: 'local',
      hostKey: 'local',
      dataPlaneId: 'local',
      source: { kind: 'local-path', path: source },
      destination: { kind: 'local-path', path: destination }
    })
    await assert.rejects(handle.completion, { code: 'DESTINATION_EXISTS' })
    assert.equal(readFileSync(destination, 'utf8'), 'race winner')
    assert.equal(existsSync(join(root, '.saved.bin.phi-transfer-target-race.part')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('manager refuses size-only verification when SHA-256 is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-no-hash-'))
  try {
    const source = join(root, 'source.bin')
    const destination = join(root, 'saved.bin')
    writeFileSync(source, 'must be hashed')
    const local = new LocalTransferDataPlane()
    const noHashPlane: TransferDataPlane = {
      id: 'no-hash',
      destinationKey: (request) => local.destinationKey(request),
      open: async (request): Promise<TransferDataPlaneSession> => {
        const session = await local.open(request)
        return new Proxy(session, {
          get(target, property, receiver) {
            if (property === 'preflight') {
              return async (signal: AbortSignal) => ({
                ...(await target.preflight(signal)),
                sourceHashAvailable: false,
                destinationHashAvailable: false
              })
            }
            const value = Reflect.get(target, property, receiver) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      }
    }
    const handle = new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [noHashPlane]
    }).enqueue({
      transferId: 'no-size-only',
      direction: 'download',
      hostKey: 'remote',
      dataPlaneId: 'no-hash',
      source: { kind: 'local-path', path: source },
      destination: { kind: 'local-path', path: destination }
    })

    await assert.rejects(handle.completion, { code: 'HASH_UNAVAILABLE' })
    assert.equal(existsSync(destination), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('progress errors are bounded and redact secrets, URLs, hosts, and private paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-redaction-'))
  try {
    const events: TransferEvent[] = []
    const unsafe =
      'Bearer abcdefghijklmnopqrstuvwxyz at ssh://alice@secret-host/private?token=top-secret ' +
      '/Users/alice/private/data '.repeat(200)
    const failingPlane: TransferDataPlane = {
      id: 'failing',
      destinationKey: () => 'opaque-destination',
      open: async () => {
        throw new Error(unsafe)
      }
    }
    const handle = new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [failingPlane],
      onEvent: (event) => events.push(event)
    }).enqueue({
      transferId: 'safe-error',
      direction: 'download',
      hostKey: 'alice@secret-host',
      dataPlaneId: 'failing',
      source: {
        kind: 'remote-workspace-path',
        hostId: 'private',
        workspaceId: 'w',
        relativePath: 'x'
      },
      destination: { kind: 'local-path', path: join(root, 'saved.bin') }
    })

    await assert.rejects(handle.completion)
    const serialized = JSON.stringify(events.at(-1))
    assert.ok(Buffer.byteLength(serialized) < 1400)
    assert.ok(!serialized.includes('abcdefghijklmnopqrstuvwxyz'))
    assert.ok(!serialized.includes('secret-host'))
    assert.ok(!serialized.includes('/Users/alice/private'))
    assert.ok(!serialized.includes('top-secret'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('queue enforces global, per-host, and per-destination concurrency', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-concurrency-'))
  try {
    const plane = new GatedLocalDataPlane()
    const manager = new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [plane]
    })
    const sharedDestination = join(root, 'shared.bin')
    const specifications = [
      { transferId: 'first', hostKey: 'host-a', destination: sharedDestination },
      { transferId: 'same-destination', hostKey: 'host-b', destination: sharedDestination },
      { transferId: 'same-host', hostKey: 'host-a', destination: join(root, 'third.bin') },
      { transferId: 'independent', hostKey: 'host-b', destination: join(root, 'fourth.bin') }
    ] as const
    const handles = specifications.map((specification) => {
      const source = join(root, `${specification.transferId}.source`)
      writeFileSync(source, specification.transferId)
      return manager.enqueue({
        transferId: specification.transferId,
        direction: 'local',
        hostKey: specification.hostKey,
        dataPlaneId: plane.id,
        source: { kind: 'local-path', path: source },
        destination: { kind: 'local-path', path: specification.destination }
      })
    })

    await waitFor(() => plane.started.length === 2)
    assert.deepEqual(new Set(plane.started), new Set(['first', 'independent']))
    plane.releaseAll()
    const outcomes = await Promise.allSettled(handles.map((handle) => handle.completion))

    assert.equal(plane.maxActive, 2)
    assert.ok([...plane.maxByHost.values()].every((count) => count === 1))
    assert.ok([...plane.maxByDestination.values()].every((count) => count === 1))
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 3)
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('queued transfer can be cancelled without opening its data plane', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-queued-cancel-'))
  try {
    const plane = new GatedLocalDataPlane()
    const manager = new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [plane]
    })
    const firstSource = join(root, 'first.source')
    const queuedSource = join(root, 'queued.source')
    writeFileSync(firstSource, 'first')
    writeFileSync(queuedSource, 'queued')
    const first = manager.enqueue({
      transferId: 'active-first',
      direction: 'local',
      hostKey: 'one-host',
      dataPlaneId: plane.id,
      source: { kind: 'local-path', path: firstSource },
      destination: { kind: 'local-path', path: join(root, 'first.saved') }
    })
    const queued = manager.enqueue({
      transferId: 'queued-second',
      direction: 'local',
      hostKey: 'one-host',
      dataPlaneId: plane.id,
      source: { kind: 'local-path', path: queuedSource },
      destination: { kind: 'local-path', path: join(root, 'queued.saved') }
    })
    await waitFor(() => plane.started.length === 1)
    queued.cancel({ discardPartial: true })
    await assert.rejects(queued.completion, { code: 'ABORTED' })
    assert.deepEqual(plane.started, ['active-first'])
    assert.equal(existsSync(join(root, '.queued.saved.phi-transfer-queued-second.part')), false)
    plane.releaseAll()
    await first.completion
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resume verifies the last confirmed chunk before writing more data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-last-chunk-'))
  try {
    const source = join(root, 'source.bin')
    const destination = join(root, 'saved.bin')
    writeFileSync(source, Buffer.alloc(3 * 1024 * 1024, 0x44))
    const registry = new FileTransferRegistry(join(root, 'registry.json'))
    const firstManager = new FileTransferManager({
      registry,
      dataPlanes: [new LocalTransferDataPlane()],
      policy: {
        chunkSizeBytes: 1024 * 1024,
        checkpointBytes: 1024 * 1024,
        progressBytes: 1,
        progressIntervalMs: 0
      },
      onEvent: (event) => {
        if (event.state === 'transferring' && event.bytesTransferred >= 1024 * 1024) handle.cancel()
      }
    })
    const request = {
      transferId: 'last-chunk',
      direction: 'local' as const,
      hostKey: 'local',
      dataPlaneId: 'local',
      source: { kind: 'local-path' as const, path: source },
      destination: { kind: 'local-path' as const, path: destination }
    }
    const handle = firstManager.enqueue(request)
    await assert.rejects(handle.completion, { code: 'ABORTED' })
    const part = join(root, '.saved.bin.phi-transfer-last-chunk.part')
    const descriptor = openSync(part, 'r+')
    try {
      writeSync(descriptor, Buffer.from([0xff]), 0, 1, 1024 * 1024 - 1)
    } finally {
      closeSync(descriptor)
    }

    const resumed = new FileTransferManager({
      registry,
      dataPlanes: [new LocalTransferDataPlane()],
      policy: { chunkSizeBytes: 1024 * 1024, checkpointBytes: 1024 * 1024 }
    }).enqueue(request)
    await assert.rejects(resumed.completion, { code: 'HASH_MISMATCH' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resume rejects a symbolic-link partial', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-part-symlink-'))
  try {
    const fixture = await makeCancelledCheckpoint(root, 'part-symlink')
    unlinkSync(fixture.part)
    symlinkSync((fixture.request.source as { path: string }).path, fixture.part)
    const resumed = new FileTransferManager({
      registry: fixture.registry,
      dataPlanes: [new LocalTransferDataPlane()],
      policy: { chunkSizeBytes: 1024 * 1024, checkpointBytes: 1024 * 1024 }
    }).enqueue(fixture.request)

    await assert.rejects(resumed.completion, { code: 'INVALID_PARTIAL' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancel and delete also removes a previously paused transfer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-paused-delete-'))
  try {
    const source = join(root, 'source.bin')
    const destination = join(root, 'saved.bin')
    writeFileSync(source, Buffer.alloc(3 * 1024 * 1024, 0x77))
    const registry = new FileTransferRegistry(join(root, 'registry.json'))
    const manager = new FileTransferManager({
      registry,
      dataPlanes: [new LocalTransferDataPlane()],
      policy: { chunkSizeBytes: 1024 * 1024, progressBytes: 1, progressIntervalMs: 0 },
      onEvent: (event) => {
        if (event.state === 'transferring' && event.bytesTransferred >= 1024 * 1024) handle.pause()
      }
    })
    const handle = manager.enqueue({
      transferId: 'paused-delete',
      direction: 'local',
      hostKey: 'local',
      dataPlaneId: 'local',
      source: { kind: 'local-path', path: source },
      destination: { kind: 'local-path', path: destination }
    })
    await waitFor(() => manager.getState('paused-delete') === 'paused')
    handle.cancel({ discardPartial: true })
    await assert.rejects(handle.completion, { code: 'ABORTED' })

    assert.equal(existsSync(join(root, '.saved.bin.phi-transfer-paused-delete.part')), false)
    assert.equal(existsSync(join(root, '.saved.bin.phi-transfer-paused-delete.part.json')), false)
    assert.deepEqual(await registry.list(), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancel during verification cannot publish the destination', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-verify-cancel-'))
  try {
    const source = join(root, 'source.bin')
    const destination = join(root, 'saved.bin')
    writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 0x7a))
    const manager = new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [new LocalTransferDataPlane()],
      onEvent: (event) => {
        if (event.state === 'verifying') handle.cancel()
      }
    })
    const handle = manager.enqueue({
      transferId: 'verify-cancel',
      direction: 'local',
      hostKey: 'local',
      dataPlaneId: 'local',
      source: { kind: 'local-path', path: source },
      destination: { kind: 'local-path', path: destination }
    })

    await assert.rejects(handle.completion, { code: 'ABORTED' })
    assert.equal(existsSync(destination), false)
    assert.equal(existsSync(join(root, '.saved.bin.phi-transfer-verify-cancel.part')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preflight capacity contract rejects remaining bytes plus checkpoint safety margin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-capacity-'))
  try {
    const source = join(root, 'source.bin')
    const destination = join(root, 'saved.bin')
    writeFileSync(source, 'requires capacity')
    const local = new LocalTransferDataPlane()
    const constrained: TransferDataPlane = {
      id: 'constrained',
      destinationKey: (request) => local.destinationKey(request),
      open: async (request): Promise<TransferDataPlaneSession> => {
        const session = await local.open(request)
        return new Proxy(session, {
          get(target, property, receiver) {
            if (property === 'preflight') {
              return async (signal: AbortSignal) => ({
                ...(await target.preflight(signal)),
                destinationAvailableBytes: 1
              })
            }
            const value = Reflect.get(target, property, receiver) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      }
    }
    const handle = new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [constrained]
    }).enqueue({
      transferId: 'no-capacity',
      direction: 'download',
      hostKey: 'remote',
      dataPlaneId: 'constrained',
      source: { kind: 'local-path', path: source },
      destination: { kind: 'local-path', path: destination }
    })

    await assert.rejects(handle.completion, { code: 'INSUFFICIENT_SPACE' })
    assert.equal(existsSync(join(root, '.saved.bin.phi-transfer-no-capacity.part')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
