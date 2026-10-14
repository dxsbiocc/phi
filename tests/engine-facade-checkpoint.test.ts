import test from 'node:test'
import assert from 'node:assert/strict'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'
import { RemoteSessionRuntime } from '../src/main/agent/engine/rpc/remote-session-runtime'

test(
  'checkpoint lease is acquired before asynchronous preparation and cleanup cannot mask primary adoption failure',
  { timeout: 60000 },
  async () => {
    const f = await runtimeCompositionFixture()
    const primary = new Error('primary Phi adoption failure')
    const cleanup = new Error('secondary release failure')
    let acquired = 0,
      released = 0
    try {
      await assert.rejects(
        f.create({
          beforeCheckpoint: (signal) => {
            assert.equal(signal.aborted, false)
            assert.equal(f.leases.length, 0)
            acquired++
            return () => {
              released++
              throw cleanup
            }
          },
          adopt: async () => {
            throw primary
          }
        }),
        (error: Error) => error.cause === primary
      )
      assert.equal(acquired, 1)
      assert.equal(released, 1)
      assert.equal((await f.sdk.snapshot()).providerRequests.length, 0)
      assert.ok(f.f.preparations.every((storage) => storage.lease.signal.aborted))
    } finally {
      await f.close()
    }
  }
)

test(
  'turn checkpoint release failure or reentrant cancellation never restores readiness',
  { timeout: 90000 },
  async () => {
    const f = await runtimeCompositionFixture()
    let checkpoints = 0,
      releases = 0
    let runtime: RemoteSessionRuntime | undefined
    const failure = new Error('checkpoint release failed')
    try {
      runtime = await f.create({
        beforeCheckpoint: () => {
          checkpoints++
          if (runtime) {
            assert.equal(runtime.isReady, false)
            assert.equal(runtime.currentRun(), undefined)
          }
          return () => {
            releases++
            if (checkpoints > 1) {
              void runtime!.close(failure)
              throw failure
            }
          }
        }
      })
      await f.sdk.enqueue({ text: 'settled before checkpoint release' })
      await assert.rejects(
        runtime.prompt('actual-phi-run', 'new submission'),
        (error) => error === failure
      )
      assert.equal(checkpoints, 2)
      assert.equal(releases, 2)
      assert.equal(runtime.isReady, false)
      await assert.rejects(runtime.prompt('cannot-revive', 'next submission'), /cannot admit/)
      assert.ok(f.f.preparations.every((storage) => storage.lease.signal.aborted))
    } finally {
      await f.close()
    }
  }
)
