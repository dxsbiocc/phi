import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteSessionRuntime } from '../src/main/agent/engine/rpc/remote-session-runtime'

function fixture(options: {
  currentFailure?: Error
  backgroundFailure?: Error
  manual?: boolean
}): {
  runtime: RemoteSessionRuntime
  attempts: string[]
  counts: { physicalClose: number; drain: number; manualAbort: number }
} {
  const attempts: string[] = []
  const counts = { physicalClose: 0, drain: 0, manualAbort: 0 }
  const channel = new AbortController()
  // Exercise the actual class cleanup method with injected faults, not an SDK process claim.
  const runtime: RemoteSessionRuntime = Object.create(RemoteSessionRuntime.prototype)
  Object.assign(runtime, {
    lifetime: new AbortController(),
    childVaults: new Map(),
    detach: [],
    options: {
      foregroundChildren: {
        drainHost: async () => {
          counts.drain++
        }
      }
    },
    connection: {
      bindControl: () => ({ signal: channel.signal }),
      close: async () => {
        counts.physicalClose++
      },
      abort: async () => {
        counts.manualAbort++
      }
    },
    children: {
      listRuns: () => [
        { parentRunId: 'current' },
        { parentRunId: 'older-a' },
        { parentRunId: 'older-b' }
      ],
      stopParent: async (id: string) => {
        attempts.push(id)
        if (id === 'older-a' && options.backgroundFailure) throw options.backgroundFailure
      },
      dispose(): void {
        return undefined
      }
    },
    stopExecution: () =>
      options.currentFailure ? Promise.reject(options.currentFailure) : Promise.resolve(),
    ...(options.manual
      ? { manualCompaction: Promise.resolve(), manualController: new AbortController() }
      : {})
  })
  return { runtime, attempts, counts }
}
test('a current-parent cancellation failure still attempts every older background parent and physical cleanup', async () => {
  const first = new Error('current cancellation refused')
  const f = fixture({ currentFailure: first })
  await assert.rejects(f.runtime.close(), (error) => error === first)
  assert.deepEqual(f.attempts.sort(), ['current', 'older-a', 'older-b'])
  assert.deepEqual(f.counts, { physicalClose: 1, drain: 1, manualAbort: 0 })
})
test('one background cancellation failure preserves the first error and does not skip a peer parent', async () => {
  const first = new Error('background cancellation refused')
  const f = fixture({ backgroundFailure: first })
  await assert.rejects(f.runtime.close(), (error) => error === first)
  assert.deepEqual(f.attempts.sort(), ['current', 'older-a', 'older-b'])
  assert.equal(f.counts.physicalClose, 1)
  assert.equal(f.counts.drain, 1)
})
test('manual compaction cleanup is attempted even when current cancellation failed', async () => {
  const first = new Error('current cancellation refused')
  const f = fixture({ currentFailure: first, manual: true })
  await assert.rejects(f.runtime.close(), (error) => error === first)
  assert.equal(f.counts.manualAbort, 1)
  assert.equal(f.counts.physicalClose, 1)
  assert.equal(f.counts.drain, 1)
})
test('stop with only background subagents running stops every active child parent', async () => {
  const f = fixture({})
  Object.assign(f.runtime, {
    pending: undefined,
    children: {
      listRuns: () => [
        { parentRunId: 'older-a' },
        { parentRunId: 'older-b', completedAt: 1 },
        { parentRunId: 'older-c' }
      ],
      stopParent: async (id: string) => {
        f.attempts.push(id)
      }
    },
    stopExecution: () => Promise.resolve()
  })
  await f.runtime.stop()
  assert.deepEqual(f.attempts.sort(), ['older-a', 'older-c'])
  assert.equal(f.counts.physicalClose, 0)
})
test('stop propagates a background cancellation failure', async () => {
  const first = new Error('background cancellation refused')
  const f = fixture({ backgroundFailure: first })
  Object.assign(f.runtime, { pending: undefined, stopExecution: () => Promise.resolve() })
  await assert.rejects(f.runtime.stop(), (error) => error === first)
})
