import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createConnection, type AddressInfo } from 'node:net'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  ModelGatewayLease,
  ModelGatewayModelRef
} from '../src/main/agent/engine/model-gateway-types'
import {
  startModelGatewaySdkFixture,
  MODEL_GATEWAY_FIXTURE_REFS as refs,
  MODEL_GATEWAY_FIXTURE_SECRETS as secrets
} from './helpers/model-gateway-sdk-fixture'

function body(
  ref: ModelGatewayModelRef,
  options: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    modelId: `${ref.provider}/${ref.id}`,
    context: {
      messages: [
        { role: 'user', content: `${secrets.context} private fixture conversation`, timestamp: 1 }
      ]
    },
    options,
    stream: true
  }
}
async function request(
  lease: ModelGatewayLease,
  payload: unknown,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`http://127.0.0.1:${lease.localPort}/v1/pi/stream`, {
    method: 'POST',
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${lease.bearerToken}`,
      ...init.headers
    },
    body: JSON.stringify(payload)
  })
}
function events(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
}
function noSecrets(value: string, lease: ModelGatewayLease): void {
  for (const secret of [...Object.values(secrets), lease.bearerToken, 'fixture-oauth-access-'])
    assert.equal(
      value.includes(secret),
      false,
      'Native output must not expose gateway/provider credentials'
    )
}

// Each child uses the actual SDK and private credential database. Tests are serial.
test(
  'actual SDK native API-key/auth:none/OAuth preserve thinking, tools and the next-turn history',
  { timeout: 30000 },
  async (t) => {
    const f = await startModelGatewaySdkFixture({ debug: true })
    t.after(() => f.close())
    const lease = await f.create({
      sessionId: 'sdk-basic',
      generation: 1,
      models: [refs.key, refs.none, refs.oauth]
    })
    await f.enqueue({ text: '中文答案', thinking: 'native reasoning' })
    const response = await request(lease, body(refs.key, { reasoning: 'high' }))
    assert.equal(response.status, 200)
    assert.equal(response.headers.has('x-litellm-model-api-base'), false)
    const text = await response.text()
    assert.match(text, /中文答案/)
    assert.ok(events(text).some((event) => event.type === 'thinking_delta'))
    noSecrets(text + JSON.stringify([...response.headers]), lease)
    await f.enqueue({ text: 'keyless native result' })
    assert.match(await (await request(lease, body(refs.none))).text(), /keyless native result/)
    await f.enqueue({
      tool: { name: 'inspect', id: 'native-call', args: { path: 'ordinary.txt' } }
    })
    const toolBody = {
      ...body(refs.key, { toolChoice: { type: 'function', function: { name: 'inspect' } } }),
      context: {
        messages: [{ role: 'user', content: 'inspect', timestamp: 1 }],
        tools: [
          {
            name: 'inspect',
            description: 'Inspect ordinary data',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path']
            }
          }
        ]
      }
    }
    const tool = events(await (await request(lease, toolBody)).text())
    assert.ok(tool.some((event) => event.type === 'toolcall_end'))
    const assistant = tool.find((event) => event.type === 'done')?.message
    assert.ok(assistant)
    await f.enqueue({ text: 'history retained' })
    const next = {
      ...body(refs.key),
      context: {
        messages: [
          toolBody.context.messages[0],
          assistant,
          {
            role: 'toolResult',
            toolCallId: 'native-call',
            toolName: 'inspect',
            content: [{ type: 'text', text: 'ORIGINAL_TOOL_RESULT' }],
            isError: false,
            timestamp: 2
          }
        ]
      }
    }
    assert.match(await (await request(lease, next)).text(), /history retained/)
    await f.enqueue({ text: 'OAuth naturally refreshed' })
    assert.match(await (await request(lease, body(refs.oauth))).text(), /OAuth naturally refreshed/)
    const snapshot = await f.snapshot()
    assert.equal(snapshot.refreshCalls, 1)
    assert.equal(snapshot.debugEnabled, false)
    assert.deepEqual(snapshot.rawLogFiles, [])
    assert.equal(f.stderr(), '')
    assert.ok(JSON.stringify(snapshot.providerRequests).includes('ORIGINAL_TOOL_RESULT'))
    assert.ok(
      snapshot.providerRequests.some(
        (entry) => entry.headers.authorization === `Bearer ${secrets.key}`
      )
    )
  }
)

test(
  'actual SDK command-backed key is resolved only after authenticated model admission',
  { timeout: 30000 },
  async (t) => {
    const f = await startModelGatewaySdkFixture({ debug: true })
    t.after(() => f.close())
    const lease = await f.create({
      sessionId: 'command-key',
      generation: 1,
      models: [refs.command]
    })
    assert.equal(
      (await f.snapshot()).commandCalls,
      0,
      'Model listing must not execute a key command'
    )
    assert.equal(
      (await request(lease, body(refs.command), { headers: { authorization: 'Bearer invalid' } }))
        .status,
      401
    )
    assert.equal((await f.snapshot()).commandCalls, 0)
    await f.enqueue({ text: 'command key preserved' })
    const output = await (await request(lease, body(refs.command))).text()
    assert.match(output, /command key preserved/)
    noSecrets(output, lease)
    const snapshot = await f.snapshot()
    assert.equal(snapshot.commandCalls, 1)
    assert.equal(snapshot.providerRequests[0]?.headers.authorization, `Bearer ${secrets.command}`)
    assert.deepEqual(snapshot.rawLogFiles, [])
    assert.equal(f.stderr(), '')
  }
)

test(
  'actual SDK gate rejects bad/cross/revoked access and invalid routing before any auth resolution',
  { timeout: 30000 },
  async (t) => {
    const f = await startModelGatewaySdkFixture()
    t.after(() => f.close())
    const a = await f.create({ sessionId: 'isolation-a', generation: 1, models: [refs.key] })
    const b = await f.create({ sessionId: 'isolation-b', generation: 1, models: [refs.none] })
    assert.notEqual(a.localPort, b.localPort)
    assert.notEqual(a.bearerToken, b.bearerToken)
    await f.resetStats()
    const unauthorized = createConnection(a.localPort, '127.0.0.1')
    try {
      await new Promise<void>((resolve, reject) => {
        unauthorized.once('connect', resolve)
        unauthorized.once('error', reject)
      })
      const head = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Admission waited for an unauthenticated body')),
          500
        )
        unauthorized.once('data', (bytes: Buffer) => {
          clearTimeout(timeout)
          resolve(bytes.toString())
        })
      })
      unauthorized.write(
        'POST /v1/pi/stream HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 67108864\r\n\r\n'
      )
      assert.match(await head, /HTTP\/1.1 401/)
    } finally {
      unauthorized.destroy()
    }
    for (const authorization of ['', 'Bearer wrong', `Bearer ${b.bearerToken}`]) {
      const response = await request(a, body(refs.key), { headers: { authorization } })
      assert.equal(response.status, 401)
      noSecrets(await response.text(), a)
    }
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${a.localPort}/v1/models`, {
          headers: { authorization: `Bearer ${a.bearerToken}` }
        })
      ).status,
      404
    )
    for (const invalid of [
      { ...body(refs.key), model: { baseUrl: 'http://alternate.invalid' } },
      body(refs.key, { apiKey: secrets.replacement }),
      body({ provider: 'unapproved', id: 'arbitrary' })
    ])
      assert.equal((await request(a, invalid)).status, 400)
    const rejected = await f.snapshot()
    assert.equal(rejected.authCalls, 0)
    assert.equal(rejected.registryCalls, 0)
    assert.equal(rejected.providerRequests.length, 0)
    await f.revoke(a.leaseId)
    await assert.rejects(request(a, body(refs.key)))
    const newer = await f.create({ sessionId: 'isolation-a', generation: 2, models: [refs.key] })
    assert.notEqual(newer.bearerToken, a.bearerToken)
    // The OS may reuse the retired listener's port; its old bearer still fails.
    const retired = await request(a, body(refs.key)).catch(() => undefined)
    if (retired) assert.equal(retired.status, 401)
    await f.enqueue({ text: 'other session still works' })
    assert.match(await (await request(b, body(refs.none))).text(), /other session still works/)
    await assert.rejects(
      f.create({ sessionId: 'isolation-a', generation: 1, models: [refs.key] }),
      /generation.*fresh/
    )
  }
)

test(
  'actual SDK a new generation revokes an active native stream before publishing fresh access',
  { timeout: 30000 },
  async (t) => {
    const f = await startModelGatewaySdkFixture()
    t.after(() => f.close())
    const old = await f.create({ sessionId: 'active-reconnect', generation: 1, models: [refs.key] })
    await f.enqueue({ hold: true, text: 'partial old generation' })
    const response = await request(old, body(refs.key))
    const reader = response.body!.getReader()
    await reader.read()
    const fresh = await f.create({
      sessionId: 'active-reconnect',
      generation: 2,
      models: [refs.key]
    })
    assert.notEqual(fresh.leaseId, old.leaseId)
    assert.notEqual(fresh.bearerToken, old.bearerToken)
    const deadline = Date.now() + 500
    let snapshot = await f.snapshot()
    while (snapshot.activeProviderStreams && Date.now() < deadline) {
      await delay(10)
      snapshot = await f.snapshot()
    }
    assert.equal(snapshot.activeProviderStreams, 0)
    assert.equal(snapshot.gateway.activeRequests, 0)
    await reader.cancel().catch(() => undefined)
    const revoked = await request(old, body(refs.key)).catch(() => undefined)
    if (revoked) assert.equal(revoked.status, 401)
    await f.enqueue({ text: 'fresh generation only' })
    assert.match(await (await request(fresh, body(refs.key))).text(), /fresh generation only/)
    assert.equal(
      (await f.snapshot()).providerRequests.length,
      2,
      'The interrupted prompt must not replay'
    )
    assert.equal(f.stderr(), '')
  }
)

test(
  'actual SDK HTTPS with a private CA preserves large Unicode assistant history on the next request',
  { timeout: 30000 },
  async (t) => {
    const f = await startModelGatewaySdkFixture({ https: true, debug: true })
    t.after(() => f.close())
    const lease = await f.create({
      sessionId: 'https-large-history',
      generation: 1,
      models: [refs.key]
    })
    const large = Array.from(
      { length: 36000 },
      (_, index) => `${index.toString(36)}: 中文历史 ${index} αβγ🙂\n`
    ).join('')
    assert.ok(Buffer.byteLength(large) > 1024 * 1024)
    await f.enqueue({ text: large, textChunkChars: 262144 })
    const response = await request(lease, body(refs.key))
    assert.equal(response.status, 200)
    const completed = events(await response.text()).find((event) => event.type === 'done')
    assert.ok(completed)
    const assistant = completed.message as { content: Array<{ type: string; text?: string }> }
    const returned = assistant.content.find((block) => block.type === 'text')?.text ?? ''
    assert.ok(returned === large, 'The complete Unicode model output must remain unchanged')
    await f.enqueue({ text: 'HTTPS history retained' })
    const next = {
      ...body(refs.key),
      context: {
        messages: [
          { role: 'user', content: 'Create fixture history', timestamp: 1 },
          completed.message,
          { role: 'user', content: 'Continue after the long history', timestamp: 2 }
        ]
      }
    }
    assert.match(await (await request(lease, next)).text(), /HTTPS history retained/)
    const snapshot = await f.snapshot()
    const history = snapshot.providerRequests.at(-1)?.body.messages
    assert.ok(Array.isArray(history))
    const sent = history.find((message) => message.role === 'assistant')?.content
    assert.ok(sent === large, 'The next provider request must retain the complete Unicode history')
    assert.equal(snapshot.providerRequests.length, 2)
    assert.deepEqual(snapshot.rawLogFiles, [])
    assert.equal(f.stderr(), '')
  }
)

test(
  'actual SDK OAuth 401 recovery and credential rotation retain the registry auth policy',
  { timeout: 30000 },
  async (t) => {
    const f = await startModelGatewaySdkFixture({ oauthExpired: false })
    t.after(() => f.close())
    const lease = await f.create({
      sessionId: 'auth-recovery',
      generation: 1,
      models: [refs.oauth, refs.rotate]
    })
    await f.enqueue({ status: 401, error: secrets.error }, { text: 'OAuth recovered' })
    const oauth = await (await request(lease, body(refs.oauth))).text()
    assert.match(oauth, /OAuth recovered/)
    noSecrets(oauth, lease)
    let snapshot = await f.snapshot()
    assert.equal(snapshot.refreshCalls, 1)
    assert.equal(snapshot.providerRequests.length, 2)
    assert.notEqual(
      snapshot.providerRequests[0].headers.authorization,
      snapshot.providerRequests[1].headers.authorization
    )
    assert.ok(
      snapshot.authScopes.some(
        (scope) =>
          scope.forceRefresh &&
          scope.refreshReason === 'auth-recovery' &&
          scope.sessionId === lease.leaseId &&
          scope.modelId === refs.oauth.id
      )
    )
    await f.resetStats()
    await f.enqueue({ status: 401, error: secrets.error }, { text: 'credential rotated' })
    assert.match(await (await request(lease, body(refs.rotate))).text(), /credential rotated/)
    snapshot = await f.snapshot()
    assert.equal(snapshot.invalidationCalls, 1)
    assert.equal(snapshot.providerRequests.length, 2)
    assert.notEqual(
      snapshot.providerRequests[0].headers.authorization,
      snapshot.providerRequests[1].headers.authorization
    )
  }
)

test(
  'actual SDK concurrent models bind trusted baseURL/model/session and live replaceStore credentials',
  { timeout: 30000 },
  async (t) => {
    const f = await startModelGatewaySdkFixture()
    t.after(() => f.close())
    const lease = await f.create({
      sessionId: 'concurrent-scopes',
      generation: 1,
      models: [refs.scopeA, refs.scopeB, refs.key]
    })
    await f.resetStats()
    const [a, b] = await Promise.all([
      request(
        lease,
        body(refs.scopeA, {
          sessionId: 'forged',
          promptCacheKey: 'forged',
          headers: { authorization: 'forged', cookie: 'forged' }
        })
      ),
      request(lease, body(refs.scopeB))
    ])
    await Promise.all([a.text(), b.text()])
    const snapshot = await f.snapshot()
    assert.equal(snapshot.authScopes.length, 2)
    for (const ref of [refs.scopeA, refs.scopeB]) {
      const scope = snapshot.authScopes.find((entry) => entry.modelId === ref.id)
      assert.ok(scope)
      assert.equal(scope.sessionId, lease.leaseId)
      assert.ok(scope.baseUrl?.endsWith(`/${ref.id}/v1`))
      const upstream = snapshot.providerRequests.find((entry) => entry.body.model === ref.id)
      assert.ok(upstream)
      assert.equal(upstream.path, `/${ref.id}/v1/chat/completions`)
      assert.equal(upstream.headers.authorization, `Bearer ${secrets.scope}`)
      assert.equal(upstream.headers.cookie, undefined)
    }
    await f.replaceStore()
    await f.enqueue({ text: 'new store seen' })
    assert.match(await (await request(lease, body(refs.key))).text(), /new store seen/)
    assert.equal(
      (await f.snapshot()).providerRequests.at(-1)?.headers.authorization,
      `Bearer ${secrets.replacement}`
    )
  }
)

test(
  'actual SDK cancellation releases provider work and allows reuse without raw error/debug leaks',
  { timeout: 30000 },
  async (t) => {
    const f = await startModelGatewaySdkFixture({ debug: true })
    t.after(() => f.close())
    const lease = await f.create({ sessionId: 'cancel-reuse', generation: 1, models: [refs.key] })
    const other = await f.create({
      sessionId: 'cancel-independent',
      generation: 1,
      models: [refs.none]
    })
    await f.enqueue({ hold: true, text: 'first bytes' })
    const controller = new AbortController()
    const response = await request(lease, body(refs.key), { signal: controller.signal })
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()
    await reader.cancel().catch(() => undefined)
    const deadline = Date.now() + 500
    while ((await f.snapshot()).activeProviderStreams && Date.now() < deadline) await delay(10)
    const canceled = await f.snapshot()
    assert.equal(canceled.activeProviderStreams, 0)
    assert.equal(canceled.gateway.activeRequests, 0)
    assert.ok(
      canceled.authSignalAborts > 0,
      'Cancellation must reach the actual SDK credential request scope'
    )
    await f.enqueue({ text: 'other lease survived cancellation' })
    assert.match(
      await (await request(other, body(refs.none))).text(),
      /other lease survived cancellation/
    )
    await f.enqueue({ text: 'reused after abort' })
    assert.match(await (await request(lease, body(refs.key))).text(), /reused after abort/)
    const snapshot = await f.snapshot()
    assert.equal(snapshot.debugEnabled, false)
    assert.deepEqual(snapshot.rawLogFiles, [])
    assert.equal(f.stderr(), '')
  }
)

test(
  'actual SDK provider error echoes are replaced without raw debug logs',
  { timeout: 30000 },
  async (t) => {
    const f = await startModelGatewaySdkFixture({ debug: true })
    t.after(() => f.close())
    const lease = await f.create({ sessionId: 'error-privacy', generation: 1, models: [refs.key] })
    // Non-retryable400 keeps the oracle independent of SDK transient retry count.
    await f.enqueue({ status: 400, error: `${secrets.error} ${secrets.key}` })
    const response = await request(lease, body(refs.key, { maxRetryDelayMs: 0 }))
    const error = await response.text()
    assert.ok(
      events(error).some((event) => event.type === 'error'),
      error
    )
    noSecrets(error + JSON.stringify([...response.headers]), lease)
    const snapshot = await f.snapshot()
    assert.equal(snapshot.debugEnabled, false)
    assert.deepEqual(snapshot.rawLogFiles, [])
    assert.deepEqual(snapshot.logSentinels, {
      credential: false,
      gatewayBearer: false,
      context: false
    })
    assert.equal(f.stderr(), '')
  }
)

test(
  'actual SDK same-origin redirects retain trusted auth while cross-origin redirects never send it',
  { timeout: 30000 },
  async (t) => {
    const f = await startModelGatewaySdkFixture()
    t.after(() => f.close())
    const lease = await f.create({ sessionId: 'redirects', generation: 1, models: [refs.key] })
    await f.enqueue({ redirect: '/key/v1/chat/completions' }, { text: 'same origin accepted' })
    assert.match(await (await request(lease, body(refs.key))).text(), /same origin accepted/)
    let foreignRequests = 0
    const foreign = createServer((_request, response) => {
      foreignRequests++
      response.end('must never be reached')
    })
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve))
    t.after(
      () =>
        new Promise<void>((resolve) => {
          foreign.closeAllConnections()
          foreign.close(() => resolve())
        })
    )
    const destination = `http://127.0.0.1:${(foreign.address() as AddressInfo).port}/must-not-receive-credentials`
    await f.enqueue({ redirect: destination }, { redirect: destination }, { redirect: destination })
    const result = await (await request(lease, body(refs.key, { maxRetryDelayMs: 0 }))).text()
    noSecrets(result, lease)
    assert.equal(foreignRequests, 0)
  }
)

test(
  'actual SDK slow consumer overflow aborts physical upstream work without killing either lease',
  { timeout: 30000 },
  async (t) => {
    const f = await startModelGatewaySdkFixture({
      streamLimits: { maxEventBytes: 64 * 1024 * 1024, maxQueuedBytes: 8192, maxQueuedEvents: 8 }
    })
    t.after(() => f.close())
    const lease = await f.create({ sessionId: 'overflow-owner', generation: 1, models: [refs.key] })
    const other = await f.create({
      sessionId: 'overflow-other',
      generation: 1,
      models: [refs.none]
    })
    await f.enqueue({
      hold: true,
      text: Array.from({ length: 65536 }, (_, index) => `${index}:bounded stream\n`).join(''),
      textChunkChars: 8192
    })
    const socket = createConnection(lease.localPort, '127.0.0.1')
    t.after(() => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    // Stop at the physical socket, rather than fetch's prefetching body queue.
    socket.pause()
    const content = JSON.stringify(body(refs.key))
    socket.write(
      `POST /v1/pi/stream HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${lease.bearerToken}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`
    )
    const admittedDeadline = Date.now() + 2000
    let snapshot = await f.snapshot()
    while (!snapshot.providerRequests.length && Date.now() < admittedDeadline) {
      await delay(10)
      snapshot = await f.snapshot()
    }
    assert.ok(snapshot.providerRequests.length > 0, 'The real SDK must reach the private provider')
    const deadline = Date.now() + 500
    while (
      (snapshot.activeProviderStreams || snapshot.gateway.activeRequests) &&
      Date.now() < deadline
    ) {
      await delay(10)
      snapshot = await f.snapshot()
    }
    assert.equal(snapshot.activeProviderStreams, 0)
    assert.equal(snapshot.gateway.activeRequests, 0)
    assert.ok(snapshot.authSignalAborts > 0)
    socket.destroy()
    await f.enqueue({ text: 'ok' })
    const output = await (await request(other, body(refs.none))).text()
    assert.match(output, /ok/)
    assert.equal(f.stderr(), '')
  }
)

test(
  'actual SDK post-emission errors retain legitimate partial text, thinking and tool history',
  { timeout: 30000 },
  async (t) => {
    const f = await startModelGatewaySdkFixture({ debug: true })
    t.after(() => f.close())
    const lease = await f.create({
      sessionId: 'partial-error-history',
      generation: 1,
      models: [refs.key]
    })
    await f.enqueue({
      text: 'VISIBLE_PARTIAL_TEXT',
      thinking: 'VISIBLE_PARTIAL_THINKING',
      tool: { name: 'inspect', id: 'partial-call', args: { path: 'ordinary.txt' } },
      finishReason: `${secrets.error} ${secrets.key}`
    })
    const initial = body(refs.key)
    initial.context = {
      messages: [{ role: 'user', content: 'Inspect ordinary data', timestamp: 1 }],
      tools: [
        {
          name: 'inspect',
          description: 'Inspect ordinary data',
          parameters: { type: 'object', properties: { path: { type: 'string' } } }
        }
      ]
    }
    const raw = await (await request(lease, initial)).text()
    const terminal = events(raw).find((event) => event.type === 'error')
    assert.ok(terminal)
    const partial = terminal.error as { content: Array<Record<string, unknown>> }
    assert.ok(
      partial.content.some(
        (block) => block.type === 'text' && block.text === 'VISIBLE_PARTIAL_TEXT'
      )
    )
    assert.ok(
      partial.content.some(
        (block) => block.type === 'thinking' && block.thinking === 'VISIBLE_PARTIAL_THINKING'
      )
    )
    assert.ok(
      partial.content.some((block) => block.type === 'toolCall' && block.id === 'partial-call')
    )
    noSecrets(raw, lease)
    assert.equal(
      (await f.snapshot()).providerRequests.length,
      1,
      'Visible output must prevent a replay'
    )
    await f.enqueue({ text: 'next turn after partial failure' })
    const next = {
      ...body(refs.key),
      context: {
        messages: [
          { role: 'user', content: 'Inspect ordinary data', timestamp: 1 },
          terminal.error,
          {
            role: 'toolResult',
            toolName: 'inspect',
            toolCallId: 'partial-call',
            timestamp: 2,
            isError: true,
            content: [{ type: 'text', text: 'Tool was not executed' }]
          },
          { role: 'user', content: 'continue', timestamp: 3 }
        ]
      }
    }
    assert.match(await (await request(lease, next)).text(), /next turn after partial failure/)
  }
)
