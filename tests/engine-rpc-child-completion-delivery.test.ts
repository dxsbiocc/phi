import assert from 'node:assert/strict'
import test from 'node:test'
import { ProductionChildRuntime } from '../src/main/agent/engine/rpc/subagents/production-child-runtime'
import { makeRpcTaskLaunchReceipt } from '../src/main/agent/engine/phi-extension/lib/rpc-task-launch-protocol'
import { productionChildControlWire, controlExchange } from './helpers/productionChildControlWire'
import { deferred } from './helpers/rpc-initialization-wire'

test('terminal background delivery remains busy through physical drain and durable parent notification', async (t) => {
  const f = await productionChildControlWire({ background: true })
  t.after(f.close)
  const drained = deferred<void>(),
    delivered = deferred<void>()
  let drainStarted = false,
    notifications = 0
  const child = await ProductionChildRuntime.create({
    connection: f.connection,
    execution: f.execution,
    prepared: f.prepared,
    root: f.root,
    currentParentRun: () => f.parent.run,
    approval: { shouldGate: () => true, requestToolApproval: () => 'approved' },
    onDenied: () => assert.fail('No denial expected'),
    onError: (error) => assert.fail(error.message),
    signal: f.connection.bindControl().signal,
    drainHost: async () => {
      drainStarted = true
      await drained.promise
    },
    onChildFinished: async () => {
      notifications++
      await delivered.promise
    }
  })
  t.after(() => child.dispose())
  await f.execution.beginRun(f.parent.run.runId)
  f.origin()
  const origin = f.originMessage()!
  f.wire.emit({
    type: 'extension_ui_request',
    method: 'notify',
    notifyType: 'info',
    message: JSON.stringify(
      makeRpcTaskLaunchReceipt(f.prepared.config, f.root, {
        parentRunId: origin.runId,
        controlSequence: origin.sequence,
        toolCallId: origin.toolCallId,
        inputDigest: origin.inputDigest,
        declaredTaskCount: 1,
        expectedTaskCount: 1,
        dispatchSealed: true
      })
    )
  })
  f.wire.emit(f.lifecycle('started'))
  assert.equal(await controlExchange(f, f.request('register', 1)), true)
  assert.equal(await controlExchange(f, f.request('activate', 2)), true)
  const run = child.listRuns()[0]
  f.wire.emit(f.lifecycle('completed'))
  assert.equal(child.status(run.id).status, 'completed')
  assert.equal(child.hasActiveChildren(), true)
  let reportable = false
  const report = child.awaitChildCompletionDelivery(run.id).then(() => {
    reportable = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(drainStarted, true)
  assert.equal(notifications, 0)
  assert.equal(reportable, false)
  drained.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(notifications, 1)
  assert.equal(child.hasActiveChildren(), true)
  assert.equal(reportable, false)
  delivered.resolve()
  await report
  assert.equal(child.hasActiveChildren(), false)
  f.wire.emit(f.lifecycle('completed'))
  await child.awaitChildCompletionDelivery(run.id)
  assert.equal(notifications, 1)
})
