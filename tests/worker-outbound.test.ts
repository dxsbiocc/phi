import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import {
  createStdoutWorkerOutbound,
  handleHostResponse,
  requestHost,
  send,
  sendEvent,
  setWorkerOutbound
} from '../src/main/agent/engine/in-process/ipc'
import { toJsonSafe } from '../src/main/agent/engine/in-process/common'

afterEach(() => setWorkerOutbound(undefined))

test('stdout worker outbound preserves legacy response, event, and host request bytes', async () => {
  const lines: string[] = []
  let jsonSafeCalls = 0
  setWorkerOutbound(
    createStdoutWorkerOutbound((line) => lines.push(line)),
    {
      toJsonSafe(value) {
        jsonSafeCalls += 1
        return toJsonSafe(value)
      }
    }
  )

  const result = {
    omitted: undefined,
    bigint: 7n,
    error: new Error('worker failed'),
    nested: { keep: true, omitted: undefined }
  }
  send({ id: 'response-1', ok: true, result })
  sendEvent('sessionEvent', result, { sessionId: 'session-1' })
  const hostResult = requestHost('desktop.example', result, {
    originSessionId: 'session-1',
    agentRunId: 'run-1'
  })

  const hostFrame = JSON.parse(lines[2]) as { id: string }
  assert.deepEqual(lines.slice(0, 2), [
    `${JSON.stringify(toJsonSafe({ id: 'response-1', ok: true, result }))}\n`,
    `${JSON.stringify(
      toJsonSafe({
        type: 'event',
        event: 'sessionEvent',
        payload: result,
        sessionId: 'session-1'
      })
    )}\n`
  ])
  assert.equal(
    lines[2],
    `${JSON.stringify(
      toJsonSafe({
        type: 'hostRequest',
        id: hostFrame.id,
        method: 'desktop.example',
        params: result,
        context: { originSessionId: 'session-1', agentRunId: 'run-1' }
      })
    )}\n`
  )
  assert.equal(jsonSafeCalls, 3)

  handleHostResponse({ type: 'hostResponse', id: hostFrame.id, ok: true, result: 'accepted' })
  assert.equal(await hostResult, 'accepted')
})

test('worker IPC fails clearly when no outbound path is installed', () => {
  setWorkerOutbound(undefined)

  assert.throws(() => send({ ok: true }), /Worker outbound is not configured/)
  assert.throws(() => sendEvent('sessionEvent', {}), /Worker outbound is not configured/)
  assert.throws(() => requestHost('desktop.example', {}), /Worker outbound is not configured/)
})
