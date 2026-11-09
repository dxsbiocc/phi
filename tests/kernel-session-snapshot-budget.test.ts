import assert from 'node:assert/strict'
import test from 'node:test'

import { encodeFrame, type JsonValue } from '../src/shared/kernel-protocol'
import { projectSessionState } from '../src/kernel/worker/session-state'
import {
  SNAPSHOT_MESSAGE_BUDGET_BYTES,
  SNAPSHOT_OMITTED_MESSAGE_TEXT,
  boundSnapshotMessages,
  jsonByteLength
} from '../src/kernel/worker/session-snapshot-budget'

const KIB = 1024

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, JsonValue>
}

/** About 2.5 MB: oversized tool details and text plus one large provider payload. */
function makeLargeMessages(): JsonValue[] {
  const messages: JsonValue[] = []
  for (let index = 0; index < 9; index += 1) {
    messages.push({
      role: 'toolResult',
      toolCallId: `tool-${index}`,
      toolName: 'bash',
      isError: false,
      timestamp: index,
      content: [{ type: 'text', text: `output ${index} ${'t'.repeat(80 * KIB)}` }],
      details: {
        command: 'cat',
        output: 'd'.repeat(150 * KIB),
        nested: { exitCode: index }
      }
    })
  }
  messages.push({
    role: 'assistant',
    content: [{ type: 'text', text: 'plan' }],
    providerPayload: { raw: 'p'.repeat(400 * KIB) }
  })
  messages.push({
    role: 'assistant',
    content: [{ type: 'text', text: `final answer ${'a'.repeat(12 * KIB)}` }]
  })
  return messages
}

function rolesOf(messages: JsonValue[]): JsonValue[] {
  return messages.map((message) => record(message).role)
}

function toolCallIdsOf(messages: JsonValue[]): JsonValue[] {
  return messages.map((message) => record(message).toolCallId)
}

function textOf(message: JsonValue): string {
  const content = record(message).content
  assert.ok(Array.isArray(content))
  const text = record(content[0]).text
  assert.equal(typeof text, 'string')
  return text as string
}

test('providerPayload is stripped even when the session is already under budget', () => {
  const messages: JsonValue[] = [
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      providerPayload: { raw: 'raw replay data' }
    }
  ]

  const bounded = boundSnapshotMessages(messages, SNAPSHOT_MESSAGE_BUDGET_BYTES)

  assert.equal('providerPayload' in record(bounded[0]), false)
  assert.equal(record(messages[0]).providerPayload === undefined, false)
})

test('small sessions keep their exact shape', () => {
  const messages: JsonValue[] = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 2 }
  ]

  const bounded = boundSnapshotMessages(messages, SNAPSHOT_MESSAGE_BUDGET_BYTES)

  assert.deepEqual(bounded, messages)
  assert.notEqual(bounded, messages)
  assert.notEqual(bounded[0], messages[0])
})

test('a 2.5 MB session is bounded without changing its message identities', () => {
  const messages = makeLargeMessages()
  const original = JSON.parse(JSON.stringify(messages)) as JsonValue[]
  assert.ok(jsonByteLength(messages) > 2_200_000)

  const bounded = boundSnapshotMessages(messages, SNAPSHOT_MESSAGE_BUDGET_BYTES)

  assert.ok(jsonByteLength(bounded) <= SNAPSHOT_MESSAGE_BUDGET_BYTES)
  assert.equal(bounded.length, messages.length)
  assert.deepEqual(rolesOf(bounded), rolesOf(messages))
  assert.deepEqual(toolCallIdsOf(bounded), toolCallIdsOf(messages))
  assert.deepEqual(messages, original)
  assert.equal(record(messages[9]).providerPayload !== undefined, true)
})

test('bounding keeps the last assistant answer intact when earlier stages are enough', () => {
  const messages = makeLargeMessages()
  const lastText = textOf(messages[messages.length - 1])

  const bounded = boundSnapshotMessages(messages, SNAPSHOT_MESSAGE_BUDGET_BYTES)

  assert.equal(textOf(bounded[bounded.length - 1]), lastText)
})

test('stage 1 truncates by UTF-8 bytes without splitting a surrogate pair', () => {
  const messages: JsonValue[] = [
    { role: 'toolResult', content: [{ type: 'text', text: '😀'.repeat(10_000) }] }
  ]

  const bounded = boundSnapshotMessages(messages, 10 * KIB)
  const text = textOf(bounded[0])
  const [prefix] = text.split('\n')

  assert.equal(prefix, '😀'.repeat(2048))
  assert.match(text, /\n…\[Phi: \d+ bytes omitted from this view;/)
})

test('stage 4 replaces one huge assistant message when truncation alone cannot fit', () => {
  const messages: JsonValue[] = [
    {
      role: 'assistant',
      toolCallId: 'call-1',
      timestamp: 7,
      content: [{ type: 'text', text: 'x'.repeat(1_500_000) }],
      details: { huge: 'd'.repeat(20_000) }
    }
  ]

  const bounded = boundSnapshotMessages(messages, 2 * KIB)

  assert.equal(bounded.length, 1)
  assert.ok(jsonByteLength(bounded) <= 2 * KIB)
  assert.equal(record(bounded[0]).role, 'assistant')
  assert.equal(record(bounded[0]).toolCallId, 'call-1')
  assert.equal(record(bounded[0]).timestamp, 7)
  assert.deepEqual(record(bounded[0]).content, [
    { type: 'text', text: SNAPSHOT_OMITTED_MESSAGE_TEXT }
  ])
  assert.equal('details' in record(bounded[0]), false)
})

test('projectSessionState output survives one protocol frame for a 2.5 MB session', () => {
  const messages = makeLargeMessages()

  const result = projectSessionState('s1', { cwd: '/tmp', messages })

  assert.doesNotThrow(() => encodeFrame({ kind: 'response', id: '1', ok: true, result }))
  assert.ok(jsonByteLength(record(result).messages) <= SNAPSHOT_MESSAGE_BUDGET_BYTES)
})
