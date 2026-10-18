import test from 'node:test'
import assert from 'node:assert/strict'
import type { PhiAssistantMessage } from '../src/main/agent/engine/event-types'
import { RpcFacadeEventProjector } from '../src/main/agent/engine/rpc/facade-event-projection'

const assistant = (): PhiAssistantMessage => ({
  role: 'assistant',
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'synthetic',
  timestamp: 1,
  stopReason: 'stop',
  content: [
    { type: 'thinking', thinking: 'reason', thinkingSignature: 'signed-thinking' },
    { type: 'redactedThinking', data: 'opaque-redacted' },
    { type: 'text', text: 'visible', textSignature: 'signed-text' }
  ],
  usage: {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
})

test('private controls dispatch first and cannot be reclassified or spread to public events/history', () => {
  const key = 'synthetic-independent-child-capability'
  let dispatched = 0
  const projector = new RpcFacadeEventProjector((frame) => {
    dispatched++
    Object.assign(frame, { type: 'agent_start' })
  })
  assert.equal(
    projector.event({
      type: 'host_uri_request',
      operation: 'write',
      url: 'phi-child://request/x',
      content: JSON.stringify({ capability: key })
    }),
    undefined
  )
  assert.equal(dispatched, 1)
  const projected = projector.event({
    type: 'message_update',
    privateKey: key,
    message: { ...assistant(), privateKey: key },
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 2,
      delta: 'visible',
      partial: { ...assistant(), privateKey: key },
      privateKey: key
    }
  })
  assert.ok(projected)
  assert.equal(JSON.stringify(projected).includes(key), false)
  assert.deepEqual(projector.messages([{ ...assistant(), privateKey: key }]), [assistant()])
  assert.equal(projector.event({ type: 'unknown_future_control', content: key }), undefined)
  assert.throws(
    () => projector.messages([{ role: 'unrecognized-extension', capability: key }]),
    /Unsupported remote public history/
  )
  assert.equal(
    projector.event({
      type: 'message_update',
      message: assistant(),
      assistantMessageEvent: { type: 'text_delta', partial: assistant() }
    }),
    undefined
  )
})

test('reserved phi-child tool carriers and their results remain private; legal signed/image/details content survives', () => {
  const projector = new RpcFacadeEventProjector()
  const secret = 'synthetic-private-child-key'
  const privateAssistant = {
    ...assistant(),
    content: [
      {
        type: 'toolCall',
        id: 'private-call',
        name: 'write',
        arguments: { path: 'phi-child://request/x', content: secret }
      }
    ]
  }
  assert.equal(projector.message(privateAssistant), undefined)
  assert.equal(
    projector.event({
      type: 'tool_execution_end',
      toolCallId: 'private-call',
      toolName: 'write',
      result: { content: [{ type: 'text', text: secret }] }
    }),
    undefined
  )
  const image = { type: 'image', data: 'synthetic-png', mimeType: 'image/png' }
  const publicResult = {
    role: 'toolResult',
    toolCallId: 'public-call',
    toolName: 'present_files',
    timestamp: 2,
    isError: false,
    content: [{ type: 'text', text: 'complete' }, image],
    details: { complete: 'domain-specific details' },
    prunedAt: 3
  }
  assert.deepEqual(projector.message(publicResult), publicResult)
  const partial = { ...assistant(), content: [image] }
  const projected = projector.event({
    type: 'message_update',
    message: partial,
    assistantMessageEvent: { type: 'image_end', contentIndex: 0, content: image, partial }
  })
  assert.deepEqual(projected, {
    type: 'message_update',
    message: partial,
    assistantMessageEvent: { type: 'image_end', contentIndex: 0, content: image, partial }
  })
  const safeTool = {
    type: 'toolCall',
    id: 'safe',
    name: 'write',
    arguments: { path: '/project/file', content: 'user-authored' }
  }
  const toolPartial = { ...assistant(), content: [safeTool] }
  assert.deepEqual(
    projector.event({
      type: 'message_update',
      message: toolPartial,
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: safeTool,
        partial: toolPartial
      }
    }),
    {
      type: 'message_update',
      message: toolPartial,
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: safeTool,
        partial: toolPartial
      }
    }
  )
  const failure = new RpcFacadeEventProjector(() => {
    throw new Error('private dispatcher failed')
  })
  assert.throws(
    () =>
      failure.event({ type: 'host_uri_request', url: 'phi-child://request/x', content: secret }),
    /private dispatcher failed/
  )
})

test('verified compaction history exposes display fields while stripping provider and authority payloads', () => {
  const projector = new RpcFacadeEventProjector()
  const display = {
    role: 'compactionSummary',
    summary: 'Confirmed compacted history',
    shortSummary: 'Retained facts',
    tokensBefore: 0,
    tokensAfter: 12.5,
    timestamp: 123,
    method: 'soft',
    blocks: [
      { type: 'text', text: 'Display block' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }
    ]
  }
  assert.deepEqual(
    projector.messages([
      {
        ...display,
        providerPayload: { credential: 'PRIVATE_PROVIDER_SENTINEL' },
        authority: 'PRIVATE_AUTHORITY_SENTINEL'
      }
    ]),
    [display]
  )
})

test('malformed compaction messages and unrelated custom roles still fail public history projection', () => {
  for (const message of [
    { role: 'compactionSummary', summary: 'Summary', timestamp: 1, tokensBefore: -1 },
    {
      role: 'compactionSummary',
      summary: 'Summary',
      timestamp: 1,
      tokensBefore: 0,
      blocks: [{ type: 'image', url: 'https://external.invalid/image' }]
    },
    { role: 'unknownCustomRole', summary: 'Summary', timestamp: 1 }
  ])
    assert.throws(
      () => new RpcFacadeEventProjector().messages([message]),
      /Unsupported remote public history/
    )
})

const privateCall = (id: string): PhiAssistantMessage => ({
  ...assistant(),
  content: [
    {
      type: 'toolCall',
      id,
      name: 'write',
      arguments: { path: 'phi-child://request/x', content: 'synthetic-private-child-key' }
    }
  ]
})
const privateResult = (id: string): Record<string, unknown> => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: 'write',
  timestamp: 2,
  isError: false,
  content: [{ type: 'text', text: 'synthetic-private-child-key' }]
})

test('private tool carrier budget counts only in-flight calls, so completed calls never exhaust it', () => {
  const projector = new RpcFacadeEventProjector()
  for (let index = 0; index < 4200; index++) {
    const id = `private-${index}`
    assert.equal(projector.message(privateCall(id)), undefined)
    assert.equal(projector.event({ type: 'message_end', message: privateResult(id) }), undefined)
    assert.deepEqual(
      projector.event({
        type: 'turn_end',
        message: assistant(),
        toolResults: [privateResult(id)]
      }),
      { type: 'turn_end', message: assistant(), toolResults: [] }
    )
  }
  const publicResult = { ...privateResult('public-call'), content: [{ type: 'text', text: 'ok' }] }
  assert.deepEqual(projector.message(publicResult), publicResult)
})

test('private tool carrier overflow rejects only the overflowing call and keeps the stream usable', () => {
  const projector = new RpcFacadeEventProjector()
  for (let index = 0; index < 4096; index++)
    assert.equal(projector.message(privateCall(`inflight-${index}`)), undefined)
  assert.throws(() => projector.message(privateCall('overflow')), /budget exceeded/)
  const publicEvent = { type: 'agent_start' }
  assert.deepEqual(projector.event(publicEvent), publicEvent)
  projector.messages([privateResult('inflight-0')])
  assert.equal(projector.message(privateCall('after-release')), undefined)
})

test('private results inside history replay are recognised and released', () => {
  const projector = new RpcFacadeEventProjector()
  const history = [privateCall('h1'), privateResult('h1')]
  assert.deepEqual(projector.messages(history), [])
  const reused = { ...privateResult('h1'), content: [{ type: 'text', text: 'public again' }] }
  assert.deepEqual(projector.messages([reused]), [reused])
})
