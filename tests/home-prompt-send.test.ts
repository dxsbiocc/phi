import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HOME_PROMPT_READY_TIMEOUT_MS,
  sendHomePrompt,
  type HomePromptSendDeps
} from '../src/renderer/src/features/home/lib/homePromptSend'

function harness(overrides: Partial<HomePromptSendDeps> = {}): {
  deps: HomePromptSendDeps
  calls: string[]
  elapsed: () => number
} {
  const calls: string[] = []
  let clock = 0
  const deps: HomePromptSendDeps = {
    isModelStateReady: () => true,
    send: async () => {
      calls.push('send')
      return true
    },
    keepUnsentText: () => calls.push('keep'),
    reportUnsent: () => calls.push('report'),
    wait: async (ms) => {
      clock += ms
    },
    now: () => clock,
    ...overrides
  }
  return { deps, calls, elapsed: () => clock }
}

test('the first home message waits for the new conversation model state before sending', async () => {
  let ready = false
  let polls = 0
  const { deps, calls } = harness({
    isModelStateReady: () => {
      polls += 1
      if (polls === 3) ready = true
      return ready
    },
    send: async () => {
      calls.push(ready ? 'send-ready' : 'send-early')
      return true
    }
  })
  assert.equal(await sendHomePrompt(deps), true)
  assert.deepEqual(calls, ['send-ready'])
})

test('a refused first home message goes back to the composer with a notice', async () => {
  const { deps, calls } = harness({ send: async () => false })
  assert.equal(await sendHomePrompt(deps), false)
  assert.deepEqual(calls, ['keep', 'report'])
})

test('a failed mode update or send keeps the text instead of losing it silently', async () => {
  const { deps, calls } = harness({
    send: async () => {
      throw new Error('mode update failed')
    }
  })
  assert.equal(await sendHomePrompt(deps), false)
  assert.deepEqual(calls, ['keep', 'report'])
})

test('a model state that never settles still ends in a visible outcome', async () => {
  const { deps, calls, elapsed } = harness({
    isModelStateReady: () => false,
    send: async () => false
  })
  assert.equal(await sendHomePrompt(deps), false)
  assert.ok(elapsed() >= HOME_PROMPT_READY_TIMEOUT_MS)
  assert.deepEqual(calls, ['keep', 'report'])
})
