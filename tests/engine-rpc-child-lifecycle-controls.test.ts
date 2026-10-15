import assert from 'node:assert/strict'
import test from 'node:test'
import { childLifecycleControlFixture } from './helpers/childLifecycleControlFixture'
import { deferred } from './helpers/rpc-initialization-wire'

test('verified child terminal facts survive revocation and duplicate frames notify only once', async (t) => {
  const f = await childLifecycleControlFixture()
  t.after(f.close)
  const scope = await f.activate()
  const changes: string[] = []
  f.authority.registry.onChange((record) => changes.push(record.status))
  const record = f.controls.status(scope.nativeAgentId)
  assert.equal(record.status, 'running')
  assert.equal(record.verified, true)
  f.authority.observe(f.lifecycle(scope, 'completed'))
  f.authority.observe(f.lifecycle(scope, 'completed'))
  assert.equal(f.controls.status(record.id).status, 'completed')
  assert.equal(f.authority.registry.snapshot().length, 0)
  assert.deepEqual(changes, ['completed'])
  assert.equal(Object.isFrozen(f.controls.status(record.id)), true)
})

test('waiting for one owned child never waits for or stops its peer', async (t) => {
  const f = await childLifecycleControlFixture()
  t.after(f.close)
  const a = await f.activate('child-a')
  const b = await f.activate('child-b')
  const waiting = f.controls.wait({ ids: [a.nativeAgentId], timeoutMs: 1000 })
  f.authority.observe(f.lifecycle(a, 'completed'))
  const result = await waiting
  assert.equal(result.timedOut, false)
  assert.equal(result.runs[0].status, 'completed')
  assert.equal(f.controls.status(b.nativeAgentId).status, 'running')
  assert.deepEqual(f.cancelled, [])
})

test('wait timeout and caller cancellation release only the wait', async (t) => {
  const f = await childLifecycleControlFixture()
  t.after(f.close)
  const scope = await f.activate()
  assert.equal((await f.controls.wait({ ids: [scope.nativeAgentId], timeoutMs: 0 })).timedOut, true)
  assert.equal((await f.controls.wait({ ids: [scope.nativeAgentId], timeoutMs: 5 })).timedOut, true)
  const caller = new AbortController()
  const waiting = f.controls.wait({ ids: [scope.nativeAgentId], signal: caller.signal })
  caller.abort(new Error('Only the wait ended'))
  await assert.rejects(waiting, /Only the wait ended/)
  assert.equal(f.controls.status(scope.nativeAgentId).status, 'running')
  assert.deepEqual(f.cancelled, [])
  assert.throws(() => f.controls.status('foreign-child'), /not owned/)
})

test('child and parent cancellation share the same physical native request and await the terminal', async (t) => {
  const gate = deferred<void>()
  const f = await childLifecycleControlFixture({ cancelGate: gate.promise })
  t.after(f.close)
  const scope = await f.activate()
  let ended = false
  const stopping = f.controls.stop(scope.nativeAgentId).then(() => {
    ended = true
  })
  const parent = f.authority.cancelParent('parent-run')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ended, false)
  assert.equal(f.cancelled.length, 1)
  gate.resolve()
  await Promise.all([stopping, parent])
  assert.equal(f.controls.status(scope.nativeAgentId).status, 'aborted')
  assert.equal(f.cancelled.length, 1)
})

test('a refused physical cancellation can be retried without replaying the task', async (t) => {
  const f = await childLifecycleControlFixture({ refuseFirstCancel: true })
  t.after(f.close)
  const scope = await f.activate()
  await assert.rejects(f.controls.stop(scope.nativeAgentId), /cancellation refused/)
  await f.controls.stop(scope.nativeAgentId)
  assert.equal(f.cancelled.length, 2)
  assert.equal(f.controls.status(scope.nativeAgentId).status, 'aborted')
  assert.equal(
    f.wire.commands.some((command) => command.type === 'prompt'),
    false
  )
})

test('private steering targets only its attested child and does not require unrelated background settlement', async (t) => {
  const f = await childLifecycleControlFixture()
  t.after(f.close)
  const a = await f.activate('child-a')
  const b = await f.activate('child-b')
  await f.controls.steer(a.nativeAgentId, 'Use the existing result')
  assert.deepEqual(f.steered, [{ id: a.nativeAgentId, message: 'Use the existing result' }])
  assert.equal(f.controls.status(b.nativeAgentId).status, 'running')
  f.authority.observe(f.lifecycle(a, 'completed'))
  await assert.rejects(f.controls.steer(a.nativeAgentId, 'Too late'), /unavailable/)
  assert.equal(f.steered.length, 1)
})

test('an authenticated pending-steer refusal stays local and does not retire the child generation', async (t) => {
  const f = await childLifecycleControlFixture({ steerBusyOnce: true })
  t.after(f.close)
  const scope = await f.activate()
  await assert.rejects(
    f.controls.steer(scope.nativeAgentId, 'Previous message is still queued'),
    /busy/
  )
  assert.equal(f.controls.status(scope.nativeAgentId).status, 'running')
  await f.controls.steer(scope.nativeAgentId, 'Queue after the previous message was consumed')
  assert.equal(f.controls.status(scope.nativeAgentId).status, 'running')
  assert.deepEqual(f.cancelled, [])
})
