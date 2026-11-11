import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createPromptRunQueue,
  type PromptRunQueueDeps
} from '../src/main/session-runtime/prompt-run-queue'

test('a prompt replays a deferred invalidation before admitting the run', async () => {
  const calls: string[] = []
  const deps = {
    admission: {
      resolve: () => {
        calls.push('admission:resolve')
        throw new Error('stop after the admission boundary')
      },
      admit: () => {
        throw new Error('unreachable')
      }
    },
    invalidation: {
      flushPending: async (sessionKey: string) => {
        calls.push(`invalidation:flush:${sessionKey}`)
      }
    }
  } as unknown as PromptRunQueueDeps

  await assert.rejects(
    createPromptRunQueue(deps).submitPromptRun({
      sessionKey: 'session-a',
      snapshot: { path: '/a.jsonl', cwd: '/workspace', permissionMode: 'auto' },
      text: 'continue',
      promptTarget: null
    }),
    /stop after the admission boundary/
  )

  assert.deepEqual(calls, ['invalidation:flush:session-a', 'admission:resolve'])
})
