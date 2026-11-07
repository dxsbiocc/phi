import assert from 'node:assert/strict'
import test from 'node:test'

import { stripAgentReportMetadata } from '../src/shared/agentReportText'
import { applyAgentCompletedTimelineEvent } from '../src/renderer/src/lib/agentExecutionRestore'
import type { ChatItem } from '../src/renderer/src/types'

const BLOCK =
  '<phi_agent_result>{"status":"completed","missingInputs":[],"nextAgent":null,"fallbackReason":null}</phi_agent_result>'

test('a declared report shows only its prose', () => {
  assert.equal(stripAgentReportMetadata(`${BLOCK}\nRead 3 lines.`), 'Read 3 lines.')
  assert.equal(stripAgentReportMetadata(`Read 3 lines.\n\n${BLOCK}`), 'Read 3 lines.')
})

test('a block still streaming or missing its closing tag never leaks', () => {
  assert.equal(stripAgentReportMetadata('<phi_agent_result>{"status":"compl'), '')
  assert.equal(
    stripAgentReportMetadata(
      '<phi_agent_result>{"status":"partial","missingInputs":[]}\nTwo of three done.'
    ),
    'Two of three done.'
  )
  assert.equal(stripAgentReportMetadata('Done.</phi_agent_result>'), 'Done.')
})

test('plain prose is unchanged', () => {
  assert.equal(stripAgentReportMetadata('  Retrieved Q92748.  '), 'Retrieved Q92748.')
})

test('a restored agent card never shows the report protocol', () => {
  const items: ChatItem[] = []
  applyAgentCompletedTimelineEvent(items, {
    toolCallId: 'call-1',
    agentName: 'General',
    finalReport: `${BLOCK}\nThe child returned the requested lines.`,
    createdAt: '2026-11-07T00:00:00.000Z'
  })
  const card = items.find((item) => item.role === 'agent_execution')
  assert.ok(card && card.role === 'agent_execution')
  assert.equal(card.finalReport, 'The child returned the requested lines.')
})
