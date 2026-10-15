import assert from 'node:assert/strict'
import type {
  ModelGatewayLease,
  ModelGatewayModelRef
} from '../../src/main/agent/engine/model-gateway-types'

export const historyInitial = {
  systemPrompt: ['Preserve this private scientific conversation and its tool evidence.'],
  messages: [
    { role: 'user', content: 'HISTORY_INITIAL inspect ordinary.txt 中文🙂', timestamp: 1 }
  ],
  tools: [
    {
      name: 'inspect',
      description: 'Read ordinary private fixture data',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    }
  ]
}

export function historyAfterTool(
  assistant: Record<string, unknown>,
  result: string,
  initial: typeof historyInitial = historyInitial
): Record<string, unknown> {
  assert.ok(Array.isArray(assistant.content))
  const call = assistant.content.find((block) => block.type === 'toolCall')
  assert.equal(typeof call?.id, 'string')
  return {
    ...structuredClone(initial),
    messages: [
      ...structuredClone(initial.messages),
      structuredClone(assistant),
      {
        role: 'toolResult',
        toolName: 'inspect',
        toolCallId: call.id,
        content: [{ type: 'text', text: result }],
        isError: false,
        timestamp: 2
      },
      { role: 'user', content: 'HISTORY_FOLLOWUP use the exact result', timestamp: 3 }
    ]
  }
}

/** Compare history fields, including every original content block and opaque signature. */
export function historyMessages(messages: Array<Record<string, unknown>>): unknown[] {
  return messages.map((message) =>
    Object.fromEntries(
      [
        'role',
        'content',
        'timestamp',
        'provider',
        'model',
        'api',
        'stopReason',
        'usage',
        'toolCallId',
        'toolName',
        'isError'
      ]
        .filter((key) => Object.hasOwn(message, key))
        .map((key) => [key, message[key]])
    )
  )
}

export function nativeHistoryMessage(text: string): Record<string, unknown> {
  const frames = text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
  assert.equal(frames.filter((frame) => frame.type === 'done').length, 1)
  assert.equal(
    frames.some((frame) => frame.type === 'error'),
    false
  )
  assert.ok(text.includes('data: [DONE]'))
  const message = frames.find((frame) => frame.type === 'done')?.message
  assert.ok(message && typeof message === 'object' && !Array.isArray(message))
  return message as Record<string, unknown>
}

/** Exercise the gateway's actual SDK stateful option without changing existing fixture protocols. */
export async function statefulHistoryTurn(
  lease: ModelGatewayLease,
  ref: ModelGatewayModelRef,
  context: unknown
): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${lease.localPort}/v1/pi/stream`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lease.bearerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      modelId: `${ref.provider}/${ref.id}`,
      context,
      options: {
        statefulResponses: true,
        sessionId: 'untrusted-history-actor',
        promptCacheKey: 'untrusted-history-cache',
        maxTokens: 1024,
        maxRetryDelayMs: 0
      },
      stream: true
    })
  })
  assert.equal(response.status, 200)
  return nativeHistoryMessage(await response.text())
}
