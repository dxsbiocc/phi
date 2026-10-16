import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeWireCli } from './helpers/rpcNativeWireCliFixture'
import {
  NATIVE_TOOL_WIRE_KEYS,
  NATIVE_OPTION_WIRE_KEYS
} from '../src/main/agent/engine/phi-extension/lib/rpc-native-wire'
import {
  readGatewayJson,
  validateGatewayPayload
} from '../src/main/agent/engine/in-process/model-gateway-request'

test(
  'actual CLI keeps native/local speculative execution objects intact while sending all large-roster provider Tool DTOs',
  { timeout: 30000 },
  async (t) => {
    const wire: Array<{
      context: { tools: Array<Record<string, unknown>>; messages: unknown[] }
      options: Record<string, unknown>
    }> = []
    let held = 0
    const server = createServer(async (request, response) => {
      if (request.url !== '/v1/pi/stream') {
        response.writeHead(404).end()
        return
      }
      assert.equal(request.headers.authorization, 'Bearer synthetic-wire-gateway-bearer')
      request.setEncoding('utf8')
      let raw = ''
      for await (const chunk of request) {
        raw += chunk
        assert.ok(Buffer.byteLength(raw) <= 64 * 1024 * 1024)
      }
      assert.equal(Number(request.headers['content-length']), Buffer.byteLength(raw))
      wire.push(JSON.parse(raw))
      const hold = JSON.stringify(
        (wire.at(-1)!.context.messages as Array<{ role?: string }>).findLast(
          (entry) => entry.role === 'user'
        )
      ).includes('wire hold cancellation')
      const answer = hold ? 'wire DTO partial' : 'wire DTO answer'
      const message = {
        role: 'assistant',
        api: 'openai-completions',
        provider: 'wire-fixture',
        model: 'wire-model',
        content: [{ type: 'text', text: answer }],
        stopReason: 'stop',
        timestamp: 1,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = [
        { type: 'start', partial: { ...message, content: [] } },
        { type: 'text_delta', contentIndex: 0, delta: answer, partial: message },
        { type: 'done', reason: 'stop', message }
      ]
      if (hold) {
        held++
        response.once('close', () => held--)
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
    const fixture = await nativeWireCli(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      process.env.PHI_WIRE_BASELINE === '1'
    )
    t.after(() => fixture.close())
    assert.equal(
      (await fixture.connection.prompt('ordinary first wire request')).status,
      'completed'
    )
    assert.equal(
      (await fixture.connection.prompt('continue the exact history')).status,
      'completed'
    )
    let visible!: () => void
    const partial = new Promise<void>((resolve) => {
      visible = resolve
    })
    const off = fixture.connection.onEvent((frame) => {
      const event = frame.assistantMessageEvent as { type?: string; delta?: string } | undefined
      if (event?.type === 'text_delta' && event.delta?.includes('wire DTO partial')) visible()
    })
    const cancelled = fixture.connection.prompt('wire hold cancellation')
    await partial
    await fixture.connection.abort()
    assert.equal((await cancelled).status, 'aborted')
    off()
    const deadline = Date.now() + 500
    while (held && Date.now() < deadline) await delay(10)
    assert.equal(held, 0)
    assert.equal(
      (await fixture.connection.prompt('after ordinary cancellation')).status,
      'completed'
    )
    const audit = await fixture.audit()
    assert.equal(wire.length, 4)
    assert.equal(audit.length, 4)
    const shapes: Array<{
      bytes: number
      nodes: number
      depth: number
      tools: number
      gatewayAccepted: boolean
    }> = []
    for (const raw of wire) {
      let nodes = 0,
        depth = 0
      const pending: Array<[unknown, number]> = [[raw, 0]]
      while (pending.length) {
        const [value, level] = pending.pop()!
        nodes++
        depth = Math.max(depth, level)
        if (value && typeof value === 'object')
          for (const child of Object.values(value)) pending.push([child, level + 1])
      }
      let gatewayAccepted = false
      try {
        const parsed = await readGatewayJson(
          new Request('http://127.0.0.1/v1/pi/stream', {
            method: 'POST',
            body: JSON.stringify(raw)
          }),
          new AbortController().signal
        )
        validateGatewayPayload(parsed, 'private-wire-lease')
        gatewayAccepted = true
      } catch {
        /* Negative-control evidence; positive asserts below. */
      }
      shapes.push({
        bytes: Buffer.byteLength(JSON.stringify(raw)),
        nodes,
        depth,
        tools: raw.context.tools.length,
        gatewayAccepted
      })
    }
    t.diagnostic(`Actual wire shapes: ${JSON.stringify(shapes)}`)
    if (process.env.PHI_WIRE_BASELINE === '1' || process.env.PHI_WIRE_EVIDENCE === '1') {
      const evidence = await mkdtemp(join(tmpdir(), 'phi-wire-cli-evidence-'))
      t.after(() => rm(evidence, { recursive: true, force: true }))
      await writeFile(
        join(
          evidence,
          process.env.PHI_WIRE_BASELINE === '1' ? 'baseline-shape.json' : 'cli-shape.json'
        ),
        JSON.stringify(shapes) + '\n',
        { mode: 0o600 }
      )
      t.diagnostic(`Wire shape evidence saved temporarily at ${evidence}`)
    }
    for (const [index, raw] of wire.entries()) {
      const local = audit[index]
      assert.equal(local.speculativeEnabled, true)
      assert.equal(local.speculativeHostPresent, true)
      assert.equal(local.toolExecutorsPresent, true)
      assert.equal(local.originalContextLocalStatePresent, true)
      assert.deepEqual(
        raw.context.tools.map((tool) => tool.name).sort(),
        [
          'read',
          'write',
          'edit',
          'bash',
          ...Array.from({ length: 20 }, (_, i) => `wire_cli_host_${i}`)
        ].sort()
      )
      for (const tool of raw.context.tools)
        assert.ok(
          Object.keys(tool).every((key) => NATIVE_TOOL_WIRE_KEYS.includes(key)),
          JSON.stringify({ tool: tool.name, keys: Object.keys(tool) })
        )
      assert.deepEqual(
        raw.context.tools,
        local.tools,
        'Provider schemas and every formal Tool field must match the actual original SDK Context'
      )
      assert.deepEqual(raw.context.messages, local.messages)
      assert.ok(
        Object.keys(raw.options).every((key) =>
          (NATIVE_OPTION_WIRE_KEYS as readonly string[]).includes(key)
        )
      )
      for (const marker of [
        'synthetic-wire-speculative-host-marker',
        'synthetic-wire-tool-capability-marker',
        'synthetic-wire-settings-marker',
        'synthetic-wire-gateway-bearer'
      ])
        assert.equal(JSON.stringify(raw).includes(marker), false)
      assert.equal(shapes[index].gatewayAccepted, true)
    }
    assert.ok(JSON.stringify(wire[1].context.messages).includes('wire DTO answer'))
    assert.equal(fixture.stderr(), '')
    await fixture.close()
  }
)
