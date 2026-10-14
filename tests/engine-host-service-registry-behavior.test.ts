import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { OmpBridge } from '../src/main/agent/engine/omp-bridge'

function bridge(): OmpBridge {
  return new OmpBridge(() =>
    spawn(process.execPath, [join(process.cwd(), 'tests/helpers/fakeOmpWorker.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
  )
}
function invoke(
  bridge: OmpBridge,
  method: string,
  hostParams: unknown = {},
  context?: unknown
): Promise<unknown> {
  return bridge.request('test.hostRequest', { method, hostParams, context })
}

test('host service replacement unregister cannot remove its successor', async () => {
  const instance = bridge()
  try {
    const old = instance.registerHostHandler('read', () => 'old')
    const next = instance.registerHostHandler('read', () => 'next')
    old()
    assert.equal(await invoke(instance, 'read'), 'next')
    next()
    await assert.rejects(invoke(instance, 'read'), /Unknown host request method: read/)
    next()
  } finally {
    await instance.stop()
  }
})

test('host dispatch preserves params/context and synchronous and asynchronous errors', async () => {
  const instance = bridge()
  try {
    instance.registerHostHandler('read', (params, context) => ({ params, context }))
    assert.deepEqual(
      await invoke(
        instance,
        'read',
        { value: { count: 2 } },
        { originSessionId: 'runtime', toolCallId: 'call', agentRunId: 'run', ignored: 'no' }
      ),
      {
        params: { value: { count: 2 } },
        context: { originSessionId: 'runtime', toolCallId: 'call', agentRunId: 'run' }
      }
    )
    instance.registerHostHandler('sync', () => {
      throw new Error('sync failure')
    })
    instance.registerHostHandler('async', async () => {
      throw new Error('async failure')
    })
    await assert.rejects(invoke(instance, 'sync'), /sync failure/)
    await assert.rejects(invoke(instance, 'async'), /async failure/)
  } finally {
    await instance.stop()
  }
})

test('late host rejection after stop does not affect a replacement worker', async () => {
  const instance = bridge()
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  let reject!: (error: Error) => void
  const operation = new Promise<never>((_resolve, fail) => {
    reject = fail
  })
  instance.registerHostHandler('held', () => {
    started()
    return operation
  })
  try {
    const pending = invoke(instance, 'held')
    const rejected = assert.rejects(pending, /OMP worker stopped/)
    await entered
    await instance.stop()
    await rejected
    await instance.request('session.create', { sessionId: 'replacement' })
    reject(new Error('late host error'))
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(instance.hasSession('replacement'), true)
    await instance.request('session.prompt', { sessionId: 'replacement' })
    assert.equal(
      await invoke(instance, 'missing').catch((error: Error) => error.message),
      'Unknown host request method: missing'
    )
  } finally {
    await instance.stop()
  }
})
