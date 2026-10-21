import assert from 'node:assert/strict'
import test from 'node:test'
import { createThinkingLevelCommitter } from '../src/renderer/src/components/chat/composerThinkingLevel'
import type { ThinkingLevel } from '../src/renderer/src/types'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

test('thinking committer sends the latest level after the in-flight selection settles', async () => {
  let current: ThinkingLevel = 'high'
  const sent: ThinkingLevel[] = []
  const first = deferred()
  const commit = createThinkingLevelCommitter(
    () => current,
    (level) => {
      sent.push(level)
      current = level
      return sent.length === 1 ? first.promise : Promise.resolve()
    }
  )

  commit('low')
  commit('medium')
  commit('max')
  assert.deepEqual(sent, ['low'])

  first.resolve()
  await first.promise
  await Promise.resolve()
  assert.deepEqual(sent, ['low', 'max'])
  assert.equal(current, 'max')
})

test('thinking committer skips a level that is already current', () => {
  const sent: ThinkingLevel[] = []
  const commit = createThinkingLevelCommitter(
    () => 'high',
    (level) => {
      sent.push(level)
    }
  )

  commit('high')
  assert.deepEqual(sent, [])
})
