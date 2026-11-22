import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendQueuedPrompt,
  dropQueuedPrompt,
  restoreQueuedPrompt,
  retargetQueuedPrompts,
  shiftQueuedPrompt,
  type QueuedPrompt,
  type QueuedPromptsBySession
} from '../src/renderer/src/features/chat/lib/promptQueue'

const draftTarget = {
  path: '/alpha.jsonl',
  phiSessionId: 'alpha',
  cwd: '/work',
  sessionGeneration: 1
}
const prompt = (id: string, overrides: Partial<QueuedPrompt> = {}): QueuedPrompt => ({
  id,
  text: `text-${id}`,
  target: draftTarget,
  ...overrides
})

test('append parks a prompt under its draft key without touching other sessions', () => {
  const queue: QueuedPromptsBySession = { beta: [prompt('beta-1')] }
  const next = appendQueuedPrompt(queue, 'alpha', prompt('alpha-1'))
  assert.deepEqual(
    next.alpha.map((item) => item.id),
    ['alpha-1']
  )
  assert.deepEqual(
    next.beta.map((item) => item.id),
    ['beta-1']
  )
  assert.equal(queue.alpha, undefined)
})

test('append keeps arrival order behind the running prompt', () => {
  const first = appendQueuedPrompt({}, 'alpha', prompt('one'))
  const second = appendQueuedPrompt(first, 'alpha', prompt('two'))
  assert.deepEqual(
    second.alpha.map((item) => item.id),
    ['one', 'two']
  )
})

test('drop removes the prompt and leaves the queue alone when the id is gone', () => {
  const queue = appendQueuedPrompt({}, 'alpha', prompt('one'))
  const removed = dropQueuedPrompt(queue, 'alpha', 'one')
  assert.equal(removed.alpha, undefined)
  assert.equal(dropQueuedPrompt(queue, 'alpha', 'missing'), queue)
})

test('drop keeps a sibling prompt and drops the session key only when it empties', () => {
  const queue = appendQueuedPrompt(
    appendQueuedPrompt({}, 'alpha', prompt('one')),
    'alpha',
    prompt('two')
  )
  const next = dropQueuedPrompt(queue, 'alpha', 'one')
  assert.deepEqual(
    next.alpha.map((item) => item.id),
    ['two']
  )
})

test('restore reinserts a failed prompt at its original position without moving other sessions', () => {
  const beta = [prompt('beta-1')]
  const queue: QueuedPromptsBySession = {
    alpha: [prompt('one'), prompt('three')],
    beta
  }
  const next = restoreQueuedPrompt(queue, 'alpha', prompt('two'), 1)
  assert.deepEqual(
    next.alpha.map((item) => item.id),
    ['one', 'two', 'three']
  )
  assert.equal(next.beta, beta)
  assert.deepEqual(
    queue.alpha.map((item) => item.id),
    ['one', 'three']
  )
})

test('restore clamps the former index to the current queue bounds', () => {
  const queue: QueuedPromptsBySession = { alpha: [prompt('two')] }
  const first = restoreQueuedPrompt(queue, 'alpha', prompt('one'), -10)
  const last = restoreQueuedPrompt(first, 'alpha', prompt('three'), 10)
  assert.deepEqual(
    last.alpha.map((item) => item.id),
    ['one', 'two', 'three']
  )
})

test('restore is a no-op when the prompt is already queued', () => {
  const queue: QueuedPromptsBySession = { alpha: [prompt('one'), prompt('two')] }
  assert.equal(restoreQueuedPrompt(queue, 'alpha', prompt('one'), 1), queue)
  assert.deepEqual(
    queue.alpha.map((item) => item.id),
    ['one', 'two']
  )
})

test('shift dequeues the head prompt the drain decided on', () => {
  const queue = appendQueuedPrompt(
    appendQueuedPrompt({}, 'alpha', prompt('one')),
    'alpha',
    prompt('two')
  )
  const next = shiftQueuedPrompt(queue, 'alpha', 'one')
  assert.deepEqual(
    next.alpha.map((item) => item.id),
    ['two']
  )
})

test('shift refuses to dequeue when the head changed while the session was busy', () => {
  const queue = appendQueuedPrompt({}, 'alpha', prompt('one'))
  assert.equal(shiftQueuedPrompt(queue, 'alpha', 'two'), queue)
})

test('shift drops the session key when the last prompt leaves', () => {
  const queue = appendQueuedPrompt({}, 'alpha', prompt('one'))
  assert.equal(shiftQueuedPrompt(queue, 'alpha', 'one').alpha, undefined)
})

test('retarget re-homes a fresh chat backlog behind the real session', () => {
  const provisional = {
    path: null,
    phiSessionId: undefined,
    cwd: '/work',
    sessionGeneration: 0
  }
  const queue: QueuedPromptsBySession = {
    'fresh-chat': [prompt('one', { target: provisional }), prompt('two', { target: provisional })],
    'real-session': [prompt('old')]
  }
  const next = retargetQueuedPrompts(queue, 'fresh-chat', 'real-session', {
    path: '/real.jsonl',
    phiSessionId: 'real',
    cwd: '/work',
    sessionGeneration: 4
  })
  assert.equal(next['fresh-chat'], undefined)
  assert.deepEqual(
    next['real-session'].map((item) => [
      item.id,
      item.target.phiSessionId,
      item.target.sessionGeneration
    ]),
    [
      ['old', 'alpha', 1],
      ['one', 'real', 4],
      ['two', 'real', 4]
    ]
  )
  // The provisional key keeps its backlog: the caller passes the same object in.
  assert.equal(queue['fresh-chat'].length, 2)
})

test('retarget is a no-op when the provisional session never queued anything', () => {
  const queue: QueuedPromptsBySession = { 'real-session': [prompt('old')] }
  assert.equal(
    retargetQueuedPrompts(queue, 'fresh-chat', 'real-session', {
      path: '/real.jsonl',
      phiSessionId: 'real',
      cwd: '/work',
      sessionGeneration: 4
    }),
    queue
  )
})
