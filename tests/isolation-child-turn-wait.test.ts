import assert from 'node:assert/strict'
import test from 'node:test'

import { awaitChildModelTurn } from '../scripts/kernel-e2e/isolation-scenario'

test('child-turn wait returns as soon as the gate is reached', async () => {
  let inspected = 0
  await awaitChildModelTurn({
    waitForGate: () => Promise.resolve(),
    inspect: async () => {
      inspected += 1
      return {}
    },
    lanes: () => ['a'],
    timeoutMs: 1_000
  })
  assert.equal(inspected, 0, 'the success path must not pay for diagnostics')
})

test('a missing child turn fails fast with the task result and observed lanes', async () => {
  const started = Date.now()
  await assert.rejects(
    awaitChildModelTurn({
      waitForGate: () => new Promise<void>(() => undefined),
      inspect: async () => ({
        taskResult: 'Task execution failed: invalid schema',
        taskIsError: true
      }),
      lanes: () => ['a', 'a', 'b'],
      timeoutMs: 50
    }),
    (error: Error) => {
      assert.match(error.message, /no child model turn started within 50ms/)
      assert.match(error.message, /Task execution failed: invalid schema/)
      assert.match(error.message, /task isError=true/)
      assert.match(error.message, /observed model-request lanes: a,b/)
      return true
    }
  )
  assert.ok(Date.now() - started < 5_000, 'the wait must be bounded, not deadline-length')
})

test('a never-resolving task tool is reported instead of hanging', async () => {
  await assert.rejects(
    awaitChildModelTurn({
      waitForGate: () => new Promise<void>(() => undefined),
      inspect: async () => ({}),
      lanes: () => [],
      timeoutMs: 25
    }),
    /task result: <task tool never returned>; task isError=unknown; observed model-request lanes: none/
  )
})

test('diagnostics failure never masks the timeout', async () => {
  await assert.rejects(
    awaitChildModelTurn({
      waitForGate: () => new Promise<void>(() => undefined),
      inspect: async () => {
        throw new Error('snapshot unavailable')
      },
      lanes: () => [],
      timeoutMs: 25
    }),
    /no child model turn started within 25ms/
  )
})

test('isolation scenario no longer waits on the child gate without a bound', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync('scripts/kernel-e2e/isolation-scenario.ts', 'utf8')
  assert.doesNotMatch(
    source,
    /await options\.provider\.waitForGate\(aChildGate\)/,
    'the unbounded gate wait must be replaced by awaitChildModelTurn'
  )
  assert.match(source, /awaitChildModelTurn\(\{/)
})
