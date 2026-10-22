import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserTextVault } from '../src/main/agent/browser/browser-text-vault'
import {
  assertBrowserHistoryPrivate,
  browserToolStreamProjector,
  cursorSafeHostTools
} from '../src/main/agent/engine/rpc/browser-tool-stream'

const raw = {
  action: 'typeText',
  tabId: 'tab',
  expectedDocumentRevision: 2,
  text: 'ONLY_PRIVATE_TYPED_ARGUMENT',
  consequence: 'write'
}
const block = { type: 'toolCall', id: 'call', name: 'browser', arguments: raw }
const message = { content: [block] }
test('a cursor generation does not receive the browser host tool', () => {
  const tools = [{ name: 'browser' }, { name: 'read' }]
  const kept = (providers: string[]): string[] =>
    cursorSafeHostTools({
      tools,
      transport: { models: providers.map((provider) => ({ provider })) }
    }).map((tool) => tool.name)
  assert.deepEqual(kept(['cursor']), ['read'])
  assert.deepEqual(kept(['anthropic', 'cursor']), ['read'])
  assert.equal(
    cursorSafeHostTools({ tools, transport: { models: [{ provider: 'anthropic' }] } }),
    tools
  )
})

test('browser deltas, provider replay JSON and error snapshots never expose typed arguments', () => {
  const vault = new BrowserTextVault(),
    stop = new AbortController()
  const project = browserToolStreamProjector(vault, stop.signal)
  const replay = {
    type: 'anthropicMessage',
    nested: JSON.stringify({
      content: [{ type: 'tool_use', id: 'call', name: 'browser', input: raw }]
    })
  }
  const start = project({ type: 'start', partial: { content: [], providerPayload: replay } })
  const delta = project({
    type: 'toolcall_delta',
    contentIndex: 0,
    delta: JSON.stringify(raw),
    partial: message
  })
  const error = project({ type: 'error', error: { ...message, providerPayload: replay } })
  assert.equal(delta, undefined)
  for (const value of [start, error]) assert.ok(!JSON.stringify(value).includes(raw.text))
  const end = project({ type: 'toolcall_end', contentIndex: 0, toolCall: block, partial: message })!
  const safe = (end.toolCall as typeof block).arguments
  assert.notEqual(safe.text, raw.text)
  assert.deepEqual(vault.approvalInput('call', safe), safe)
  stop.abort()
  assert.deepEqual(vault.take('call', safe.text), { denied: true })
})

test('browser stream terminal mutation, unknown placeholders, replay and peer vaults fail closed', () => {
  const vault = new BrowserTextVault(),
    peer = new BrowserTextVault()
  const project = browserToolStreamProjector(vault, new AbortController().signal)
  const end = project({ type: 'toolcall_end', contentIndex: 0, toolCall: block, partial: message })!
  const safe = (end.toolCall as typeof block).arguments
  assert.equal(peer.take('call', safe.text), undefined)
  const changed = { ...block, arguments: { ...raw, text: 'CHANGED_PRIVATE_TEXT' } }
  const final = project({ type: 'done', message: { content: [changed] } })!
  assert.deepEqual((final.message as typeof message).content[0].arguments, { action: 'invalid' })
  assert.deepEqual(vault.take('call', safe.text), { denied: true })
  assert.equal(vault.take('call', safe.text), undefined)
  const forged = peer.sanitize('other', { ...raw, text: safe.text })
  assert.deepEqual(forged, { action: 'invalid' })
})

test('nonbrowser DTOs, successful text and thinking preserve their exact native content', () => {
  const project = browserToolStreamProjector(new BrowserTextVault(), new AbortController().signal)
  const events = [
    {
      type: 'thinking_delta',
      contentIndex: 0,
      delta: 'ordinary thinking',
      partial: {
        content: [{ type: 'thinking', thinking: 'ordinary thinking', thinkingSignature: 'opaque' }]
      }
    },
    {
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: '{"path":"file"}',
      partial: {
        content: [
          {
            type: 'toolCall',
            name: 'read',
            id: 'read',
            arguments: { path: 'file' },
            rawBlock: { exact: true }
          }
        ]
      }
    },
    {
      type: 'done',
      message: {
        content: [{ type: 'text', text: raw.text }],
        providerPayload: {
          type: 'openaiResponsesHistory',
          output: [{ type: 'message', content: 'unchanged' }]
        }
      }
    }
  ]
  for (const event of events) assert.deepEqual(project(event), event)
})

test('model replay of a genuine pending placeholder cannot consume its original private entry', () => {
  const vault = new BrowserTextVault()
  const safe = vault.sanitize('call', raw)
  const project = browserToolStreamProjector(vault, new AbortController().signal)
  const replay = { ...block, arguments: safe }
  const event = project({
    type: 'toolcall_end',
    contentIndex: 0,
    toolCall: replay,
    partial: { content: [replay] }
  })!
  assert.deepEqual((event.toolCall as typeof block).arguments, { action: 'invalid' })
  assert.deepEqual(vault.take('call', safe.text), { denied: true })
})

test('restore rejects typed browser plaintext but accepts opaque history without restoring execution authority', () => {
  const request = (messages: unknown[]): { context: { messages: unknown[] } } => ({
    context: { messages }
  })
  assert.throws(() =>
    assertBrowserHistoryPrivate(request([{ role: 'assistant', content: [block] }]))
  )
  const vault = new BrowserTextVault()
  const safe = vault.sanitize('call', raw)
  vault.clear()
  assert.doesNotThrow(() =>
    assertBrowserHistoryPrivate(
      request([
        { role: 'user', content: JSON.stringify(block) },
        { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(block) }] },
        { role: 'assistant', content: [{ ...block, arguments: safe }] }
      ])
    )
  )
  assert.equal(vault.take('call', safe.text), undefined)
  assert.throws(() =>
    assertBrowserHistoryPrivate(
      request([
        {
          role: 'assistant',
          content: [],
          providerPayload: {
            type: 'anthropicMessage',
            nested: JSON.stringify({ name: 'browser', input: raw })
          }
        }
      ])
    )
  )
})

const historicPlaceholder = { ...raw, text: '__phi_browser_text_v1__:old' }
const historicVariants = {
  rawBlock: { type: 'tool_use', name: 'browser', input: raw },
  providerMetadata: { name: 'browser', arguments: raw },
  thoughtSignature: JSON.stringify({ name: 'browser', input: raw }),
  unnamedInput: { rawBlock: { input: raw } },
  unnamedAction: { rawBlock: raw },
  invalidAction: { rawBlock: { input: { action: 'invalid', text: raw.text } } },
  nestedInvalid: { providerMetadata: { args: { action: 'invalid', nested: { text: raw.text } } } },
  mismatchedName: {
    providerMetadata: { name: 'metadata', input: { action: 'invalid', text: raw.text } }
  },
  computerInput: {
    providerMetadata: { type: 'computer', actions: [{ type: 'type', text: raw.text }] }
  },
  ownedSyntax: { rawBlock: '<tool_call name="browser">' + JSON.stringify(raw) + '</tool_call>' }
}
for (const [name, value] of Object.entries(historicVariants))
  test(`restored placeholder cannot hide plaintext in browser ${name} replay`, () => {
    const fields = ['rawBlock', 'providerMetadata', 'thoughtSignature'].includes(name)
      ? { [name]: value }
      : typeof value === 'object' && value !== null
        ? value
        : {}
    assert.throws(() =>
      assertBrowserHistoryPrivate({
        context: {
          messages: [
            {
              role: 'assistant',
              content: [{ ...block, arguments: historicPlaceholder, ...fields }]
            }
          ]
        }
      })
    )
  })

test('native Cursor JSON replay is private before content arrives and raw restore fails closed', () => {
  const cursor = {
    type: 'cursorHistory',
    wireRoute: 'cursor-route',
    digest: 'opaque-digest',
    records: [
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call', toolName: 'browser', args: raw }]
      })
    ]
  }
  const event = { type: 'start', partial: { content: [], providerPayload: cursor } }
  const project = browserToolStreamProjector(new BrowserTextVault(), new AbortController().signal)
  assert.ok(!JSON.stringify(project(event)).includes(raw.text))
  assert.throws(() =>
    assertBrowserHistoryPrivate({
      context: { messages: [{ role: 'assistant', content: [], providerPayload: cursor }] }
    })
  )
})

test('safe browser opaque signatures and nonbrowser replay preserve ordinary native history', () => {
  const message = {
    role: 'assistant',
    content: [
      { ...block, arguments: historicPlaceholder, thoughtSignature: 'opaque-browser-signature' },
      { type: 'text', text: raw.text, textSignature: 'opaque-text-signature' },
      { type: 'thinking', thinking: raw.text, thinkingSignature: 'opaque-thinking-signature' },
      {
        type: 'toolCall',
        id: 'read',
        name: 'read',
        arguments: { path: 'file' },
        rawBlock: raw,
        providerMetadata: { name: 'read', arguments: raw },
        thoughtSignature: JSON.stringify(raw)
      }
    ],
    providerPayload: {
      type: 'cursorHistory',
      records: [JSON.stringify({ toolName: 'read', toolCallId: 'read', args: raw })]
    }
  }
  assert.doesNotThrow(() => assertBrowserHistoryPrivate({ context: { messages: [message] } }))
  const project = browserToolStreamProjector(new BrowserTextVault(), new AbortController().signal)
  const live = project({
    type: 'done',
    message: { ...message, content: [message.content[1], message.content[2], message.content[3]] }
  })!
  assert.deepEqual(live.message, {
    ...message,
    content: [message.content[1], message.content[2], message.content[3]]
  })
})

test('browser opaque thought signatures stay intact while JSON replay arguments are sanitized', () => {
  for (const signature of ['opaque-browser-signature', JSON.stringify({ input: raw })]) {
    const project = browserToolStreamProjector(new BrowserTextVault(), new AbortController().signal)
    const toolCall = { ...block, thoughtSignature: signature }
    const event = project({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall,
      partial: { content: [toolCall] }
    })!
    const projected = event.toolCall as Record<string, unknown>
    assert.ok(!JSON.stringify(projected).includes(raw.text))
    if (signature === 'opaque-browser-signature')
      assert.equal(projected.thoughtSignature, signature)
  }
})

test('live browser replay cannot hide invalid text args or unparsed owned syntax in provider metadata', () => {
  for (const payload of [
    { name: 'browser', id: 'call', input: { action: 'invalid', text: raw.text } },
    {
      toolName: 'browser',
      toolCallId: 'call',
      rawBlock: '<browser>' + JSON.stringify(raw) + '</browser>'
    },
    {
      name: 'browser',
      providerMetadata: JSON.stringify({ input: { action: 'invalid', text: raw.text } })
    }
  ]) {
    const project = browserToolStreamProjector(new BrowserTextVault(), new AbortController().signal)
    const event = project({ type: 'start', partial: { content: [], providerPayload: payload } })
    assert.ok(!JSON.stringify(event).includes(raw.text))
    assert.throws(() =>
      assertBrowserHistoryPrivate({
        context: { messages: [{ role: 'assistant', content: [], providerPayload: payload }] }
      })
    )
  }
})

test('browser replay aliases cannot be hidden by conflicting or empty names', () => {
  for (const aliases of [
    { name: 'metadata', toolName: 'browser' },
    { name: '', toolName: 'browser' },
    { name: 'metadata', toolName: '', function: { name: 'browser' } },
    { name: 'browser', toolName: 'read' }
  ]) {
    const payload = { ...aliases, toolCallId: 'call', args: raw }
    const project = browserToolStreamProjector(new BrowserTextVault(), new AbortController().signal)
    const event = project({ type: 'start', partial: { content: [], providerPayload: payload } })
    assert.ok(!JSON.stringify(event).includes(raw.text))
    assert.throws(() =>
      assertBrowserHistoryPrivate({
        context: { messages: [{ role: 'assistant', content: [], providerPayload: payload }] }
      })
    )
  }
})
