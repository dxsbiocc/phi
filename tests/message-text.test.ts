import assert from 'node:assert/strict'
import test from 'node:test'

import { extractAssistantText as extractRunnerAssistantText } from '../src/main/agent/agents/runner'
import type { PhiAgentEventSummary } from '../src/main/agent/engine/types'
import {
  assistantErrorMessageFromEventSummary,
  assistantErrorText,
  extractAssistantMessageText,
  extractMessageText,
  lastAssistantMessageFrom,
  redactStructuredValue
} from '../src/main/agent/session/message-text'

function summary(value: Record<string, unknown>): PhiAgentEventSummary {
  return value as PhiAgentEventSummary
}

test('extractMessageText preserves every current direct and nested content shape', () => {
  const cases: Array<{ name: string; value: unknown; expected: string }> = [
    { name: 'string', value: 'plain', expected: 'plain' },
    { name: 'undefined', value: undefined, expected: '' },
    { name: 'null', value: null, expected: '' },
    { name: 'number', value: 42, expected: '' },
    { name: 'typed text', value: { type: 'text', text: 'typed' }, expected: 'typed' },
    {
      name: 'typed output text',
      value: { type: 'output_text', text: 'output' },
      expected: 'output'
    },
    {
      name: 'typed input text',
      value: { type: 'input_text', text: 'input' },
      expected: 'input'
    },
    { name: 'untyped text', value: { text: 'untyped' }, expected: 'untyped' },
    {
      name: 'untyped output text',
      value: { output_text: 'untyped output' },
      expected: 'untyped output'
    },
    { name: 'string content', value: { content: 'content' }, expected: 'content' },
    {
      name: 'non-string type does not coerce',
      value: { type: Symbol('custom'), text: 'ignored', content: 'fallback' },
      expected: 'fallback'
    },
    {
      name: 'nested fallback order',
      value: {
        content: { type: 'thinking', text: 'ignored' },
        delta: { data: { value: { result: { output: { outputs: { message: 'delta' } } } } } },
        data: 'later'
      },
      expected: 'delta'
    },
    {
      name: 'nested data',
      value: { data: { type: 'text', text: 'data' } },
      expected: 'data'
    },
    { name: 'nested value', value: { value: 'value' }, expected: 'value' },
    { name: 'nested result', value: { result: 'result' }, expected: 'result' },
    { name: 'nested output', value: { output: 'output' }, expected: 'output' },
    { name: 'nested outputs', value: { outputs: 'outputs' }, expected: 'outputs' },
    { name: 'nested message', value: { message: 'message' }, expected: 'message' },
    {
      name: 'array parts',
      value: [
        'string ',
        null,
        3,
        { type: 'text', text: 'text ' },
        { type: 'output_text', text: 'output ' },
        { type: 'input_text', text: 'input ' },
        { text: 'untyped ' },
        { type: 'thinking', text: 'ignored', content: { text: 'nested' } }
      ],
      expected: 'string text output input untyped nested'
    }
  ]

  for (const { name, value, expected } of cases) {
    assert.equal(extractMessageText(value), expected, name)
  }
})

test('extractAssistantMessageText keeps the index helper semantics distinct from the runner helper', () => {
  const noRole = { content: 'accepted by runner only' }
  assert.equal(extractRunnerAssistantText(noRole), 'accepted by runner only')
  assert.equal(extractAssistantMessageText(noRole), '')

  const broadAssistant = {
    role: 'assistant',
    content: [
      { type: 'output_text', text: 'broad ' },
      'content',
      { type: 'thinking', text: 'ignored' }
    ]
  }
  assert.equal(extractRunnerAssistantText(broadAssistant), '')
  assert.equal(extractAssistantMessageText(broadAssistant), 'broad content')
  assert.equal(extractAssistantMessageText({ role: 'user', content: 'ignored' }), '')

  const arrayWithMessageFields: unknown[] = []
  Object.assign(arrayWithMessageFields, { role: 'assistant', content: 'array fields' })
  assert.equal(extractAssistantMessageText(arrayWithMessageFields), 'array fields')
})

test('lastAssistantMessageFrom preserves nested messages, message, then self ordering', () => {
  const last = {
    messages: [{ role: 'assistant', content: 'messages' }],
    message: { role: 'assistant', content: 'message' },
    role: 'assistant',
    content: 'self'
  }
  assert.equal(lastAssistantMessageFrom(last), last)
  assert.equal(lastAssistantMessageFrom(undefined), undefined)
})

test('assistantErrorText preserves explicit error precedence and assistant content gating', () => {
  assert.equal(assistantErrorText(undefined), '')
  assert.equal(
    assistantErrorText({
      errorMessage: 'explicit error',
      message: 'generic message',
      role: 'assistant',
      stopReason: 'error',
      content: 'content error'
    }),
    'explicit error'
  )
  assert.equal(assistantErrorText({ message: 'generic message' }), 'generic message')
  assert.equal(assistantErrorText({ role: 'user', content: 'ignored' }), '')
  assert.equal(
    assistantErrorText({ role: 'assistant', stopReason: 'error', content: 'content error' }),
    'content error'
  )
  assert.equal(assistantErrorText({ role: 'assistant', content: 'normal content' }), '')
  assert.equal(
    assistantErrorText(
      { role: 'assistant', content: [{ type: 'output_text', text: 'allowed content' }] },
      { allowContent: true }
    ),
    'allowed content'
  )
})

test('assistantErrorMessageFromEventSummary preserves event, batch, result and fallback errors', () => {
  assert.equal(
    assistantErrorMessageFromEventSummary(
      summary({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'error',
          error: { role: 'assistant', errorMessage: 'token=abcdefghijk' }
        }
      })
    ),
    'token=[redacted]'
  )
  assert.equal(
    assistantErrorMessageFromEventSummary(
      summary({
        type: 'message_update',
        assistantMessageEvent: { type: 'error', error: { role: 'assistant', content: [] } }
      })
    ),
    '请求失败'
  )
  assert.equal(
    assistantErrorMessageFromEventSummary(
      summary({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: 'sk-abcdefghijk' }
      })
    ),
    '[redacted]'
  )
  assert.equal(
    assistantErrorMessageFromEventSummary(
      summary({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', content: [] }
      })
    ),
    '请求失败'
  )
  assert.equal(
    assistantErrorMessageFromEventSummary(
      summary({
        type: 'agent_end',
        messages: [{ role: 'assistant', stopReason: 'error', content: 'batched' }]
      })
    ),
    'batched'
  )
  assert.equal(
    assistantErrorMessageFromEventSummary(
      summary({
        type: 'custom_result',
        result: { message: { role: 'assistant', stopReason: 'error', content: 'result' } }
      })
    ),
    'result'
  )
  assert.equal(assistantErrorMessageFromEventSummary(summary({ type: 'agent_end' })), null)
})

test('redactStructuredValue recursively redacts secret keys and sensitive strings', () => {
  assert.deepEqual(
    redactStructuredValue({
      token: 'literal',
      nested: [{ apiKey: 'literal' }, 'Bearer abcdefghijk'],
      safe: 3
    }),
    {
      token: '[redacted]',
      nested: [{ apiKey: '[redacted]' }, 'Bearer [redacted]'],
      safe: 3
    }
  )
})
