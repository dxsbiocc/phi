import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { AssistantMessageEventStream } from '@oh-my-pi/pi-ai/utils/event-stream'
import type { AssistantMessage, AssistantMessageEvent, Model, Context } from '@oh-my-pi/pi-ai'
import type { StreamFn } from '@oh-my-pi/pi-agent-core'
import {
  NativeSseCapture,
  NativeStreamIntegrityError
} from '../../src/main/agent/engine/phi-extension/lib/rpc-native-sse'
import { repairNativeTerminal } from '../../src/main/agent/engine/phi-extension/lib/rpc-native-repair'
import {
  createNativeStreamIntegrityAdapter,
  type TrustedNativeStreamScope
} from '../../src/main/agent/engine/phi-extension/lib/rpc-native-stream-adapter'

const names: string[] = []
async function check(name: string, run: () => unknown | Promise<unknown>): Promise<void> {
  await run()
  names.push(name)
}
const text = { type: 'text', text: 'Visible 中文🙂' } as const
const thinking = {
  type: 'thinking',
  thinking: 'signed private thought',
  thinkingSignature: 'opaque-signature'
} as const
const opaque = { type: 'redactedThinking', data: 'opaque-private-data' } as const
function message(
  content: AssistantMessage['content'] = [thinking, opaque, text]
): AssistantMessage {
  return {
    role: 'assistant',
    api: 'anthropic-messages',
    provider: 'fixture',
    model: 'one',
    content,
    stopReason: 'stop',
    timestamp: 1,
    usage: {
      input: 2,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
  }
}
function done(content?: AssistantMessage['content']): AssistantMessageEvent {
  return { type: 'done', reason: 'stop', message: message(content) }
}
const encode = (events: unknown[]): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(
    events
      .map(
        (event) => 'data: ' + (typeof event === 'string' ? event : JSON.stringify(event)) + '\n\n'
      )
      .join('')
  )
function capture(events: unknown[] = [done(), '[DONE]']): NativeSseCapture {
  const result = new NativeSseCapture()
  result.feed(encode(events))
  result.finish()
  return result
}
const identity = { provider: 'fixture', id: 'one' }
const endpoint = 'http://127.0.0.1:34567/v1/pi/stream'
const scope: TrustedNativeStreamScope = {
  generation: 1,
  endpoint,
  models: [identity],
  isActive: () => true
}
const model = {
  provider: 'fixture',
  id: 'one',
  api: 'openai-completions',
  transport: 'pi-native',
  baseUrl: 'http://127.0.0.1:34567'
} as Model<'openai-completions'>
const context: Context = { messages: [{ role: 'user', content: 'private fixture', timestamp: 1 }] }
const nativeBody = JSON.stringify({ modelId: 'fixture/one', context, options: {}, stream: true })
const drain = async (stream: Awaited<ReturnType<StreamFn>>): Promise<AssistantMessage> => {
  for await (const event of stream) {
    assert.equal(typeof event.type, 'string')
  }
  return stream.result()
}

await check('fatal UTF8 / one-byte chunks / split CRLF / comments / multidata', () => {
  const event = JSON.stringify(done()).replace(',"reason"', ',\r\ndata: "reason"')
  const bytes = new TextEncoder().encode(
    ': private comment\r\ndata: ' + event + '\r\n\r\ndata: [DONE]\r\n\r\n'
  )
  const parser = new NativeSseCapture()
  for (const byte of bytes) parser.feed(Uint8Array.of(byte))
  parser.finish()
  assert.deepEqual(parser.rawTerminal, done())
})
await check('invalid UTF8 rejected', () =>
  assert.throws(
    () => new NativeSseCapture().feed(Uint8Array.of(0xc3, 0x28)),
    NativeStreamIntegrityError
  )
)
await check('truncated UTF8 rejected at EOF', () => {
  const p = new NativeSseCapture()
  p.feed(Uint8Array.of(0xc3))
  assert.throws(() => p.finish(), NativeStreamIntegrityError)
})
await check('truncated SSE frame rejected', () => {
  const p = new NativeSseCapture()
  p.feed(new TextEncoder().encode('data: {}'))
  assert.throws(() => p.finish(), NativeStreamIntegrityError)
})
await check('actual event byte budget rejects oversized comments and data', () => {
  assert.throws(
    () => new NativeSseCapture(8).feed(new TextEncoder().encode(': 12345678\n\n')),
    NativeStreamIntegrityError
  )
  assert.throws(() => new NativeSseCapture(8).feed(encode([done()])), NativeStreamIntegrityError)
})
for (const [name, events] of [
  ['duplicate terminal', [done(), done()]],
  ['DONE before terminal', ['[DONE]']],
  ['duplicate DONE', [done(), '[DONE]', '[DONE]']],
  ['unknown event', [{ type: 'unknown' }]],
  ['invalid delta index', [{ type: 'thinking_delta', contentIndex: 4096, delta: 'x' }]],
  [
    'wrong terminal role',
    [{ type: 'done', reason: 'stop', message: { ...message(), role: 'user' } }]
  ],
  ['wrong terminal reason', [{ type: 'done', reason: 'length', message: message() }]],
  ['unknown terminal content', [done([{ type: 'unexpected' } as unknown as typeof text])]]
] as const)
  await check(name, () => assert.throws(() => capture([...events]), NativeStreamIntegrityError))
await check('missing DONE marker at EOF rejected', () =>
  assert.throws(() => capture([done()]), NativeStreamIntegrityError)
)
await check('depth limit rejects pathological terminal metadata', () => {
  let value: unknown = {}
  for (let i = 0; i < 70; i++) value = { value }
  assert.throws(() => capture([{ ...done(), value }]), NativeStreamIntegrityError)
})
await check('only missing opaque is inserted with original fields/blocks preserved', () => {
  const original = done([thinking, text])
  if (original.type !== 'done') throw Error('fixture')
  original.message.usage.output = 99
  const repaired = repairNativeTerminal(original, capture(), identity)
  assert.equal(repaired.type, 'done')
  if (repaired.type !== 'done') return
  assert.deepEqual(repaired.message.content, [thinking, opaque, text])
  assert.equal(repaired.message.content[0], thinking)
  assert.equal(repaired.message.content[2], text)
  assert.equal(repaired.message.usage, original.message.usage)
  assert.equal(repaired.message.usage.output, 99)
})
await check('sparse signed thinking restored without changing signature or metadata', () => {
  const original = done([{ ...thinking, thinking: '', summary: true }, text])
  const result = repairNativeTerminal(original, capture(), identity)
  assert.equal(result.type, 'done')
  if (result.type !== 'done') return
  assert.deepEqual(result.message.content[0], { ...thinking, summary: true })
  assert.deepEqual(result.message.content[1], opaque)
})
await check('source delta disallows sparse overwrite', () => {
  const original = done([{ ...thinking, thinking: '' }, text])
  const raw = capture([
    { type: 'thinking_delta', contentIndex: 0, delta: thinking.thinking },
    done([thinking, text]),
    '[DONE]'
  ])
  assert.equal(repairNativeTerminal(original, raw, identity), original)
})
await check('unsigned sparse content is never manufactured', () => {
  const original = done([{ type: 'thinking', thinking: '' }, text])
  assert.equal(
    repairNativeTerminal(
      original,
      capture([done([{ type: 'thinking', thinking: 'secret' }, text]), '[DONE]']),
      identity
    ),
    original
  )
})
await check('existing opaque is not duplicated', () => {
  const original = done()
  assert.equal(repairNativeTerminal(original, capture(), identity), original)
})
await check('legitimate visible-text normalization remains original', () => {
  const original = done([{ type: 'text', text: 'safe normalized text' }])
  assert.equal(
    repairNativeTerminal(
      original,
      capture([done([{ type: 'text', text: '<think>changed</think>' }]), '[DONE]']),
      identity
    ),
    original
  )
})
for (const [name, raw, base] of [
  ['ambiguous duplicate signature', [thinking, thinking, opaque, text], [thinking, thinking, text]],
  ['ambiguous duplicate opaque', [thinking, opaque, opaque, text], [thinking, text]],
  ['ambiguous duplicate text anchor', [text, opaque, text], [text, text]],
  [
    'conflicting signature',
    [thinking, opaque, text],
    [{ ...thinking, thinkingSignature: 'other' }, text]
  ],
  [
    'changed visible content cannot authorize opaque insertion',
    [thinking, opaque, text],
    [thinking, { ...text, text: 'safe redacted text' }]
  ],
  ['conflicting opaque', [thinking, opaque, text], [thinking, { ...opaque, data: 'other' }, text]]
] as const)
  await check(name, () =>
    assert.throws(
      () => repairNativeTerminal(done([...base]), capture([done([...raw]), '[DONE]']), identity),
      NativeStreamIntegrityError
    )
  )
await check('tool id/name and order anchor opaque without overwriting args', () => {
  const tool = {
    type: 'toolCall',
    id: 'call',
    name: 'inspect',
    arguments: { path: 'ordinary.txt' }
  } as const
  const original = done([tool, text]),
    result = repairNativeTerminal(
      original,
      capture([done([tool, opaque, text]), '[DONE]']),
      identity
    )
  assert.equal(result.type, 'done')
  if (result.type === 'done') assert.equal(result.message.content[0], tool)
})
await check('missing/cross-model/raw error terminal cannot authorize success', () => {
  assert.throws(
    () => repairNativeTerminal(done(), new NativeSseCapture(), identity),
    NativeStreamIntegrityError
  )
  assert.throws(
    () => repairNativeTerminal(done(), capture(), { ...identity, id: 'other' }),
    NativeStreamIntegrityError
  )
  assert.throws(
    () =>
      repairNativeTerminal(
        done(),
        capture([
          { type: 'error', reason: 'error', error: { ...message(), stopReason: 'error' } },
          '[DONE]'
        ]),
        identity
      ),
    NativeStreamIntegrityError
  )
})
await check('original error/loopguard remains error despite raw success', () => {
  const error = {
    type: 'error',
    reason: 'error',
    error: {
      ...message([thinking, text]),
      stopReason: 'error',
      errorMessage: 'original loop guard'
    }
  } as const
  assert.equal(repairNativeTerminal(error, capture(), identity), error)
})

function originalFor(
  output: AssistantMessageEvent = done([thinking, text]),
  gate?: () => Promise<void>
): StreamFn {
  return (_model, _context, options) => {
    const stream = new AssistantMessageEventStream()
    void (async () => {
      try {
        const response = await options!.fetch!(endpoint, {
          method: 'POST',
          body: nativeBody,
          signal: options?.signal
        })
        await options?.onResponse?.({
          status: response.status,
          headers: Object.fromEntries(response.headers)
        })
        await response.text()
        if (gate) await gate()
        stream.push(output)
      } catch (error) {
        stream.fail(error)
      }
    })()
    return stream
  }
}
const fetchReply = async (): Promise<Response> =>
  new Response(encode([done(), '[DONE]']), {
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'private-id' }
  })
await check('original wrapper/options/onResponse survive real serial body tap', async () => {
  let calls = 0,
    responses = 0
  const original = originalFor()
  const adapter = createNativeStreamIntegrityAdapter((...args) => {
    calls++
    return original(...args)
  }, scope)
  const result = await drain(
    await adapter(model, context, {
      fetch: fetchReply,
      onResponse: (meta) => {
        responses++
        assert.equal(meta.headers['x-request-id'], 'private-id')
      }
    })
  )
  assert.deepEqual(result.content, [thinking, opaque, text])
  assert.equal(calls, 1)
  assert.equal(responses, 1)
})
await check('non-native returns exact original stream unchanged', () => {
  const stream = new AssistantMessageEventStream()
  const adapter = createNativeStreamIntegrityAdapter(() => stream, scope)
  assert.equal(adapter({ ...model, transport: undefined }, context), stream)
  stream.end(message())
})
await check('unapproved model/endpoint/inactive generation reject before original', async () => {
  for (const [selected, trusted] of [
    [{ ...model, id: 'forged' }, scope],
    [{ ...model, baseUrl: 'http://127.0.0.1:1234' }, scope],
    [model, { ...scope, isActive: () => false }]
  ] as const) {
    let calls = 0
    const adapter = createNativeStreamIntegrityAdapter(() => {
      calls++
      return new AssistantMessageEventStream()
    }, trusted)
    await assert.rejects(drain(await adapter(selected, context)), NativeStreamIntegrityError)
    assert.equal(calls, 0)
  }
})
await check('caller abort before headers terminates wrapper and owned source', async () => {
  const controller = new AbortController()
  const adapter = createNativeStreamIntegrityAdapter(originalFor(), scope)
  const result = drain(
    await adapter(model, context, {
      signal: controller.signal,
      fetch: async (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          )
        )
    })
  )
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
})
await check('cancel after raw done never repairs successful output', async () => {
  const controller = new AbortController()
  const adapter = createNativeStreamIntegrityAdapter(
    originalFor(done([thinking, text]), async () => {
      controller.abort()
    }),
    scope
  )
  await assert.rejects(
    drain(await adapter(model, context, { signal: controller.signal, fetch: fetchReply })),
    { name: 'AbortError' }
  )
})
await check('scope revocation aborts in-flight source', async () => {
  const controller = new AbortController()
  let settled = false
  const adapter = createNativeStreamIntegrityAdapter(originalFor(), {
    ...scope,
    signal: controller.signal
  })
  const result = drain(
    await adapter(model, context, {
      fetch: async () => {
        settled = true
        controller.abort()
        return fetchReply()
      }
    })
  )
  await assert.rejects(result, { name: 'AbortError' })
  assert.equal(settled, true)
})
await check('original onResponse exception is preserved', async () => {
  const error = new Error('original observer')
  const adapter = createNativeStreamIntegrityAdapter(originalFor(), scope)
  await assert.rejects(
    drain(
      await adapter(model, context, {
        fetch: fetchReply,
        onResponse: () => {
          throw error
        }
      })
    ),
    (value) => value === error
  )
})
await check('original end(result) without event resolves without forged repair', async () => {
  const original = message([thinking, text])
  const adapter = createNativeStreamIntegrityAdapter(() => {
    const stream = new AssistantMessageEventStream()
    stream.end(original)
    return stream
  }, scope)
  assert.equal(await drain(await adapter(model, context)), original)
})
await check('concurrent calls keep raw terminal and deltas private', async () => {
  const adapter = createNativeStreamIntegrityAdapter(originalFor(), scope)
  const run = async (label: string): Promise<AssistantMessage> =>
    drain(
      await adapter(model, context, {
        fetch: async () => {
          await delay(label === 'A' ? 4 : 1)
          return new Response(
            encode([done([thinking, { ...opaque, data: label }, text]), '[DONE]']),
            { headers: { 'content-type': 'text/event-stream' } }
          )
        }
      })
    )
  const [a, b] = await Promise.all([run('A'), run('B')])
  assert.equal((a.content[1] as typeof opaque).data, 'A')
  assert.equal((b.content[1] as typeof opaque).data, 'B')
})
await check('missing opaque without ordinary anchors fails closed', () => {
  assert.throws(
    () => repairNativeTerminal(done([]), capture([done([opaque]), '[DONE]']), identity),
    NativeStreamIntegrityError
  )
})
await check('late fetch acquisition is canceled after caller abort', async () => {
  const controller = new AbortController()
  let resolve!: (response: Response) => void
  let canceled = 0
  let called = false
  const adapter = createNativeStreamIntegrityAdapter(originalFor(), scope)
  const result = drain(
    await adapter(model, context, {
      signal: controller.signal,
      fetch: async () => {
        called = true
        return new Promise<Response>((complete) => {
          resolve = complete
        })
      }
    })
  )
  while (!called) await delay(1)
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          canceled++
        }
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    )
  )
  await delay(5)
  assert.equal(canceled, 1)
})
await check('malformed/truncated native EOF cannot authorize success', async () => {
  const adapter = createNativeStreamIntegrityAdapter(originalFor(), scope)
  await assert.rejects(
    drain(
      await adapter(model, context, {
        fetch: async () =>
          new Response(encode([done()]), { headers: { 'content-type': 'text/event-stream' } })
      })
    ),
    NativeStreamIntegrityError
  )
})
await check('original abort/loopguard error after raw done remains unchanged', async () => {
  const error = {
    type: 'error',
    reason: 'aborted',
    error: {
      ...message([thinking, text]),
      stopReason: 'aborted',
      errorMessage: 'original cancellation'
    }
  } as const
  const adapter = createNativeStreamIntegrityAdapter(originalFor(error), scope)
  assert.equal(await drain(await adapter(model, context, { fetch: fetchReply })), error.error)
})
await check('sequential original SDK retries observe only the final attempt', async () => {
  let requests = 0
  const original: StreamFn = (_model, _context, options) => {
    const stream = new AssistantMessageEventStream()
    void (async () => {
      try {
        for (let i = 0; i < 2; i++)
          await (await options!.fetch!(endpoint, { method: 'POST', body: nativeBody })).text()
        stream.push(done([thinking, text]))
      } catch (error) {
        stream.fail(error)
      }
    })()
    return stream
  }
  const adapter = createNativeStreamIntegrityAdapter(original, scope)
  const result = await drain(
    await adapter(model, context, {
      fetch: async () =>
        new Response(
          encode([done([thinking, { ...opaque, data: String(++requests) }, text]), '[DONE]']),
          { headers: { 'content-type': 'text/event-stream' } }
        )
    })
  )
  assert.equal(requests, 2)
  assert.equal((result.content[1] as typeof opaque).data, '2')
})
await check('original nested fetch abort signal is combined rather than overwritten', async () => {
  const nested = new AbortController()
  const original: StreamFn = (_model, _context, options) => {
    const stream = new AssistantMessageEventStream()
    void (async () => {
      try {
        await options!.fetch!(endpoint, { method: 'POST', body: nativeBody, signal: nested.signal })
        stream.end(message())
      } catch (error) {
        stream.fail(error)
      }
    })()
    return stream
  }
  const adapter = createNativeStreamIntegrityAdapter(original, scope)
  await assert.rejects(
    drain(
      await adapter(model, context, {
        fetch: async (_input, init) => {
          nested.abort()
          assert.equal(init?.signal?.aborted, true)
          throw new DOMException('The operation was aborted', 'AbortError')
        }
      })
    ),
    { name: 'AbortError' }
  )
})
await check('slow outer consumer has a bounded event queue and aborts owned work', async () => {
  let ownedSignal: AbortSignal | undefined
  const original: StreamFn = (_model, _context, options) => {
    ownedSignal = options?.signal
    const stream = new AssistantMessageEventStream()
    for (let i = 0; i < 300; i++)
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'x', partial: message([text]) })
    stream.push(done([text]))
    return stream
  }
  const stream = await createNativeStreamIntegrityAdapter(original, scope)(model, context)
  await assert.rejects(stream.result(), NativeStreamIntegrityError)
  assert.equal(ownedSignal?.aborted, true)
})
console.log(JSON.stringify({ passed: names.length, names }))
