import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { RpcSessionBackend } from '../src/main/agent/engine/rpc/rpc-session-backend'
import { createInitializationWire, deferred } from './helpers/rpc-initialization-wire'

const params = { sessionId: 'session', cwd: '/project', agentDir: '/unused' }

test('generation preparation has an independent budget before the unchanged handshake deadline', async () => {
  let ready = false
  let cleaned = 0
  const backend = new RpcSessionBackend(
    () => {
      assert.equal(ready, true)
      return createInitializationWire().transport
    },
    {
      startupTimeoutMs: 10,
      preparationTimeoutMs: 200,
      async prepare() {
        await delay(40)
        ready = true
        return () => {
          cleaned++
        }
      }
    }
  )
  await backend.create(params)
  await backend.dispose(params)
  assert.equal(cleaned, 1)
})

test('preparation timeout cancels immediately and cleans a late acquisition without opening RPC', async () => {
  const gate = deferred<() => void>()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let signal!: AbortSignal
  let opens = 0
  let cleaned = 0
  const backend = new RpcSessionBackend(
    () => {
      opens++
      return createInitializationWire().transport
    },
    {
      preparationTimeoutMs: 20,
      prepare(_params, ownedSignal) {
        signal = ownedSignal
        entered()
        return gate.promise
      }
    }
  )
  const creation = backend.create(params)
  await started
  await assert.rejects(creation, /RPC preparation timed out/)
  assert.equal(signal.aborted, true)
  assert.equal(backend.has(params.sessionId), false)
  gate.resolve(() => {
    cleaned++
  })
  await delay(1)
  assert.equal(cleaned, 1)
  assert.equal(opens, 0)
})

test('dispose during preparation and a late failing cleanup preserve a replacement of the same id', async () => {
  const gate = deferred<() => void>()
  let prepared = 0
  let cleaned = 0
  const backend = new RpcSessionBackend(() => createInitializationWire().transport, {
    prepare() {
      if (++prepared === 1) return gate.promise
      return () => {
        cleaned++
      }
    }
  })
  const creation = backend.create(params)
  const rejected = assert.rejects(creation, /disposed/)
  await delay(1)
  await backend.dispose(params)
  await backend.create(params)
  gate.resolve(() => {
    throw new Error('old cleanup failed')
  })
  await rejected
  await delay(1)
  assert.equal(backend.has(params.sessionId), true)
  await backend.dispose(params)
  assert.equal(cleaned, 1)
})

test('cancel after preparation returns but before open runs releases resources without a channel', async () => {
  let opened = 0
  let cleaned = 0
  const backend = new RpcSessionBackend(
    () => {
      opened++
      return createInitializationWire().transport
    },
    {
      prepare() {
        queueMicrotask(() => {
          void backend.dispose(params)
        })
        return () => {
          cleaned++
        }
      }
    }
  )
  await assert.rejects(backend.create(params), /disposed/)
  assert.equal(opened, 0)
  assert.equal(cleaned, 1)
})

test('RPC start and initialization failures release prepared resources and preserve original errors', async () => {
  for (const stage of ['open', 'initialize']) {
    const expected = new Error(`${stage} failed`)
    let cleaned = 0
    const backend = new RpcSessionBackend(
      () => {
        if (stage === 'open') throw expected
        return createInitializationWire().transport
      },
      {
        prepare: () => () => {
          cleaned++
        },
        initialize: () => {
          throw expected
        }
      }
    )
    await assert.rejects(backend.create(params), (error) => error === expected)
    assert.equal(cleaned, 1)
    assert.equal(backend.has(params.sessionId), false)
  }
})

test('preparation errors are preserved and invalid independent budgets are rejected', async () => {
  const expected = new Error('model configuration unavailable')
  const backend = new RpcSessionBackend(() => createInitializationWire().transport, {
    prepare: () => {
      throw expected
    }
  })
  await assert.rejects(backend.create(params), (error) => error === expected)
  for (const preparationTimeoutMs of [0, -1, NaN, Infinity])
    assert.throws(
      () =>
        new RpcSessionBackend(() => createInitializationWire().transport, { preparationTimeoutMs }),
      /preparation timeout/
    )
})

test('disconnect invokes prepared cleanup once and an unresponsive cleanup cannot block disposal indefinitely', async () => {
  const wire = createInitializationWire()
  let cleaned = 0
  const backend = new RpcSessionBackend(() => wire.transport, {
    closeTimeoutMs: 20,
    prepare: () => () => {
      cleaned++
      return new Promise<void>(() => undefined)
    }
  })
  await backend.create(params)
  wire.disconnect()
  await Promise.race([
    backend.dispose(params),
    delay(500).then(() => {
      throw new Error('Prepared cleanup blocked disposal')
    })
  ])
  assert.equal(cleaned, 1)
})
