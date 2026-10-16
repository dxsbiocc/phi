import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  FileTransferManager,
  FileTransferRegistry,
  LocalTransferDataPlane
} from '../src/main/agent/transfer'
import { TransferError } from '../src/main/agent/transfer/errors'
import type {
  TransferCopyOptions,
  TransferDataPlane,
  TransferDataPlaneSession
} from '../src/main/agent/transfer/data-plane'
import type { TransferEvent, TransferRequest } from '../src/main/agent/transfer/types'
import { HelperDataPlaneProtocolClient } from '../src/main/agent/transfer/helper-data-plane-protocol'
import { HelperTransferDataPlane } from '../src/main/agent/transfer/helper-data-plane'
import type { RemoteStdioProcess } from '../src/main/agent/wrappers/remote-ssh-session'
import { capableUploadHelper, createHelperUploadFixture } from './helpers/helperDataPlaneFixture'

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((done) => {
      resolve = done
    }),
    resolve
  }
}

test('manager preserves the original preflight error and waits for the owned close before failure emit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-close-error-'))
  const source = join(root, 'source.bin')
  writeFileSync(source, 'source')
  const started = deferred()
  const drain = deferred()
  const primary = new TransferError('HASH_UNAVAILABLE', 'synthetic original preflight failure')
  const local = new LocalTransferDataPlane()
  const events: TransferEvent[] = []
  let closes = 0
  const plane: TransferDataPlane = {
    id: 'owned-lifecycle',
    destinationKey: (request) => local.destinationKey(request),
    async open(request): Promise<TransferDataPlaneSession> {
      const session = await local.open(request)
      return new Proxy(session, {
        get(target, property, receiver) {
          if (property === 'preflight')
            return async () => {
              throw primary
            }
          if (property === 'close')
            return async () => {
              closes += 1
              started.resolve()
              await drain.promise
              throw new Error('synthetic secondary close failure')
            }
          const value = Reflect.get(target, property, receiver) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
  const handle = new FileTransferManager({
    registry: new FileTransferRegistry(join(root, 'registry.json')),
    dataPlanes: [plane],
    onEvent: (event) => {
      events.push(event)
    }
  }).enqueue({
    transferId: 'primary-error',
    direction: 'local',
    hostKey: 'local',
    dataPlaneId: plane.id,
    source: { kind: 'local-path', path: source },
    destination: { kind: 'local-path', path: join(root, 'result.bin') }
  })
  const outcome = handle.completion.catch((error: unknown) => error)
  try {
    assert.equal(
      await Promise.race([started.promise.then(() => 'closing'), outcome.then(() => 'settled')]),
      'closing'
    )
    assert.equal(
      events.some((event) => event.state === 'failed'),
      false
    )
    drain.resolve()
    assert.equal(await outcome, primary)
    assert.equal(closes, 1)
  } finally {
    drain.resolve()
    await outcome
    rmSync(root, { recursive: true, force: true })
  }
})

test('protocol drain preserves fail-triggered close rejection even when the actual process has closed', async () => {
  const requested = deferred()
  const process = capableUploadHelper(
    { files: new Map(), binaryChunkSizes: [], maxJsonBytes: 0 },
    {
      onRequest() {
        requested.resolve()
        return true
      }
    }
  )
  const originalClose = process.close.bind(process)
  const closeFailure = new Error('synthetic physical-close command rejection')
  let closes = 0
  process.close = async () => {
    closes += 1
    await originalClose()
    throw closeFailure
  }
  const client = new HelperDataPlaneProtocolClient(process)
  const abort = new AbortController()
  const outcome = client
    .request('protocol.negotiate', { minVersion: 1, maxVersion: 1 }, { signal: abort.signal })
    .catch((error: unknown) => error)
  try {
    await requested.promise
    abort.abort()
    assert.equal(((await outcome) as Error).name, 'AbortError')
    await process.closed
    const drain = Reflect.get(client, 'drain') as (() => Promise<void>) | undefined
    assert.equal(
      typeof drain,
      'function',
      'logical failure must retain a joinable physical close outcome'
    )
    await assert.rejects(drain!.call(client), (error: unknown) => error === closeFailure)
    assert.equal(closes, 1, 'drain must observe the original close attempt, not execute it again')
  } finally {
    abort.abort()
    await outcome
    await originalClose()
    await process.closed
  }
})

test('manager keeps the same-host queue lease until the preceding physical drain completes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-drain-queue-'))
  const closing = deferred()
  const drained = deferred()
  const local = new LocalTransferDataPlane()
  const events: TransferEvent[] = []
  const plane: TransferDataPlane = {
    id: 'owned-local',
    destinationKey: (request) => local.destinationKey(request),
    async open(request) {
      const session = await local.open(request)
      return new Proxy(session, {
        get(target, property, receiver) {
          if (property === 'close')
            return async () => {
              if (request.transferId === 'first') {
                closing.resolve()
                await drained.promise
              }
            }
          const value = Reflect.get(target, property, receiver) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
  const manager = new FileTransferManager({
    registry: new FileTransferRegistry(join(root, 'registry.json')),
    dataPlanes: [plane],
    onEvent: (event) => {
      events.push(event)
    }
  })
  const request = (id: string): TransferRequest => {
    const source = join(root, id + '.source')
    writeFileSync(source, id)
    return {
      transferId: id,
      dataPlaneId: plane.id,
      direction: 'local',
      hostKey: 'same-host',
      source: { kind: 'local-path', path: source },
      destination: { kind: 'local-path', path: join(root, id + '.saved') }
    }
  }
  const first = manager.enqueue(request('first'))
  const second = manager.enqueue(request('second'))
  try {
    assert.equal(
      await Promise.race([
        closing.promise.then(() => 'closing'),
        first.completion.then(() => 'settled')
      ]),
      'closing'
    )
    assert.equal(manager.getState('second'), 'queued')
    assert.equal(
      events.some((event) => event.transferId === 'first' && event.state === 'saved'),
      false
    )
    drained.resolve()
    await Promise.all([first.completion, second.completion])
    assert.equal(readFileSync(join(root, 'first.saved'), 'utf8'), 'first')
    assert.equal(readFileSync(join(root, 'second.saved'), 'utf8'), 'second')
  } finally {
    drained.resolve()
    await Promise.allSettled([first.completion, second.completion])
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancel during a paused run drain completes owned discard instead of leaving completion pending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-pause-drain-cancel-'))
  const copying = deferred()
  const closing = deferred()
  const drained = deferred()
  const local = new LocalTransferDataPlane()
  const source = join(root, 'source')
  writeFileSync(source, 'never published')
  const registry = new FileTransferRegistry(join(root, 'registry.json'))
  let copies = 0
  const plane: TransferDataPlane = {
    id: 'owned-local',
    destinationKey: (request) => local.destinationKey(request),
    async open(request) {
      const session = await local.open(request)
      return new Proxy(session, {
        get(target, property, receiver) {
          if (property === 'copy')
            return async (options: TransferCopyOptions) => {
              copies += 1
              copying.resolve()
              await new Promise<never>((_resolve, reject) => {
                const abort = (): void =>
                  reject(new TransferError('ABORTED', 'synthetic copy cancelled'))
                options.signal.addEventListener('abort', abort, { once: true })
                if (options.signal.aborted) abort()
              })
            }
          if (property === 'close')
            return async () => {
              closing.resolve()
              await drained.promise
            }
          const value = Reflect.get(target, property, receiver) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
  const manager = new FileTransferManager({ registry, dataPlanes: [plane] })
  const handle = manager.enqueue({
    transferId: 'pause-race',
    dataPlaneId: plane.id,
    direction: 'local',
    hostKey: 'local',
    source: { kind: 'local-path', path: source },
    destination: { kind: 'local-path', path: join(root, 'saved') }
  })
  const outcome = handle.completion.catch((error: unknown) => error)
  try {
    await copying.promise
    handle.pause()
    await closing.promise
    assert.notEqual(manager.getState('pause-race'), 'paused')
    handle.cancel({ discardPartial: true })
    handle.cancel({ discardPartial: true })
    drained.resolve()
    assert.equal(((await outcome) as TransferError).code, 'ABORTED')
    assert.equal(manager.getState('pause-race'), 'cancelled')
    assert.deepEqual(await registry.list(), [])
    assert.equal(existsSync(join(root, 'saved')), false)
    assert.equal(existsSync(join(root, '.saved.phi-transfer-pause-race.part')), false)
    assert.equal(copies, 1)
  } finally {
    drained.resolve()
    handle.cancel({ discardPartial: true })
    await outcome
    rmSync(root, { recursive: true, force: true })
  }
})

test('a close failure cannot emit saved or resolve a successful transfer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-close-rejected-'))
  const source = join(root, 'source')
  writeFileSync(source, 'published before cleanup')
  const local = new LocalTransferDataPlane()
  const closeFailure = new TransferError(
    'TRANSFER_FAILED',
    'synthetic teardown could not be confirmed'
  )
  const events: TransferEvent[] = []
  const plane: TransferDataPlane = {
    id: 'owned-local',
    destinationKey: (request) => local.destinationKey(request),
    async open(request) {
      const session = await local.open(request)
      return new Proxy(session, {
        get(target, property, receiver) {
          if (property === 'close')
            return async () => {
              throw closeFailure
            }
          const value = Reflect.get(target, property, receiver) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
  try {
    const manager = new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [plane],
      onEvent: (event) => {
        events.push(event)
      }
    })
    await assert.rejects(
      manager.enqueue({
        transferId: 'close-rejected',
        dataPlaneId: plane.id,
        direction: 'local',
        hostKey: 'local',
        source: { kind: 'local-path', path: source },
        destination: { kind: 'local-path', path: join(root, 'saved') }
      }).completion,
      (error: unknown) => error === closeFailure
    )
    assert.equal(manager.getState('close-rejected'), 'failed')
    assert.equal(
      events.some((event) => event.state === 'saved'),
      false
    )
    assert.equal(readFileSync(join(root, 'saved'), 'utf8'), 'published before cleanup')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancelling metadata negotiation closes and joins its owned process without late dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-initialize-cancel-'))
  const source = join(root, 'source')
  writeFileSync(source, 'not uploaded')
  const negotiating = deferred()
  const closing = deferred()
  const finishes: Array<() => void> = []
  const processes: RemoteStdioProcess[] = []
  const methods: string[] = []
  const events: TransferEvent[] = []
  const state = { files: new Map<string, Buffer>(), binaryChunkSizes: [], maxJsonBytes: 0 }
  let cleaning = false
  const plane = new HelperTransferDataPlane({
    hostId: 'owned-host',
    workspaceId: 'owned-workspace',
    remoteRoot: '/srv/owned',
    canonicalRoot: '/srv/owned',
    connect: async () => {
      const id = processes.length + 1
      const process = capableUploadHelper(state, {
        onRequest(request) {
          methods.push(request.method)
          if (id === 2 && request.method === 'protocol.negotiate') {
            negotiating.resolve()
            return true
          }
          return false
        },
        onClose(finish) {
          if (!cleaning && id === 2) {
            finishes.push(finish)
            closing.resolve()
          } else finish()
        }
      })
      processes.push(process)
      return process
    },
    fallback: {
      id: 'ssh',
      destinationKey: () => 'fallback',
      async open() {
        throw new Error('unexpected fallback')
      }
    }
  })
  const registry = new FileTransferRegistry(join(root, 'registry.json'))
  const handle = new FileTransferManager({
    registry,
    dataPlanes: [plane],
    onEvent: (event) => {
      events.push(event)
    }
  }).enqueue({
    transferId: 'initialization-cancel',
    dataPlaneId: plane.id,
    direction: 'upload',
    hostKey: 'owned-host',
    source: { kind: 'local-path', path: source },
    destination: {
      kind: 'remote-workspace-path',
      hostId: 'owned-host',
      workspaceId: 'owned-workspace',
      relativePath: 'result.bin'
    }
  })
  let settled = false
  const outcome = handle.completion.catch((error: unknown) => {
    settled = true
    return error
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await negotiating.promise
    handle.cancel()
    await Promise.race([
      closing.promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('cancel did not close the initializing metadata channel')),
          2000
        )
      })
    ])
    clearTimeout(timer)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    assert.equal(
      events.some((event) => event.state === 'cancelled'),
      false
    )
    for (const finish of finishes.splice(0)) finish()
    assert.equal(((await outcome) as TransferError).code, 'ABORTED')
    assert.equal(processes.length, 2)
    assert.deepEqual(
      methods.filter((method) => method !== 'protocol.negotiate'),
      []
    )
    assert.deepEqual(await registry.list(), [])
  } finally {
    clearTimeout(timer)
    cleaning = true
    for (const finish of finishes.splice(0)) finish()
    await Promise.all(processes.map((process) => process.close()))
    await Promise.all(processes.map((process) => process.closed))
    await outcome
    rmSync(root, { recursive: true, force: true })
  }
})

for (const failure of ['reject', 'ssh255', 'local-signal'] as const) {
  for (const action of ['publish', 'cancel'] as const) {
    test(`unconfirmed metadata drain ${failure} after ${action} quarantines the same-host lease without blocking another host`, async () => {
      let originalClosed = false
      let writes = 0
      const checkpoint = deferred()
      const f = createHelperUploadFixture({
        planeId: 'owned-helper',
        onRequest(_id, request) {
          if (action === 'cancel' && request.method === 'fs.writeAtomic' && ++writes === 2) {
            checkpoint.resolve()
            return true
          }
          return false
        },
        transformProcess(id, process) {
          if (id !== 2) return process
          void process.closed.then(() => {
            originalClosed = true
          })
          let resolveClosed!: (value: { code: number | null; signal: string | null }) => void
          let rejectClosed!: (reason: Error) => void
          const closed = new Promise<{ code: number | null; signal: string | null }>(
            (resolve, reject) => {
              resolveClosed = resolve
              rejectClosed = reject
            }
          )
          void closed.catch(() => undefined)
          return {
            ...process,
            closed,
            close: async () => {
              if (failure === 'reject') {
                rejectClosed(new Error('synthetic closed observation rejected'))
                throw new Error('synthetic close command rejected')
              }
              resolveClosed(
                failure === 'ssh255'
                  ? { code: 255, signal: null }
                  : { code: null, signal: 'SIGTERM' }
              )
            }
          }
        }
      })
      const peer = createHelperUploadFixture({ identity: 'different-host', planeId: 'peer-helper' })
      const manager = new FileTransferManager({
        registry: f.registry,
        dataPlanes: [f.plane, peer.plane]
      })
      const first = manager.enqueue(f.request)
      assert.equal(f.request.destination.kind, 'remote-workspace-path')
      const second = manager.enqueue({
        ...f.request,
        transferId: 'same-host-second',
        destination: { ...f.request.destination, relativePath: 'second.bin' }
      })
      const other = manager.enqueue({ ...peer.request, transferId: 'different-host-peer' })
      const firstOutcome = first.completion.catch((error: unknown) => error)
      const secondOutcome = second.completion.catch((error: unknown) => error)
      try {
        if (action === 'cancel') {
          await checkpoint.promise
          first.cancel({ discardPartial: true })
        }
        await firstOutcome
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert.notEqual(manager.getState(f.request.transferId), 'saved')
        assert.equal(originalClosed, false)
        if (action === 'cancel') {
          assert.equal(
            f.processes.length,
            3,
            'unknown remote exit cannot open a cleanup connection'
          )
          assert.equal(
            f.requests.some((request) => request.method === 'transfer.remove'),
            false
          )
          assert.equal(f.state.files.size, 2, 'unknown remote writer retains its sidecars')
        }
        assert.equal(
          manager.getState('same-host-second'),
          'queued',
          'an unconfirmed writer must keep the same-host queue lease'
        )
        assert.equal(
          manager.forget(f.request.transferId),
          false,
          'unknown ownership cannot be forgotten'
        )
        assert.equal((await other.completion).state, 'saved')
        assert.deepEqual(peer.state.files.get('result.bin'), peer.content)
        second.cancel()
        assert.equal(((await secondOutcome) as TransferError).code, 'ABORTED')
      } finally {
        second.cancel({ discardPartial: true })
        await Promise.allSettled([firstOutcome, secondOutcome, other.completion])
        await f.close()
        await peer.close()
      }
    })
  }
}

test('retention cleanup failure preserves the first checkpoint error and records safe cleanup uncertainty', async () => {
  let writes = 0
  let primaryFailed = false
  const f = createHelperUploadFixture({
    onRequest(_id, request, _respond, fail) {
      if (request.method === 'fs.writeAtomic' && ++writes === 2) {
        primaryFailed = true
        fail(request.id, 'HASH_MISMATCH', 'primary checkpoint rejection')
        return true
      }
      if (primaryFailed && request.method === 'transfer.inspect') {
        fail(
          request.id,
          'PERMISSION_DENIED',
          'secondary retention cleanup rejection; Authorization: Bearer synthetic-review-secret'
        )
        return true
      }
      return false
    }
  })
  try {
    const error = (await f.manager
      .enqueue(f.request)
      .completion.catch((reason: unknown) => reason)) as TransferError
    assert.equal(error.code, 'HASH_MISMATCH')
    assert.match(error.message, /^primary checkpoint rejection/)
    assert.match(error.message, /cleanup unconfirmed/)
    assert.match(error.message, /secondary retention cleanup rejection/)
    assert(!error.message.includes('synthetic-review-secret'))
    assert(error.cause instanceof AggregateError)
    assert.equal(error.cause.errors[0].message, 'primary checkpoint rejection')
    assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'cause'), false)
    assert(!JSON.stringify(error).includes('synthetic-review-secret'))
    assert.equal(
      f.requests.some((request) => request.method === 'transfer.publish'),
      false
    )
  } finally {
    await f.close()
  }
})
