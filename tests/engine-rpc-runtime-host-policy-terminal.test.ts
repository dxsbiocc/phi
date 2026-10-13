import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RpcApprovalEvent } from '../src/main/agent/engine/rpc/approval-bridge'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'

test('production host authorization commits one approval terminal when its observer stops the run', async () => {
  const f = await runtimeCompositionFixture()
  let effects = 0
  const events: RpcApprovalEvent[] = []
  const runtime = await f.create({
    tools: [
      {
        name: 'terminal_host_write',
        site: 'host',
        label: 'Terminal host write',
        description: 'Private controlled effect',
        approval: 'write',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value']
        },
        async execute() {
          effects++
          return { content: [{ type: 'text', text: 'effect' }] }
        }
      }
    ],
    approval: {
      shouldGate: () => true,
      requestToolApproval: () => 'approved',
      onEvent: (event) => {
        events.push(event)
        if (event.type === 'approval_approved') void runtime.stop()
      }
    }
  })
  try {
    await f.sdk.enqueue({
      tool: { name: 'terminal_host_write', args: { value: 'private' }, id: 'terminal-host-call' }
    })
    assert.equal(
      (await runtime.prompt('terminal-parent-run', 'Call the private host tool')).outcome,
      'aborted'
    )
    assert.equal(effects, 0)
    const terminal = events.filter((event) => event.type !== 'approval_requested')
    assert.equal(terminal.length, 1, 'One real authorization has one committed terminal')
    assert.equal(terminal[0].type, 'approval_approved')
  } finally {
    await f.close()
  }
})
