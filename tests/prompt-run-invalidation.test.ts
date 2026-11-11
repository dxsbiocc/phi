import assert from 'node:assert/strict'
import test from 'node:test'

import { stopActivePrompt } from '../src/main/agent/session/active-prompt-stop'
import { PromptRunRegistry } from '../src/main/app-state/prompt-run-registry'
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
    },
    runs: {
      beginSubmission: () => ({ cancelled: false }),
      endSubmission: () => undefined
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

test('a stop during a deferred invalidation replay cancels the submission before admission', async () => {
  const calls: string[] = []
  const runs = new PromptRunRegistry((key) => key)
  let releaseFlush: () => void = () => undefined
  const flushGate = new Promise<void>((resolve) => {
    releaseFlush = resolve
  })
  const deps = {
    admission: {
      resolve: () => {
        calls.push('admission:resolve')
        throw new Error('a cancelled submission must not be admitted')
      },
      admit: () => {
        throw new Error('unreachable')
      }
    },
    invalidation: {
      flushPending: async (sessionKey: string) => {
        calls.push(`invalidation:flush:${sessionKey}`)
        await flushGate
      }
    },
    runs: {
      beginSubmission: (sessionKey: string) => runs.beginPromptSubmission(sessionKey),
      endSubmission: (sessionKey: string, submission: { cancelled: boolean }) =>
        runs.endPromptSubmission(sessionKey, submission)
    }
  } as unknown as PromptRunQueueDeps

  const prompt = createPromptRunQueue(deps).submitPromptRun({
    sessionKey: 'session-a',
    snapshot: { path: '/a.jsonl', cwd: '/workspace', permissionMode: 'auto' },
    text: 'continue',
    promptTarget: null
  })

  await stopActivePrompt({
    getCurrentSessionKey: () => 'session-a',
    advancePromptGeneration: (sessionKey) => runs.advanceGeneration(sessionKey),
    cancelPendingPromptSubmissions: (sessionKey) =>
      runs.cancelPendingPromptSubmissions(sessionKey),
    getActivePromptRun: (sessionKey) => runs.activeRun(sessionKey),
    getPhiSessionIdForKey: () => undefined,
    getManualCompactionOperation: () => undefined,
    stopPromptRun: async () => undefined
  })
  releaseFlush()

  assert.equal(await prompt, null)
  assert.deepEqual(calls, ['invalidation:flush:session-a'])
})
