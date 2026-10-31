import assert from 'node:assert/strict'
import { it } from 'node:test'

import { createCursorDelegationExtension } from '../src/main/agent/engine/phi-extension/extensions/cursor-delegation'
import { CURSOR_DELEGATION_INSTRUCTION } from '../src/main/agent/engine/phi-extension/lib/cursor-delegation-instruction'
import {
  COMPACTION_NOT_NEEDED_MESSAGE,
  isCompactionNoOpError,
  isSdkCompactionNoOp
} from '../src/shared/errorCodes'

type Handler = (
  event: { systemPrompt: string[] },
  ctx: { model?: { api: string } }
) => { systemPrompt: string[] } | undefined

function start(): Handler {
  let handler: Handler | undefined
  const pi = {
    on: (_name: string, registered: Handler) => {
      handler = registered
    }
  }
  void createCursorDelegationExtension()(pi as never)
  assert.ok(handler)
  return handler
}

it('steers Cursor models to the working task tool', () => {
  const handler = start()
  const result = handler({ systemPrompt: ['base'] }, { model: { api: 'cursor-agent' } })
  assert.deepEqual(result?.systemPrompt, ['base', CURSOR_DELEGATION_INSTRUCTION])
})

it('leaves other models and repeat turns alone', () => {
  const handler = start()
  assert.equal(handler({ systemPrompt: [] }, { model: { api: 'openai-completions' } }), undefined)
  assert.equal(handler({ systemPrompt: [] }, {}), undefined)
  assert.equal(
    handler({ systemPrompt: [CURSOR_DELEGATION_INSTRUCTION] }, { model: { api: 'cursor-agent' } }),
    undefined
  )
})

it('tells a compaction no-op apart from a real failure', () => {
  assert.equal(isSdkCompactionNoOp('Nothing to compact (session too small)'), true)
  assert.equal(isSdkCompactionNoOp('Already compacted'), true)
  assert.equal(isSdkCompactionNoOp('Error: 429 rate limited'), false)
  assert.equal(isSdkCompactionNoOp(COMPACTION_NOT_NEEDED_MESSAGE), false)
  assert.equal(isCompactionNoOpError(new Error('Already compacted')), true)
  assert.equal(isCompactionNoOpError({ detail: { reason: 'compaction_not_needed' } }), true)
  assert.equal(isCompactionNoOpError(new Error('The requested capability is unavailable.')), false)
})
