import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startNativeStreamCli, NATIVE_CLI_MODELS } from './helpers/rpcNativeStreamCliFixture'

test(
  'actual CLI public installer preserves opaque/sparse history across new/model/switch/reload/fresh resume',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'phi-native-cli-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const bodies: Array<Record<string, unknown>> = []
    let heldStreams = 0
    const server = createServer(async (request, response) => {
      if (request.url !== '/v1/pi/stream') {
        response.writeHead(404).end()
        return
      }
      assert.equal(request.headers.authorization, 'Bearer synthetic-gateway-bearer')
      request.setEncoding('utf8')
      let raw = ''
      for await (const chunk of request) {
        raw += chunk
        assert.ok(Buffer.byteLength(raw) < 1024 * 1024)
      }
      const body = JSON.parse(raw) as Record<string, unknown>
      bodies.push(body)
      const id = String(body.modelId).split('/').slice(1).join('/')
      assert.ok(NATIVE_CLI_MODELS.some((model) => model === id))
      const ctx = body.context as { messages: Array<{ role: string }> }
      const hold = JSON.stringify(ctx.messages.findLast((entry) => entry.role === 'user')).includes(
        'hold cancellation'
      )
      const thinking = {
          type: 'thinking',
          thinking: 'Private sparse reasoning 中文🙂',
          thinkingSignature: 'opaque-cli-signature'
        },
        opaque = { type: 'redactedThinking', data: 'opaque-cli-private-data' },
        text = { type: 'text', text: hold ? 'Native CLI partial' : 'Native CLI answer' }
      const message = {
        role: 'assistant',
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: id,
        content: [thinking, opaque, text],
        timestamp: 1,
        stopReason: 'stop',
        usage: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      }
      const sparse = JSON.stringify(body.context).includes('sparse')
      const events = [
        { type: 'start', partial: { ...message, content: [] } },
        { type: 'thinking_start', contentIndex: 0, partial: { ...message, content: [thinking] } },
        ...(!sparse
          ? [
              {
                type: 'thinking_delta',
                contentIndex: 0,
                delta: thinking.thinking,
                partial: message
              }
            ]
          : []),
        { type: 'thinking_end', contentIndex: 0, content: thinking.thinking, partial: message },
        { type: 'text_start', contentIndex: 2, partial: message },
        { type: 'text_delta', contentIndex: 2, delta: text.text, partial: message },
        { type: 'text_end', contentIndex: 2, content: text.text, partial: message },
        { type: 'done', reason: 'stop', message }
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (hold) {
        heldStreams++
        response.once('close', () => heldStreams--)
        events.pop()
      }
      for (const event of events) response.write('data: ' + JSON.stringify(event) + '\n\n')
      if (!hold) response.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const first = await startNativeStreamCli(root, base)
    t.after(() => first.close())
    const initial = await first.status()
    assert.equal(initial.type, 'native_fixture_status')
    assert.equal((await first.status('phi-native-reinstall')).same, true)
    await first.connection.prompt('normal reasoning')
    await first.connection.prompt('sparse reasoning')
    const history = await first.connection.request<{
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }>({ type: 'get_messages' })
    const assistants = history.messages.filter((message) => message.role === 'assistant')
    assert.equal(assistants.length, 2)
    for (const message of assistants) {
      assert.deepEqual(
        message.content.map((block) => block.type),
        ['thinking', 'redactedThinking', 'text']
      )
      assert.equal(message.content[0].thinking, 'Private sparse reasoning 中文🙂')
      assert.equal(message.content[0].thinkingSignature, 'opaque-cli-signature')
      assert.equal(message.content[1].data, 'opaque-cli-private-data')
    }
    assert.ok(
      JSON.stringify(bodies[1].context).includes('opaque-cli-private-data'),
      'Next request includes restored opaque history'
    )
    let visible!: () => void
    const seen = new Promise<void>((resolve) => {
      visible = resolve
    })
    const off = first.connection.onEvent((frame) => {
      const event = frame.assistantMessageEvent as { type?: string; delta?: string } | undefined
      if (event?.type === 'text_delta' && event.delta?.includes('Native CLI partial')) visible()
    })
    const canceled = first.connection.prompt('hold cancellation')
    await seen
    await first.connection.abort()
    assert.equal(
      (await canceled).status,
      'aborted',
      'Actual CLI keeps ordinary cancellation status'
    )
    off()
    const deadline = Date.now() + 500
    while (heldStreams && Date.now() < deadline) await delay(10)
    assert.equal(heldStreams, 0)
    const partial = await first.connection.request<{
      messages: Array<{ role: string; stopReason?: string; content: unknown[] }>
    }>({ type: 'get_messages' })
    assert.ok(
      JSON.stringify(partial.messages.findLast((entry) => entry.role === 'assistant')).includes(
        'Native CLI partial'
      )
    )
    assert.equal((await first.connection.prompt('after caller abort')).status, 'completed')
    const old = await first.connection.request<{ sessionFile: string }>({ type: 'get_state' })
    await first.connection.request({ type: 'new_session' })
    const newer = await first.status()
    assert.notEqual(newer.sessionId, initial.sessionId)
    await first.connection.request({
      type: 'set_model',
      provider: 'anthropic',
      modelId: NATIVE_CLI_MODELS[1]
    })
    const state = await first.connection.request<{ model: { id: string } }>({ type: 'get_state' })
    assert.equal(state.model.id, NATIVE_CLI_MODELS[1])
    await first.status()
    await first.connection.request({ type: 'switch_session', sessionPath: old.sessionFile })
    assert.equal((await first.status()).sessionId, initial.sessionId)
    await first.connection.prompt('/phi-native-reload')
    const reloaded = await first.status()
    assert.equal(
      reloaded.instance,
      initial.instance,
      'SDK reload keeps the same extension controller and installed wrapper'
    )
    await first.connection.prompt('/phi-native-rebind')
    const rebound = await first.status()
    assert.notEqual(
      rebound.instance,
      initial.instance,
      'Disposal/re-registration binds a fresh controller to the actual session'
    )
    const ownership = await first.status('phi-native-ownership')
    assert.equal(ownership.rejected, true)
    assert.equal(ownership.foreignPreserved, true)
    assert.equal(first.stderr(), '')
    await first.close()
    const resumed = await startNativeStreamCli(root, base, old.sessionFile)
    t.after(() => resumed.close())
    await resumed.status()
    const restored = await resumed.connection.request<{ messages: unknown[] }>({
      type: 'get_messages'
    })
    assert.ok(JSON.stringify(restored.messages).includes('opaque-cli-private-data'))
    await resumed.connection.prompt('fresh sparse reasoning')
    const final = await resumed.connection.request<{
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }>({ type: 'get_messages' })
    assert.equal(
      final.messages.filter((item) => item.role === 'assistant').at(-1)?.content[0].thinking,
      'Private sparse reasoning 中文🙂'
    )
    assert.equal(bodies.length, 5, 'No lifecycle/model command invokes a provider')
    assert.equal(resumed.stderr(), '')
    await resumed.close()
  }
)
