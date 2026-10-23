import assert from 'node:assert/strict'
import test from 'node:test'
import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'
import { validateGatewayPayload } from '../src/main/agent/engine/in-process/model-gateway-request'

test(
  'production composed runtime creates and restores the same durable Phi/OMP journal with zero replay',
  { timeout: 90_000 },
  async (t) => {
    const f = await runtimeCompositionFixture()
    t.after(() => f.close())
    const first = await f.create()
    assert.equal(first.isReady, true)
    assert.equal((await f.sdk.snapshot()).providerRequests.length, 0)
    const initial = first.currentSnapshot()
    assert.equal(initial.reference.phiSessionId, f.f.scope.phiSessionId)
    await f.sdk.enqueue({ text: 'first composition reply' })
    const turn = await first.prompt('phi-composition-run-1', 'first composition message')
    const shapes = f.wire.map((raw) => {
      let nodes = 0,
        depth = 0
      const queue: Array<[unknown, number]> = [[raw, 0]]
      while (queue.length) {
        const [value, d] = queue.pop()!
        nodes++
        depth = Math.max(depth, d)
        if (value && typeof value === 'object')
          for (const child of Object.values(value)) queue.push([child, d + 1])
      }
      let strict = true
      try {
        validateGatewayPayload(raw, 'private-test')
      } catch {
        strict = false
      }
      return { bytes: Buffer.byteLength(JSON.stringify(raw)), nodes, depth, strict }
    })
    assert.equal(turn.result.status, 'completed', JSON.stringify({ result: turn.result, shapes }))
    assert.ok(JSON.stringify(turn.snapshot.messages).includes('first composition reply'))
    const homes = await readdir(join(f.f.runtimeRoot, 'rpc-sessions'))
    const privateConfig = JSON.parse(
      await readFile(join(f.f.runtimeRoot, 'rpc-sessions', homes[0], 'runtime.json'), 'utf8')
    )
    assert.notEqual(privateConfig.execution.capability, privateConfig.result.capability)
    assert.notEqual(privateConfig.execution.capability, privateConfig.nonce)
    await first.close()
    await assert.rejects(access(join(f.f.runtimeRoot, 'rpc-sessions', homes[0])))
    await access(initial.checkpoint.journalPath)
    const journalBeforeRestore = (await readFile(initial.checkpoint.journalPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const count = (await f.sdk.snapshot()).providerRequests.length
    const second = await f.create({
      action: { type: 'resume', reference: turn.snapshot.reference, savedModel: f.ref },
      initialSelection: {
        model: f.defaults.params.model!,
        thinkingLevel: 'high',
        assertCurrent: () => undefined,
        signal: new AbortController().signal
      }
    })
    assert.equal(second.currentSnapshot().reference.ompSessionId, initial.reference.ompSessionId)
    assert.equal(second.currentSnapshot().checkpoint.journalPath, initial.checkpoint.journalPath)
    assert.equal(second.currentSnapshot().modelPolicy, 'maintained')
    assert.equal((await f.sdk.snapshot()).providerRequests.length, count)
    const appendedOnRestore = (await readFile(initial.checkpoint.journalPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .slice(journalBeforeRestore.length)
    assert.deepEqual(
      appendedOnRestore.filter((entry) => entry.type === 'model_change'),
      []
    )
    const nextHomes = await readdir(join(f.f.runtimeRoot, 'rpc-sessions'))
    const nextConfig = JSON.parse(
      await readFile(join(f.f.runtimeRoot, 'rpc-sessions', nextHomes[0], 'runtime.json'), 'utf8')
    )
    assert.notEqual(nextConfig.execution.capability, privateConfig.execution.capability)
    assert.notEqual(nextConfig.result.capability, privateConfig.result.capability)
    await f.sdk.enqueue({ text: 'second composition reply' })
    assert.equal(
      (await second.prompt('phi-composition-run-2', 'second explicit message')).result.status,
      'completed'
    )
    const requests = (await f.sdk.snapshot()).providerRequests
    assert.ok(JSON.stringify(requests.at(-1)!.body).includes('first composition message'))
    assert.ok(JSON.stringify(requests.at(-1)!.body).includes('first composition reply'))
    assert.equal(f.f.session.closed, false)
  }
)

test(
  'a failed provider response leaves the remote runtime able to admit the next prompt',
  { timeout: 90_000 },
  async (t) => {
    const f = await runtimeCompositionFixture()
    t.after(() => f.close())
    const runtime = await f.create()
    await f.sdk.enqueue({ httpStatus: 401 })
    const first = await runtime.prompt('provider-failure-1', 'first prompt')
    assert.equal(first.outcome, 'failed')
    assert.equal(first.result.status, 'error')
    assert.equal(runtime.isReady, true)
    await f.sdk.enqueue({ text: 'recovered' })
    const second = await runtime.prompt('provider-failure-2', 'second prompt')
    assert.equal(second.outcome, 'completed')
    assert.equal(second.result.status, 'completed')
  }
)
