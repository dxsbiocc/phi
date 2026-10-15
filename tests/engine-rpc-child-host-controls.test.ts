import assert from 'node:assert/strict'
import test from 'node:test'
import { childHostControlFixture } from './helpers/childHostControlFixture'
import { deferred } from './helpers/rpc-initialization-wire'
import { childScope } from './helpers/rpcChildAuthorityFixture'
import { createRpcChildCall } from '../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
import { hostResultPlaceholder } from '../src/main/agent/engine/phi-extension/lib/rpc-host-result-protocol'

test('host execution waits for the actual approval write and consumption waits for its result write', async (t) => {
  const f = await childHostControlFixture()
  t.after(() => f.authority.dispose())
  const call = f.call()
  const approve = f.request({ operation: 'approve', call })
  assert.equal((await f.authority.accept(approve, f.signal))?.allowed, true)
  const execute = f.request({ operation: 'execute', call })
  const operation = f.authority.accept(execute, f.signal)!
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.executed.length, 0)
  f.authority.completeReply(approve, true, true)
  const reply = await operation
  assert.equal(reply.allowed, true)
  assert.equal(reply.result?.runId, f.authority.registry.snapshot()[0].id)
  assert.equal(reply.result?.invocationId, execute.id)
  const consumed = f.request({ operation: 'result_consumed', call, invocationId: execute.id })
  const consuming = f.authority.accept(consumed, f.signal)!
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.consumed, [])
  f.authority.completeReply(execute, true, true)
  assert.equal((await consuming).allowed, true)
  assert.deepEqual(f.consumed, [execute.id])
  assert.throws(
    () =>
      f.authority.accept(
        f.request({ operation: 'result_consumed', call, invocationId: execute.id }),
        f.signal
      ),
    /not bound/
  )
  assert.deepEqual(f.executed, [execute.id])
})

test('an uncommitted or dynamically revoked approval never executes a child host tool', async (t) => {
  for (const revoke of [false, true]) {
    let classified = true
    const f = await childHostControlFixture({
      approval: {
        classifyTool: () => (classified ? 'exec' : undefined),
        shouldGate: () => true,
        requestToolApproval: () => 'approved'
      }
    })
    t.after(() => f.authority.dispose())
    const call = f.call(),
      approve = f.request({ operation: 'approve', call })
    await f.authority.accept(approve, f.signal)
    f.authority.completeReply(approve, revoke, revoke)
    if (revoke) classified = false
    const execute = f.request({ operation: 'execute', call })
    if (revoke) assert.equal((await f.authority.accept(execute, f.signal))?.allowed, false)
    else assert.throws(() => f.authority.accept(execute, f.signal), /committed approval/)
    assert.deepEqual(f.executed, [])
  }
})

test('native tools and inline host results cannot cross the child host execution seam', async (t) => {
  const f = await childHostControlFixture({
    executeHost: async () => ({ content: [{ type: 'text', text: 'RAW_PRIVATE_RESULT' }] })
  })
  t.after(() => f.authority.dispose())
  const native = createRpcChildCall(childScope, 'native-call', 'write', {
    path: '/srv/project/out',
    content: 'x'
  })
  assert.throws(
    () => f.authority.accept(f.request({ operation: 'execute', call: native }), f.signal),
    /unavailable/
  )
  const call = f.call(),
    approve = f.request({ operation: 'approve', call })
  await f.authority.accept(approve, f.signal)
  f.authority.completeReply(approve, true, true)
  const reply = await f.authority.accept(f.request({ operation: 'execute', call }), f.signal)
  assert.equal(reply?.allowed, false)
  assert.equal(JSON.stringify(reply).includes('RAW_PRIVATE_RESULT'), false)
})

test('native abort acknowledgement cannot finish cancellation before host execution and physical drain settle', async (t) => {
  const result = deferred<void>(),
    physical = deferred<void>()
  let started = false,
    drained = false,
    hostSignal: AbortSignal | undefined
  const f = await childHostControlFixture({
    executeHost: async (_run, _call, _id, signal) => {
      started = true
      hostSignal = signal
      await result.promise
      return hostResultPlaceholder()
    },
    drainHost: async () => {
      drained = true
      await physical.promise
    }
  })
  t.after(() => f.authority.dispose())
  const call = f.call(),
    approve = f.request({ operation: 'approve', call })
  await f.authority.accept(approve, f.signal)
  f.authority.completeReply(approve, true, true)
  const execute = f.request({ operation: 'execute', call })
  const executing = f.authority.accept(execute, f.signal)!
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started, true)
  let stopped = false
  const stopping = f.authority.cancelChild(childScope.nativeAgentId).then(() => {
    stopped = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.authority.registry.recordForNative(childScope.nativeAgentId)?.status, 'aborted')
  assert.equal(hostSignal?.aborted, true)
  assert.equal(stopped, false)
  assert.equal(drained, false)
  result.resolve()
  assert.equal((await executing).allowed, false)
  assert.deepEqual(
    f.consumed,
    [execute.id],
    'A late private result must release its retained delivery file'
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(drained, true)
  assert.equal(stopped, false)
  physical.resolve()
  await stopping
  assert.equal(stopped, true)
})
