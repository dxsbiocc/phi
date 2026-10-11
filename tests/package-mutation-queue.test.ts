import assert from 'node:assert/strict'
import test from 'node:test'

import { runPackageMutation } from '../src/main/agent/packages/mutation-queue'

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('package changes run one at a time, in the order they were requested', async () => {
  const events: string[] = []
  let running = 0
  let peak = 0
  const task = (name: string, ms: number) => async (): Promise<string> => {
    running += 1
    peak = Math.max(peak, running)
    events.push(`start ${name}`)
    await pause(ms)
    events.push(`end ${name}`)
    running -= 1
    return name
  }
  const results = await Promise.all([
    runPackageMutation(task('a', 20)),
    runPackageMutation(task('b', 1)),
    runPackageMutation(task('c', 5))
  ])
  assert.deepEqual(results, ['a', 'b', 'c'])
  assert.equal(peak, 1)
  assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
})

test('a failed change reports its own error and does not block the ones after it', async () => {
  const failing = runPackageMutation(async () => {
    throw new Error('boom')
  })
  const after = runPackageMutation(async () => 'still runs')
  await assert.rejects(failing, /boom/)
  assert.equal(await after, 'still runs')
})
