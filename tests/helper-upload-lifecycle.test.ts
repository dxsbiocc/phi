import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { HelperUploadSession } from '../src/main/agent/transfer/helper-data-plane-upload'
import { HelperDataPlaneProtocolClient } from '../src/main/agent/transfer/helper-data-plane-protocol'
import { TransferError } from '../src/main/agent/transfer/errors'
import type { RemoteStdioProcess } from '../src/main/agent/wrappers/remote-ssh-session'
import {
  capableUploadHelper,
  createHelperUploadFixture as uploadFixture
} from './helpers/helperDataPlaneFixture'

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((done) => {
      resolve = done
    }),
    resolve
  }
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for helper lifecycle barrier')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('small upload reuses one metadata connection without changing framed effects or RPC order', async () => {
  const f = uploadFixture()
  try {
    const result = await f.manager.enqueue(f.request).completion
    assert.equal(result.sha256, digest(f.content))
    assert.deepEqual(f.state.files.get('result.bin'), f.content)
    assert.deepEqual([...f.state.files.keys()], ['result.bin'])
    assert.deepEqual(f.state.binaryChunkSizes, [1024])
    assert.deepEqual(
      f.requests
        .filter((entry) => entry.method !== 'protocol.negotiate')
        .map((entry) => entry.method),
      [
        'transfer.inspect',
        'transfer.inspect',
        'transfer.inspect',
        'transfer.inspect',
        'transfer.create',
        'fs.writeAtomic',
        'transfer.inspect',
        'transfer.inspect',
        'transfer.upload.open',
        'transfer.sync',
        'fs.writeAtomic',
        'transfer.inspect',
        'transfer.sync',
        'transfer.close',
        'transfer.inspect',
        'transfer.hash',
        'transfer.publish',
        'transfer.remove'
      ]
    )
    const manifests = f.requests
      .filter((entry) => entry.method === 'fs.writeAtomic')
      .map((entry) =>
        JSON.parse(Buffer.from(String(entry.params.content), 'base64').toString('utf8'))
      )
    assert.deepEqual(
      manifests.map((manifest) => manifest.durableOffset),
      [0, 1024]
    )
    assert.deepEqual(await f.registry.list(), [])
    assert.equal(
      f.processes.length,
      3,
      'one capability probe, one metadata owner, one independent data channel'
    )
    assert.equal(
      f.physicallyClosed.size,
      3,
      'completion requires all three owned processes physically closed'
    )
    const data = f.requests.find((entry) => entry.method === 'transfer.upload.open')!.connection
    const metadata = new Set(
      f.requests
        .filter((entry) => entry.method !== 'protocol.negotiate' && entry.connection !== data)
        .map((entry) => entry.connection)
    )
    assert.equal(metadata.size, 1)
  } finally {
    await f.close()
  }
})

test('upload success and saved event wait for actual metadata process closure', async () => {
  const f = uploadFixture({
    holdClose: (_id, files) => files.size === 1 && files.has('result.bin')
  })
  const handle = f.manager.enqueue(f.request)
  let settled = false
  const completion = handle.completion.then((result) => {
    settled = true
    return result
  })
  void completion.catch(() => undefined)
  try {
    await Promise.all([f.closeRequested.promise, f.registryRemoved.promise])
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(
      settled,
      false,
      'logical close must not settle a transfer before the actual closed event'
    )
    assert.equal(
      f.events.some((event) => event.state === 'saved'),
      false
    )
    f.release()
    assert.equal((await completion).state, 'saved')
    assert.equal(f.physicallyClosed.size, f.processes.length)
  } finally {
    f.release()
    await completion.catch(() => undefined)
    await f.close()
  }
})

test('metadata negotiation failure joins its partially opened process before failure settlement', async () => {
  const f = uploadFixture({
    holdClose: (id) => id === 2,
    onRequest(id, request, _respond, fail) {
      if (id === 2 && request.method === 'protocol.negotiate') {
        fail(request.id, 'PERMISSION_DENIED', 'synthetic metadata negotiation denied')
        return true
      }
      return false
    }
  })
  let settled = false
  const outcome = f.manager.enqueue(f.request).completion.catch((error: unknown) => {
    settled = true
    return error
  })
  try {
    await f.closeRequested.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(
      settled,
      false,
      'the producer must join a failed negotiation process it never returned to the session'
    )
    assert.equal(
      f.events.some((event) => event.state === 'failed'),
      false
    )
    f.release()
    assert.match(
      String(((await outcome) as Error).message),
      /synthetic metadata negotiation denied/
    )
    assert.deepEqual([...f.state.files.keys()], [])
    assert.deepEqual(await f.registry.list(), [])
  } finally {
    f.release()
    await outcome
    await f.close()
  }
})

test('cancelled metadata permits only explicit owned cleanup while a peer completes', async () => {
  const hashing = deferred()
  const f = uploadFixture({
    onRequest(_id, request) {
      if (request.method === 'transfer.hash') {
        hashing.resolve()
        return true
      }
      return false
    }
  })
  const peer = uploadFixture({ identity: 'peer-host' })
  const handle = f.manager.enqueue(f.request)
  const outcome = handle.completion.catch((error: unknown) => error)
  try {
    await hashing.promise
    assert.equal((await peer.manager.enqueue(peer.request).completion).sha256, digest(peer.content))
    handle.cancel({ discardPartial: true })
    assert.equal(((await outcome) as TransferError).code, 'ABORTED')
    assert.equal(
      f.requests.some((request) => request.method === 'transfer.publish'),
      false
    )
    assert.deepEqual([...f.state.files.keys()], [])
    assert.deepEqual(await f.registry.list(), [])
    assert.equal(f.processes.length, 4, 'only cancellation may add one cleanup-only connection')
    const cleanup = f.requests.filter(
      (request) => request.connection === 4 && request.method !== 'protocol.negotiate'
    )
    assert.deepEqual(
      cleanup.map((request) => request.method),
      ['transfer.remove', 'transfer.remove']
    )
    assert.equal(f.physicallyClosed.size, 4)
    assert.deepEqual(peer.state.files.get('result.bin'), peer.content)
  } finally {
    handle.cancel({ discardPartial: true })
    await outcome
    await f.close()
    await peer.close()
  }
})

test('pause drains metadata before state emit and paused discard joins its explicit cleanup connection', async () => {
  const dataOpening = deferred()
  let holdCleanup = false
  const f = uploadFixture({
    holdClose: (id) => id === 2 || (holdCleanup && id === 4),
    onRequest(_id, request) {
      if (request.method === 'transfer.upload.open') {
        dataOpening.resolve()
        return true
      }
      return false
    }
  })
  const handle = f.manager.enqueue(f.request)
  let settled = false
  const outcome = handle.completion.catch((error: unknown) => {
    settled = true
    return error
  })
  try {
    await dataOpening.promise
    handle.pause()
    await f.pausedPersisted.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.notEqual(
      f.manager.getState(f.request.transferId),
      'paused',
      'paused must not become resumable before owned metadata has drained'
    )
    assert.equal(
      f.events.some((event) => event.state === 'paused'),
      false
    )
    f.release()
    await waitFor(() => f.manager.getState(f.request.transferId) === 'paused')
    holdCleanup = true
    handle.cancel({ discardPartial: true })
    await waitFor(() => f.heldCloseIds.includes(4))
    assert.equal(settled, false)
    assert.equal(
      f.events.some((event) => event.state === 'cancelled'),
      false
    )
    f.release()
    assert.equal(((await outcome) as TransferError).code, 'ABORTED')
    assert.deepEqual([...f.state.files.keys()], [])
    assert.deepEqual(await f.registry.list(), [])
    assert.equal(f.processes.length, 4)
    assert.equal(f.physicallyClosed.size, 4)
    assert.equal(
      f.requests.filter((request) => request.method === 'transfer.upload.open').length,
      1
    )
    assert.equal(
      f.requests.some((request) => request.method === 'transfer.publish'),
      false
    )
  } finally {
    f.release()
    handle.cancel({ discardPartial: true })
    await outcome
    await f.close()
  }
})

test('closing during metadata initialization drains the late process without dispatch or reopen', async () => {
  const f = uploadFixture()
  const opening = deferred()
  const started = deferred()
  const closeRequested = deferred()
  const processes: RemoteStdioProcess[] = []
  const finishes: Array<() => void> = []
  const methods: string[] = []
  let cleaning = false
  const connect = async (): Promise<{
    client: HelperDataPlaneProtocolClient
    maxWindow: number
  }> => {
    const process = capableUploadHelper(f.state, {
      onRequest(request) {
        methods.push(request.method)
        return false
      },
      onClose(finish) {
        if (cleaning) finish()
        else {
          finishes.push(finish)
          closeRequested.resolve()
        }
      }
    })
    processes.push(process)
    started.resolve()
    await opening.promise
    const client = new HelperDataPlaneProtocolClient(process)
    await client.request('protocol.negotiate', { minVersion: 1, maxVersion: 1 })
    return { client, maxWindow: 2 }
  }
  const session = new HelperUploadSession(
    f.request,
    {
      hostId: 'lifecycle-host',
      workspaceId: 'lifecycle-host-workspace',
      remoteRoot: '/srv/project',
      canonicalRoot: '/srv/project',
      connect: async () => {
        throw new Error('only the negotiated callback may be used')
      },
      fallback: {
        id: 'ssh',
        destinationKey: () => 'fallback',
        async open() {
          throw new Error('unexpected fallback')
        }
      }
    },
    connect
  )
  const preparing = session.preflight(new AbortController().signal)
  void preparing.catch(() => undefined)
  try {
    await started.promise
    const close = Reflect.get(session, 'close') as (() => Promise<void>) | undefined
    assert.equal(
      typeof close,
      'function',
      'the session must own a public idempotent close lifecycle'
    )
    let settled = false
    const drain = close!.call(session).then(() => {
      settled = true
    })
    const repeated = close!.call(session)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    opening.resolve()
    await closeRequested.promise
    assert.equal(settled, false, 'the late actual process is still physically open')
    assert.deepEqual(
      methods.filter((method) => method !== 'protocol.negotiate'),
      []
    )
    for (const finish of finishes.splice(0)) finish()
    await Promise.all([drain, repeated])
    await assert.rejects(preparing)
    assert.equal(processes.length, 1)
  } finally {
    cleaning = true
    opening.resolve()
    for (const finish of finishes.splice(0)) finish()
    await Promise.all(processes.map((process) => process.close()))
    await Promise.all(processes.map((process) => process.closed))
    await Promise.race([
      preparing.catch(() => undefined),
      new Promise<void>((resolve) => setImmediate(resolve))
    ])
    await f.close()
  }
})

test('broken metadata cannot implicitly reconnect or replay later normal or cleanup operations', async () => {
  const f = uploadFixture()
  const processes: RemoteStdioProcess[] = []
  let broken = false
  const connect = async (): Promise<{
    client: HelperDataPlaneProtocolClient
    maxWindow: number
  }> => {
    const process = capableUploadHelper(f.state, {
      onRequest(request) {
        if (!broken && request.method === 'transfer.inspect') {
          broken = true
          queueMicrotask(() => {
            void process.close()
          })
          return true
        }
        return false
      }
    })
    processes.push(process)
    const client = new HelperDataPlaneProtocolClient(process)
    await client.request('protocol.negotiate', { minVersion: 1, maxVersion: 1 })
    return { client, maxWindow: 2 }
  }
  const session = new HelperUploadSession(
    f.request,
    {
      hostId: 'lifecycle-host',
      workspaceId: 'lifecycle-host-workspace',
      remoteRoot: '/srv/project',
      canonicalRoot: '/srv/project',
      connect: async () => {
        throw new Error('only the negotiated callback may be used')
      },
      fallback: {
        id: 'ssh',
        destinationKey: () => 'fallback',
        async open() {
          throw new Error('unexpected fallback')
        }
      }
    },
    connect
  )
  try {
    await assert.rejects(session.preflight(new AbortController().signal))
    const opened = processes.length
    await assert.rejects(session.loadManifest())
    await assert.rejects(session.discard())
    assert.equal(processes.length, opened)
    assert.deepEqual([...f.state.files.keys()], [])
  } finally {
    const close = Reflect.get(session, 'close') as (() => Promise<void>) | undefined
    await close?.call(session).catch(() => undefined)
    await Promise.all(processes.map((process) => process.close()))
    await Promise.all(processes.map((process) => process.closed))
    await f.close()
  }
})

test('checkpoint pause retention and later discard each own a separately drained cleanup phase', async () => {
  const checkpoint = deferred()
  let writes = 0
  const f = uploadFixture({
    onRequest(_id, request) {
      if (request.method === 'fs.writeAtomic' && ++writes === 2) {
        checkpoint.resolve()
        return true
      }
      return false
    }
  })
  const handle = f.manager.enqueue(f.request)
  const outcome = handle.completion.catch((error: unknown) => error)
  try {
    await checkpoint.promise
    handle.pause()
    await waitFor(() => f.manager.getState(f.request.transferId) === 'paused')
    handle.cancel({ discardPartial: true })
    assert.equal(((await outcome) as TransferError).code, 'ABORTED')
    assert.deepEqual(
      [...f.state.files.keys()],
      [],
      'paused retention must not exhaust later discard authority'
    )
    assert.deepEqual(await f.registry.list(), [])
    assert.equal(f.processes.length, 5)
    assert.equal(f.physicallyClosed.size, 5)
    assert.deepEqual(
      f.requests
        .filter((request) => request.connection === 5 && request.method !== 'protocol.negotiate')
        .map((request) => request.method),
      ['transfer.remove', 'transfer.remove']
    )
  } finally {
    handle.cancel({ discardPartial: true })
    await outcome
    await f.close()
  }
})

test('cancel drains the original metadata writer before inspecting or deleting its sidecars', async () => {
  const checkpoint = deferred()
  const copied = deferred()
  let writes = 0
  let originalClosed = false
  let finishOriginal: (() => Promise<void>) | undefined
  let lateWrite: (() => void) | undefined
  let committed = false
  let removalsWhileOpen = 0
  const commit = (): void => {
    if (!committed) {
      committed = true
      lateWrite?.()
    }
  }
  const f = uploadFixture({
    transformProcess(id, process) {
      if (id !== 2) return process
      finishOriginal = process.close.bind(process)
      void process.closed.then(() => {
        originalClosed = true
      })
      return { ...process, close: async () => undefined }
    },
    onRequest(_id, request) {
      if (request.method === 'fs.writeAtomic' && ++writes === 2) {
        lateWrite = () => {
          f.state.files.set(
            String(request.params.path),
            Buffer.from(String(request.params.content), 'base64')
          )
        }
        checkpoint.resolve()
        return true
      }
      if (request.method === 'transfer.remove' && !originalClosed) removalsWhileOpen += 1
      return false
    }
  })
  const open = f.plane.open.bind(f.plane)
  f.plane.open = async (request) => {
    const session = await open(request)
    const copy = session.copy.bind(session)
    session.copy = async (options) => {
      try {
        return await copy(options)
      } finally {
        copied.resolve()
      }
    }
    return session
  }
  const handle = f.manager.enqueue(f.request)
  const outcome = handle.completion.catch((error: unknown) => error)
  try {
    await checkpoint.promise
    handle.cancel({ discardPartial: true })
    await copied.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(originalClosed, false)
    assert.equal(
      removalsWhileOpen,
      0,
      'cleanup must not race a still-running atomic metadata write'
    )
    commit()
    await finishOriginal!()
    assert.equal(((await outcome) as TransferError).code, 'ABORTED')
    assert.deepEqual([...f.state.files.keys()], [])
    assert.deepEqual(await f.registry.list(), [])
    assert.equal(f.processes.length, 4)
    assert.equal(f.physicallyClosed.size, 4)
  } finally {
    commit()
    await finishOriginal?.()
    handle.cancel({ discardPartial: true })
    await outcome
    await f.close()
  }
})
