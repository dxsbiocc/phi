import assert from 'node:assert/strict'
import test from 'node:test'

import { installAutoWorkModeBatchGuard } from '../src/main/agent/engine/in-process/auto-work-mode-guard'

type HookContext = {
  assistantMessage: { content: Array<{ type: string; name?: string }> }
}
type HookResult = { block?: boolean; reason?: string; additionalContext?: string } | undefined
type TestAgent = {
  beforeToolCall: (context: HookContext, signal?: AbortSignal) => Promise<HookResult>
}

function context(...names: string[]): HookContext {
  return {
    assistantMessage: {
      content: names.map((name) => ({ type: 'toolCall', name }))
    }
  }
}

test('automatic mode batch guard blocks enter_plan_mode and every sibling before dispatch', async () => {
  let delegated = 0
  const agent: TestAgent = {
    beforeToolCall: async () => {
      delegated++
      return undefined
    }
  }
  installAutoWorkModeBatchGuard(agent as never, true)

  for (const toolName of ['enter_plan_mode', 'write']) {
    const result = await agent.beforeToolCall(context('enter_plan_mode', 'write'), undefined)
    assert.equal(result?.block, true, toolName)
    assert.match(result?.reason ?? '', /only tool call/)
  }
  assert.equal(delegated, 0)
})

test('automatic mode batch guard preserves the normal hook chain for valid batches', async () => {
  const expected = { additionalContext: 'checked' }
  const agent: TestAgent = { beforeToolCall: async () => expected }
  installAutoWorkModeBatchGuard(agent as never, true)
  assert.equal(await agent.beforeToolCall(context('enter_plan_mode'), undefined), expected)
  assert.equal(await agent.beforeToolCall(context('write'), undefined), expected)

  const direct: TestAgent = { beforeToolCall: async () => expected }
  installAutoWorkModeBatchGuard(direct as never, false)
  assert.equal(
    await direct.beforeToolCall(context('enter_plan_mode', 'write'), undefined),
    expected
  )
})
