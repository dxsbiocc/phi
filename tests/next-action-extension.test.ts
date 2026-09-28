import assert from 'node:assert/strict'
import test from 'node:test'

import { createNextActionInstructionExtension } from '../src/main/agent/omp/next-action-extension'

function handlerFor(
  isEnabled: () => Promise<boolean>
): (event: { systemPrompt: string[] }) => Promise<{ systemPrompt?: string[] } | undefined> {
  let handler:
    | ((event: { systemPrompt: string[] }) => Promise<{ systemPrompt?: string[] } | undefined>)
    | undefined
  createNextActionInstructionExtension(isEnabled)({
    on: (event: string, callback: typeof handler) => {
      if (event === 'before_agent_start') handler = callback
    }
  } as never)
  assert.ok(handler)
  return handler
}

test('next-action setting adds guidance to a system prompt without changing user text', async () => {
  const handler = handlerFor(async () => true)
  const original = ['You are Phi.']
  const result = await handler({ systemPrompt: original })
  assert.deepEqual(original, ['You are Phi.'])
  assert.equal(result?.systemPrompt?.[0], 'You are Phi.')
  assert.match(result?.systemPrompt?.[1] ?? '', /phi_next_action_instruction/)
})

test('next-action guidance is optional and never duplicated', async () => {
  const disabled = handlerFor(async () => false)
  assert.equal(await disabled({ systemPrompt: ['base'] }), undefined)
  const enabled = handlerFor(async () => true)
  assert.equal(
    await enabled({ systemPrompt: ['base', '<phi_next_action_instruction>already present'] }),
    undefined
  )
  const unavailable = handlerFor(async () => {
    throw new Error('settings unavailable')
  })
  assert.equal(await unavailable({ systemPrompt: ['base'] }), undefined)
})
