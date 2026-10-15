import assert from 'node:assert/strict'
import test from 'node:test'
import { completedChildReport } from '../src/main/agent/engine/rpc/subagents/child-report'

const previous = {
  role: 'assistant',
  stopReason: 'stop',
  content: [{ type: 'text', text: 'STALE_PREVIOUS_REPORT' }]
}
test('only the actual last terminal assistant supplies a bounded child completion report', () => {
  assert.equal(
    completedChildReport([
      previous,
      { role: 'user', content: 'steering' },
      {
        role: 'assistant',
        stopReason: 'stop',
        content: [
          { type: 'thinking', thinking: 'private' },
          { type: 'text', text: 'ACTUAL_FINAL_REPORT' }
        ]
      }
    ]),
    'ACTUAL_FINAL_REPORT'
  )
  assert.equal(
    completedChildReport([
      { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(21000) }] }
    ]).length,
    20000
  )
})
test('error, aborted and tool-use tails never substitute an older successful report', () => {
  for (const stopReason of ['error', 'aborted', 'toolUse'])
    assert.equal(
      completedChildReport([
        previous,
        {
          role: 'assistant',
          stopReason,
          content: [{ type: 'text', text: 'unfinished tail' }]
        }
      ]),
      ''
    )
  assert.equal(
    completedChildReport([
      previous,
      { role: 'assistant', content: [{ type: 'toolCall', id: 'unfinished' }] }
    ]),
    ''
  )
  assert.equal(completedChildReport([previous, { role: 'assistant', content: [] }]), '')
  assert.equal(
    completedChildReport([previous, { role: 'user', content: 'unconsumed steering' }]),
    ''
  )
})
