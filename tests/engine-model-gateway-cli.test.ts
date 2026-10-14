import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import {
  startModelGatewaySdkFixture,
  MODEL_GATEWAY_FIXTURE_REFS as refs,
  MODEL_GATEWAY_FIXTURE_SECRETS as secrets
} from './helpers/model-gateway-sdk-fixture'
import { createModelGatewayCliFixture } from './helpers/model-gateway-cli-fixture'

function messageText(messages: Array<Record<string, unknown>>): string {
  return messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('')
}

test(
  'actual CLI first native prompt and future model selection cross the private gateway with real SDK auth',
  { timeout: 60000 },
  async (t) => {
    const f = await startModelGatewaySdkFixture({ debug: true, oauthExpired: false })
    t.after(() => f.close())
    const lease = await f.create({
      sessionId: 'actual-cli-native',
      generation: 1,
      models: [refs.key, refs.none, refs.oauth]
    })
    const cli = await createModelGatewayCliFixture(lease)
    t.after(() => cli.close())
    assert.equal(
      (await f.snapshot()).providerRequests.length,
      0,
      'Attestation/selection must not invoke a model'
    )
    for (const [ref, label] of [
      [refs.key, 'actual CLI key result'],
      [refs.none, 'actual CLI keyless result'],
      [refs.oauth, 'actual CLI OAuth result']
    ] as const) {
      await cli.select(ref)
      const state = await cli.connection.request<{
        model: {
          provider: string
          id: string
          contextWindow: number | null
          maxTokens: number | null
        }
      }>({ type: 'get_state' })
      assert.equal(state.model.provider, ref.provider)
      assert.equal(state.model.id, ref.id)
      assert.equal(
        state.model.contextWindow,
        lease.models.find((model) => model.provider === ref.provider && model.id === ref.id)
          ?.contextWindow
      )
      await f.enqueue({ text: label })
      const result = await cli.connection.prompt(`Answer fixture scenario ${label}`)
      assert.equal(
        result.status,
        'completed',
        JSON.stringify({
          resultStatus: result.status,
          error: result.error,
          wireShape: await cli.audit()
        })
      )
      assert.equal(result.agentInvoked, true)
      const history = await cli.connection.request<{ messages: Array<Record<string, unknown>> }>({
        type: 'get_messages'
      })
      assert.ok(messageText(history.messages).includes(label))
    }
    const snapshot = await f.snapshot()
    assert.equal(snapshot.providerRequests.length, 3)
    assert.ok(
      snapshot.providerRequests.some(
        (request) => request.headers.authorization === `Bearer ${secrets.key}`
      )
    )
    assert.equal(snapshot.debugEnabled, false)
    assert.deepEqual(snapshot.rawLogFiles, [])
    assert.equal(cli.stderr(), '')
    assert.equal(f.stderr(), '')
  }
)

test(
  'worker startup privacy policy preserves Phi structured local request diagnostics',
  { timeout: 30000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-gateway-local-diagnostics-')))
    for (const path of [join(root, 'home'), join(root, 'agent'), join(root, 'tmp')])
      await mkdir(path, { mode: 0o700 })
    const child = spawn(
      resolveBunExecutable(),
      [fileURLToPath(new URL('../src/main/agent/engine/in-process/main.ts', import.meta.url))],
      {
        cwd: root,
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: join(root, 'home'),
          PI_CODING_AGENT_DIR: join(root, 'agent'),
          TMPDIR: join(root, 'tmp'),
          PI_REQ_DEBUG: '1'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    let stderr = ''
    child.stderr.on('data', (bytes: Buffer) => {
      stderr += bytes.toString()
    })
    const lines = createInterface({ input: child.stdout })
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve))
    const deadline = setTimeout(() => child.kill('SIGKILL'), 10000)
    try {
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        child.once('error', reject)
        lines.once('line', (line) => {
          try {
            resolve(JSON.parse(line) as Record<string, unknown>)
          } catch (error) {
            reject(error)
          }
        })
      })
      child.stdin.write(
        JSON.stringify({ id: 'local-diagnostic-id', method: 'fixture.unknown-local-method' }) + '\n'
      )
      const result = await response
      assert.equal(result.id, 'local-diagnostic-id')
      assert.equal(result.ok, false)
      assert.equal(result.error, 'Unknown OMP worker method: fixture.unknown-local-method')
      assert.equal(typeof result.stack, 'string')
      child.stdin.end()
      assert.equal(await closed, 0)
      assert.equal(stderr, '')
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed
      lines.close()
      await rm(root, { recursive: true, force: true })
    }
  }
)
