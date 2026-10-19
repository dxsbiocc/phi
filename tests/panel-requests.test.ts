import assert from 'node:assert/strict'
import test from 'node:test'

import {
  idlePanelRequests,
  withBackgroundJobConsumed,
  withBackgroundJobRequest,
  withConnectorJobConsumed,
  withConnectorJobRequest,
  withTerminalInputConsumed,
  withTerminalInputRequest
} from '../src/renderer/src/lib/app-shell/panelRequests'

test('a connector job request keeps the "latest job" form when no id is named', () => {
  assert.equal(withConnectorJobRequest(idlePanelRequests, null), idlePanelRequests)
  const named = withConnectorJobRequest(idlePanelRequests, 'job-1')
  assert.equal(named.connectorJobId, 'job-1')
  assert.equal(named.backgroundJobKey, null)
  assert.equal(named.terminalInput, null)
})

test('consuming the current connector request clears it', () => {
  const requested = withConnectorJobRequest(idlePanelRequests, 'job-1')
  assert.equal(withConnectorJobConsumed(requested, 'job-1').connectorJobId, null)
})

test('a panel that handled an old connector request cannot clear a newer one', () => {
  const requested = withConnectorJobRequest(idlePanelRequests, 'job-1')
  const newer = withConnectorJobRequest(requested, 'job-2')
  assert.equal(withConnectorJobConsumed(newer, 'job-1'), newer)
  assert.equal(withConnectorJobConsumed(newer, 'job-2').connectorJobId, null)
})

test('background job requests follow the same rule and leave the other requests alone', () => {
  const requested = withBackgroundJobRequest(idlePanelRequests, 'jupyter:latest')
  assert.equal(requested.backgroundJobKey, 'jupyter:latest')
  assert.equal(requested.connectorJobId, null)
  assert.equal(withBackgroundJobConsumed(requested, 'another-key'), requested)
  assert.equal(withBackgroundJobConsumed(requested, 'jupyter:latest').backgroundJobKey, null)
})

test('a terminal input request keeps its text and is consumed by id', () => {
  const requested = withTerminalInputRequest(idlePanelRequests, {
    id: 'request-1',
    text: 'phi connector setup'
  })
  assert.deepEqual(requested.terminalInput, { id: 'request-1', text: 'phi connector setup' })
  assert.equal(requested.backgroundJobKey, null)
  assert.equal(requested.connectorJobId, null)
})

test('a late terminal acknowledgement cannot clear a newer input request', () => {
  const first = withTerminalInputRequest(idlePanelRequests, { id: 'request-1', text: 'one' })
  const second = withTerminalInputRequest(first, { id: 'request-2', text: 'two' })
  assert.equal(withTerminalInputConsumed(second, 'request-1'), second)
  assert.deepEqual(withTerminalInputConsumed(second, 'request-2').terminalInput, null)
})

test('the three requests are independent', () => {
  const state = withTerminalInputRequest(
    withBackgroundJobRequest(withConnectorJobRequest(idlePanelRequests, 'job-1'), 'jupyter:latest'),
    { id: 'request-1', text: 'command' }
  )
  assert.equal(state.connectorJobId, 'job-1')
  assert.equal(state.backgroundJobKey, 'jupyter:latest')
  assert.equal(state.terminalInput?.id, 'request-1')
  assert.equal(state.terminalInput?.text, 'command')
  assert.equal(withConnectorJobConsumed(state, 'job-1').backgroundJobKey, 'jupyter:latest')
  assert.equal(withConnectorJobConsumed(state, 'job-1').terminalInput?.id, 'request-1')
})
