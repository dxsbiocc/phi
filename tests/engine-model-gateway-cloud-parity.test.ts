import assert from 'node:assert/strict'
import test from 'node:test'
import { access } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { startCloudFixture, type CloudMessage } from './helpers/model-gateway-cloud-fixture'
import {
  CLOUD_REFS as refs,
  CLOUD_SECRETS as secrets,
  verifyFixtureAwsSignature,
  type CloudCategory
} from './helpers/model-gateway-cloud-provider'
const tools = [
  {
    name: 'inspect',
    description: 'Read a private ordinary test text file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
]
const context = (): {
  messages: Array<{ role: string; content: string; timestamp: number }>
  tools: typeof tools
} => ({
  messages: [{ role: 'user', content: 'private ordinary question', timestamp: 1 }],
  tools
})
function semantic(
  message: CloudMessage
): Pick<CloudMessage, 'content' | 'stopReason' | 'provider' | 'model'> {
  return {
    content: message.content,
    stopReason: message.stopReason,
    provider: message.provider,
    model: message.model
  }
}
function vendorBody(
  value: Record<string, unknown>,
  category: CloudCategory
): Record<string, unknown> {
  const result = structuredClone(value)
  if (category === 'antigravity') {
    delete result.requestId
    if (result.request && typeof result.request === 'object') {
      const request = result.request as Record<string, unknown>
      delete request.sessionId
      if (request.labels && typeof request.labels === 'object')
        delete (request.labels as Record<string, unknown>).trajectory_id
    }
  }
  return result
}
function noSecrets(value: unknown): void {
  const text = JSON.stringify(value) ?? ''
  for (const secret of Object.values(secrets))
    assert.equal(
      text.includes(secret),
      false,
      `Cloud secret reached remote message/config/log: ${secret}`
    )
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 2000
  while (!(await predicate())) {
    if (Date.now() > end) assert.fail('Private cloud cleanup did not complete')
    await delay(10)
  }
}
for (const category of [
  'google',
  'gemini',
  'antigravity',
  'bedrock',
  'vertex',
  'registered'
] as const) {
  test(
    `actual ${category} desktop SDK and native gateway preserve signed thinking/tools/history`,
    { timeout: 30000 },
    async (t) => {
      const f = await startCloudFixture()
      t.after(() => f.close())
      const initial = await f.snapshot()
      assert.ok(
        initial.available.some(
          (ref) => ref.provider === refs[category].provider && ref.id === refs[category].id
        )
      )
      f.provider.enqueue({ text: 'cloud 中文 answer' }, { text: 'cloud 中文 answer' })
      // Vertex starts cold on the native route so its ADC exchange cannot be
      // accidentally satisfied only by the earlier desktop comparison.
      const first = await f.turn(category, category === 'vertex', context())
      const second = await f.turn(category, category !== 'vertex', context())
      const direct = category === 'vertex' ? second : first
      const native = category === 'vertex' ? first : second
      assert.equal(direct.message.stopReason, 'stop', direct.message.errorMessage)
      assert.equal(native.message.stopReason, 'stop', native.message.errorMessage)
      assert.deepEqual(semantic(native.message), semantic(direct.message))
      assert.ok(
        native.message.content.some(
          (block) => block.type === 'thinking' && block.thinking === 'private reasoning'
        )
      )
      assert.ok(
        native.message.content.some(
          (block) => block.type === 'text' && block.text === 'cloud 中文 answer'
        )
      )
      noSecrets(native)
      noSecrets((await f.snapshot()).logs)
      f.provider.enqueue({ tool: true }, { tool: true })
      const directTool = await f.turn(category, false, context()),
        nativeTool = await f.turn(category, true, context())
      assert.equal(nativeTool.message.stopReason, 'toolUse', nativeTool.message.errorMessage)
      assert.deepEqual(semantic(nativeTool.message), semantic(directTool.message))
      const call = nativeTool.message.content.find((block) => block.type === 'toolCall')
      assert.ok(call?.id)
      const history = {
        ...context(),
        messages: [
          ...context().messages,
          nativeTool.message,
          {
            role: 'toolResult',
            toolCallId: call.id,
            toolName: 'inspect',
            content: [{ type: 'text', text: 'private ordinary result' }],
            isError: false,
            timestamp: 2
          },
          { role: 'user', content: 'continue', timestamp: 3 }
        ]
      }
      f.provider.enqueue({ text: 'history retained' })
      const next = await f.turn(category, true, history)
      assert.equal(next.message.stopReason, 'stop', next.message.errorMessage)
      assert.ok(next.message.content.some((block) => block.text === 'history retained'))
      const snapshot = await f.snapshot(),
        requests = f.provider.snapshot().requests
      const inference = requests.filter(
        (request) => !request.path.includes('/oauth2.googleapis.com/token')
      )
      assert.deepEqual(
        vendorBody(inference[0].body, category),
        vendorBody(inference[1].body, category),
        'Native hop must preserve actual first vendor request, apart from owned per-session Antigravity identity'
      )
      assert.ok(
        requests.some((request) => JSON.stringify(request.body).includes('private ordinary result'))
      )
      if (category === 'google')
        for (const request of requests)
          assert.equal(request.headers['x-goog-api-key'], secrets.google)
      if (category === 'gemini' || category === 'antigravity')
        for (const request of requests) {
          assert.equal(request.headers.authorization, `Bearer ${secrets[category]}`)
          assert.equal(request.body.project, `private-${category}-project`)
        }
      if (category === 'antigravity') {
        const trajectory = (index: number): unknown =>
          (
            (inference[index].body.request as Record<string, unknown>).labels as Record<
              string,
              unknown
            >
          ).trajectory_id
        assert.match(String(trajectory(1)), /^[a-f0-9-]{36}$/)
        assert.notEqual(
          trajectory(0),
          trajectory(1),
          'Desktop comparison and owned gateway lease have separate trajectories'
        )
        assert.equal(
          trajectory(1),
          trajectory(3),
          'Native tool turn retains its leased provider state'
        )
        assert.equal(
          trajectory(1),
          trajectory(4),
          'Native replay retains its leased provider state'
        )
      }
      if (category === 'bedrock') {
        const mapped = snapshot.mappedRequests.filter((request) =>
          request.url.startsWith('https://bedrock-runtime.')
        )
        assert.equal(mapped.length, 5)
        for (let index = 0; index < requests.length; index++) {
          assert.equal(requests[index].headers['x-amz-security-token'], secrets.awsToken)
          assert.match(
            String(requests[index].headers.authorization),
            /\/us-west-2\/bedrock\/aws4_request/
          )
          assert.ok(
            verifyFixtureAwsSignature(requests[index], mapped[index].url),
            'Actual SDK SigV4 signature must match physical payload'
          )
        }
      }
      if (category === 'vertex') {
        assert.equal(f.provider.snapshot().tokenExchanges, 1)
        const token = requests.find((request) =>
          request.path.includes('/oauth2.googleapis.com/token')
        )
        assert.ok(token)
        assert.deepEqual(token.body, {
          client_id: secrets.adcClient,
          client_secret: secrets.adcSecret,
          refresh_token: secrets.adcRefresh,
          grant_type: 'refresh_token'
        })
        for (const request of requests.filter((request) => !request.path.includes('/oauth2.'))) {
          assert.match(
            request.path,
            /us-central1-aiplatform\.googleapis\.com\/v1\/projects\/private-vertex-project\/locations\/us-central1/
          )
          assert.equal(request.headers.authorization, `Bearer ${secrets.adcAccess}`)
          assert.equal(request.headers['x-goog-api-key'], undefined)
        }
      }
      if (category === 'registered') assert.equal(snapshot.customCalls, 5)
      noSecrets(nativeTool)
      noSecrets(next)
      assert.equal(f.stderr(), '')
      const root = f.root
      await f.close()
      await assert.rejects(access(root))
    }
  )
}
for (const category of [
  'google',
  'gemini',
  'antigravity',
  'bedrock',
  'vertex',
  'registered',
  'cursor'
] as CloudCategory[]) {
  test(
    `actual ${category} native cancel physically ends only its owned cloud request`,
    { timeout: 30000 },
    async (t) => {
      const f = await startCloudFixture()
      t.after(() => f.close())
      f.provider.enqueue({ hold: true })
      const turn = f.turn(category, true, context(), 'cancel-this-turn')
      await until(() => f.provider.snapshot().active === 1)
      await f.abort('cancel-this-turn')
      let result: unknown
      if (category === 'registered') {
        // A custom transport that has not produced its first event has no
        // response body yet; official pi-native rejects that abort directly.
        await assert.rejects(turn, /AbortError/)
      } else {
        try {
          result = await turn
          assert.equal((result as { message: CloudMessage }).message.stopReason, 'aborted')
        } catch (error) {
          assert.match(String(error), /AbortError: The operation was aborted/)
        }
      }
      await until(() => f.provider.snapshot().active === 0)
      assert.equal(f.provider.snapshot().cancellations, 1)
      await until(async () => (await f.snapshot()).gateway.activeRequests === 0)
      f.provider.enqueue({ text: 'after cancel' })
      const next = await f.turn(category, true, context())
      assert.equal(next.message.stopReason, 'stop', next.message.errorMessage)
      assert.ok(next.message.content.some((block) => block.text === 'after cancel'))
      if (category === 'cursor')
        assert.ok(
          f.hostBridgeCalls() === 1,
          'Production modelBySelector must acquire the real host bridge'
        )
      noSecrets(result)
      noSecrets(next)
      assert.equal(f.stderr(), '')
    }
  )
}
test(
  'actual Cursor native text/thinking flows through the desktop H2 bridge and independent protobuf oracle',
  { timeout: 30000 },
  async (t) => {
    const f = await startCloudFixture()
    t.after(() => f.close())
    f.provider.enqueue({ text: 'cursor 中文 answer' }, { text: 'cursor 中文 answer' })
    const direct = await f.turn('cursor', false, context()),
      native = await f.turn('cursor', true, context())
    assert.equal(direct.message.stopReason, 'stop', direct.message.errorMessage)
    assert.equal(native.message.stopReason, 'stop', native.message.errorMessage)
    assert.deepEqual(semantic(native.message), semantic(direct.message))
    assert.ok(native.message.content.some((block) => block.text === 'cursor 中文 answer'))
    assert.ok(native.message.content.some((block) => block.thinking === 'private reasoning'))
    const requests = f.provider.snapshot().requests
    assert.equal(requests.length, 2)
    for (const request of requests) {
      assert.equal(request.path, '/agent.v1.AgentService/Run')
      assert.equal(request.headers.authorization, `Bearer ${secrets.cursor}`)
      assert.ok(
        Buffer.from(String(request.body.requestContextBase64), 'base64').includes(
          Buffer.from('inspect')
        )
      )
    }
    assert.ok(f.hostBridgeCalls() === 2)
    noSecrets(native)
    assert.equal(f.stderr(), '')
  }
)

test(
  'actual Cursor MCP exec handshake hands an unresolved tool call through native transport without desktop execution',
  { timeout: 30000 },
  async (t) => {
    const f = await startCloudFixture()
    t.after(() => f.close())
    f.provider.enqueue({ tool: true }, { tool: true })
    const direct = await f.turn('cursor', false, context()),
      native = await f.turn('cursor', true, context())
    assert.deepEqual(semantic(native.message), semantic(direct.message))
    const call = native.message.content.find((block) => block.type === 'toolCall')
    assert.ok(call)
    assert.deepEqual(
      { id: call.id, name: call.name, arguments: call.arguments },
      { id: 'cloud-call', name: 'inspect', arguments: { path: 'ordinary.txt' } }
    )
    assert.ok(native.events.some((event) => event.type === 'toolcall_end'))
    assert.equal(
      native.events.some((event) => String(event.type).startsWith('tool_result')),
      false
    )
    const requests = f.provider.snapshot().requests
    assert.equal(requests.length, 2)
    for (const request of requests) {
      assert.ok(
        Buffer.from(String(request.body.requestContextBase64), 'base64').includes(
          Buffer.from('inspect')
        )
      )
      const result = Buffer.from(String(request.body.mcpResultBase64), 'base64').toString('utf8')
      assert.match(result, /external|client/i)
      assert.doesNotMatch(result, /not found|not available/i)
    }
    // Locked Cursor's turnEnded maps to stop even when its unresolved tool block
    // asks an external executor to run it. Preserve actual desktop SDK behavior.
    assert.equal(native.message.stopReason, 'stop')
    noSecrets(native)
    assert.equal(f.stderr(), '')
  }
)
