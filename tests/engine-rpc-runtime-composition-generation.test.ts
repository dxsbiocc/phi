import assert from 'node:assert/strict'
import test from 'node:test'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { RpcConnection } from '../src/main/agent/engine/rpc/connection'
import { createInitializationWire } from './helpers/rpc-initialization-wire'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'
import { createPersistentLauncherFixture } from './helpers/persistentLauncherFixture'
import type { RpcApprovalDecision } from '../src/main/agent/engine/rpc/approval-bridge'

test('the actual connection generation reaches factories across restart and a cancelled startup which never opened', async () => {
  const observed: number[] = []
  const connection = new RpcConnection((_signal, generation) => {
    observed.push(generation)
    return createInitializationWire().transport
  })
  const unopened = connection.start()
  void unopened.catch(() => undefined)
  await connection.close()
  await assert.rejects(unopened)
  assert.deepEqual(observed, [])
  await connection.start()
  assert.equal(connection.bindControl().generation, 2)
  assert.deepEqual(observed, [2])
  await connection.close()
  await connection.start()
  assert.equal(connection.bindControl().generation, 3)
  assert.deepEqual(observed, [2, 3])
  await connection.close()
})

test(
  'the production SSH factory receives generation 2 after unopened cancellation and generation 3 on restart',
  { timeout: 45_000 },
  async (t) => {
    const f = await createPersistentLauncherFixture(true)
    t.after(() => f.cleanup())
    const observed: number[] = []
    const transport = await f.factory({
      prepareRuntime: async ({ generation }) => {
        observed.push(generation)
      }
    })
    const connection = new RpcConnection(
      (signal, generation) => transport.open(f.params, signal, generation),
      { startupTimeoutMs: 15_000 }
    )
    t.after(() => connection.close())
    const cancelled = connection.start()
    void cancelled.catch(() => undefined)
    await connection.close()
    await assert.rejects(cancelled)
    assert.deepEqual(observed, [])
    for (const generation of [2, 3]) {
      // The actual CLI correctly rejects the deliberately missing mandatory
      // runtime sidecar before ready. Its real prelaunch hook must still receive
      // this allocated connection generation, rather than counting successful opens.
      await assert.rejects(connection.start(), /RPC output stream ended/)
      assert.equal(observed.at(-1), generation)
      await connection.close()
    }
    assert.deepEqual(observed, [2, 3])
    assert.equal(f.session.closed, false)
  }
)

test(
  'a closed generation cannot revive its approval or replay into a fresh runtime attached to the same journal',
  { timeout: 60_000 },
  async (t) => {
    const f = await runtimeCompositionFixture()
    t.after(() => f.close())
    let answer: ((decision: RpcApprovalDecision) => void) | undefined
    const first = await f.create({
      approval: {
        shouldGate: () => true,
        requestToolApproval: () =>
          new Promise((resolve) => {
            answer = resolve
          })
      }
    })
    const reference = first.currentSnapshot().reference
    await f.sdk.enqueue({
      tool: {
        name: 'write',
        args: { path: 'old-generation.txt', content: 'must not happen' },
        id: 'generation-call'
      }
    })
    const oldRun = first.prompt('phi-generation-old', 'wait for approval')
    void oldRun.catch(() => undefined)
    const deadline = Date.now() + 8000
    while (!answer) {
      if (Date.now() > deadline) throw new Error('Approval did not arrive')
      await delay(5)
    }
    const beforeCloseCount = (await f.sdk.snapshot()).providerRequests.length
    await first.close(new Error('Synthetic transport generation replacement'))
    await assert.rejects(oldRun)
    await assert.rejects(access(join(f.f.scope.projectRoot, 'old-generation.txt')))
    // OMP may finish draining its denied tool result while close is in progress,
    // which sends at most one more provider request from the old generation (observed
    // 0 or 1). Bound it, then isolate resume and late-approval replay exactly.
    const closedRequestCount = (await f.sdk.snapshot()).providerRequests.length
    assert.ok(
      closedRequestCount - beforeCloseCount <= 1,
      `closing the old generation sent ${closedRequestCount - beforeCloseCount} provider requests`
    )
    const second = await f.create({
      action: { type: 'resume', reference, savedModel: f.ref },
      approval: {
        shouldGate: () => false,
        requestToolApproval: () => {
          throw new Error('Automatic policy must not show UI')
        }
      }
    })
    assert.equal(second.currentSnapshot().reference.ompSessionId, reference.ompSessionId)
    assert.equal((await f.sdk.snapshot()).providerRequests.length, closedRequestCount)
    answer!('approved')
    await delay(20)
    await assert.rejects(access(join(f.f.scope.projectRoot, 'old-generation.txt')))
    assert.equal((await f.sdk.snapshot()).providerRequests.length, closedRequestCount)
    await f.sdk.enqueue({ text: 'new generation explicit response' })
    assert.equal(
      (await second.prompt('phi-generation-new', 'new explicit prompt')).outcome,
      'completed'
    )
    assert.equal((await f.sdk.snapshot()).providerRequests.length, closedRequestCount + 1)
    await assert.rejects(access(join(f.f.scope.projectRoot, 'old-generation.txt')))
    assert.equal(f.f.session.closed, false)
  }
)
