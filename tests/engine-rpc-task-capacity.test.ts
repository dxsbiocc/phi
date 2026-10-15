import assert from 'node:assert/strict'
import test from 'node:test'
import { assertRpcChildTaskCapacity } from '../src/main/agent/engine/phi-extension/lib/rpc-task-capacity'
import { validateRpcForegroundTaskInput } from '../src/main/agent/engine/phi-extension/lib/rpc-child-config'
import { createProductionChildConfig } from '../src/main/agent/engine/rpc/subagents/production-child-config'
import { productionChildOptions } from './helpers/productionChildNodeFixture'

test('trusted expert admission counts existing running/queued IDs and concurrent pending reservations within four slots', async () => {
  assert.doesNotThrow(() => assertRpcChildTaskCapacity(new Set(['existing']), 1, 2))
  assert.throws(() => assertRpcChildTaskCapacity(new Set(), 0, 5), /limit/)
  assert.throws(() => assertRpcChildTaskCapacity(new Set(['a', 'b', 'queued']), 0, 2), /limit/)
  assert.throws(() => assertRpcChildTaskCapacity(new Set(['a']), 2, 2), /limit/)
  const config = (
    await createProductionChildConfig({ ...productionChildOptions(), allowParallel: true })
  ).config
  const task = {
    agent: config.profiles[0].definition.nativeName,
    task: 'bounded work',
    solutionSpace: 'fixture'
  }
  assert.equal(
    (
      validateRpcForegroundTaskInput(
        { context: 'parallel', tasks: Array.from({ length: 4 }, () => task) },
        config
      ) as { tasks: readonly unknown[] }
    ).tasks.length,
    4
  )
  assert.throws(
    () =>
      validateRpcForegroundTaskInput(
        { context: 'parallel', tasks: Array.from({ length: 5 }, () => task) },
        config
      ),
    /batch/
  )
})
