import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateControlFrame } from '../src/main/agent/engine/rpc/control-frame'
import { encodeRpcCommand, MAX_RPC_FRAME_BYTES } from '../src/main/agent/engine/rpc/frame-codec'

test('official host URI results accept only the exact documented field types', () => {
  for (const value of [
    { type: 'host_uri_result', id: 'write-success' },
    {
      type: 'host_uri_result',
      id: 'read-success',
      content: '{}',
      contentType: 'application/json',
      notes: ['private note'],
      immutable: true
    },
    {
      type: 'host_uri_result',
      id: 'read-error',
      isError: true,
      error: 'refused',
      content: 'explanation'
    }
  ])
    assert.doesNotThrow(() => validateControlFrame(value))
  for (const patch of [
    { extra: 'command' },
    { content: 3 },
    { contentType: 'text/html' },
    { contentType: { toString: () => 'text/plain' } },
    { notes: [3] },
    { notes: Array(33).fill('x') },
    { notes: ['x'.repeat(4097)] },
    { immutable: 'true' },
    { isError: 1 },
    { error: 'x'.repeat(4097) }
  ]) {
    assert.throws(
      () => validateControlFrame({ type: 'host_uri_result', id: 'uri', ...patch }),
      /Invalid RPC control frame/
    )
  }
})
test('URI UTF-8 payloads keep the shared official one MiB command bound including metadata and LF', () => {
  assert.throws(
    () =>
      validateControlFrame({
        type: 'host_uri_result',
        id: 'uri',
        content: '界'.repeat(MAX_RPC_FRAME_BYTES)
      }),
    /Invalid RPC control frame/
  )
  const frame = { type: 'host_uri_result', id: 'uri', content: 'x'.repeat(MAX_RPC_FRAME_BYTES) }
  assert.doesNotThrow(() => validateControlFrame(frame))
  assert.throws(() => encodeRpcCommand(frame), /frame limit/)
  assert.throws(
    () => validateControlFrame({ type: 'prompt', id: 'uri', message: 'arbitrary command' }),
    /Invalid RPC control frame/
  )
})
