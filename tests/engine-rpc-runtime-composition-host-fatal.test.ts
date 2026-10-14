import assert from 'node:assert/strict'
import test from 'node:test'
import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { PhiTool } from '../src/main/agent/engine/types'
import type { RemoteSessionRuntime } from '../src/main/agent/engine/rpc/remote-session-runtime'
import { RpcConnection } from '../src/main/agent/engine/rpc/connection'
import type { RpcControlChannel, RpcControlFrame } from '../src/main/agent/engine/rpc/types'
import { prepareRemoteSessionStorage } from '../src/main/agent/engine/rpc/session-storage/writer-lease'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'

for (const observerThrows of [false, true])
  test(
    `one host-result EIO retires only its production runtime and cannot revive it (${observerThrows ? 'throwing' : 'reentrant'} observer)`,
    { timeout: 40_000 },
    async (t) => {
      const original = RpcConnection.prototype.bindControl
      const targets = new WeakSet<RpcConnection>()
      let targetSelected = false,
        writes = 0
      const fault = Object.assign(new Error('Synthetic single host result EIO'), { code: 'EIO' })
      // Fault only one Node control send. Raw child-stdin errors already close the
      // RpcConnection and would mask a missing host-bridge onError integration.
      // No SDK method, bridge state/budget or remote process is replaced.
      t.mock.method(
        RpcConnection.prototype,
        'bindControl',
        function (this: RpcConnection): RpcControlChannel {
          if (!targetSelected) {
            targets.add(this)
            targetSelected = true
          }
          const control = original.call(this)
          if (!targets.has(this)) return control
          return Object.freeze({
            ...control,
            async sendControl(frame: RpcControlFrame) {
              if (writes === 0 && frame.type === 'host_tool_result') {
                writes++
                throw fault
              }
              await control.sendControl(frame)
            }
          })
        }
      )
      const f = await runtimeCompositionFixture()
      t.after(() => f.close())
      let effects = 0
      const tool: PhiTool = {
        name: 'desktop_fatal_probe',
        site: 'host',
        approval: 'read',
        label: 'Private result probe',
        description: 'Return one ordinary small result',
        parameters: { type: 'object', properties: {} },
        async execute() {
          effects++
          return { content: [{ type: 'text', text: 'one normal host result' }] }
        }
      }
      const interruptions: Error[] = [],
        reentry: Promise<unknown>[] = []
      const first: RemoteSessionRuntime = await f.create({
        tools: [tool],
        connectionOptions: { startupTimeoutMs: 15_000, promptTimeoutMs: 0 },
        onInterrupted: (error) => {
          interruptions.push(error)
          reentry.push(
            first
              .prompt('phi-fatal-reentry', 'Never revive the failed runtime')
              .catch((failure) => failure)
          )
          reentry.push(first.close())
          if (observerThrows) throw new Error('Synthetic interruption observer failure')
        }
      })
      const durable = first.currentSnapshot().checkpoint.journalPath
      const otherId = 'phi-fatal-isolated-session'
      const second = await f.create({
        params: { ...f.defaults.params, sessionId: otherId },
        transport: {
          ...f.defaults.transport,
          preparePersistentStorage: async ({ signal }) => {
            const storage = await prepareRemoteSessionStorage({
              runtimeHost: f.f.host,
              scope: { ...f.f.scope, phiSessionId: otherId },
              signal,
              openLockStdio: (command) => f.f.session.openStdio!(command)
            })
            f.f.preparations.push(storage)
            return storage
          }
        }
      })
      const otherJournal = second.currentSnapshot().checkpoint.journalPath
      await f.sdk.enqueue({ tool: { name: tool.name, args: {}, id: 'normal-host-call' } })
      let settled = false
      const outcome = first.prompt('phi-fatal-real-run', 'Request the host tool once').then(
        () => {
          settled = true
          return undefined
        },
        (error: unknown) => {
          settled = true
          return error
        }
      )
      const deadline = Date.now() + 3000
      while ((!settled || !interruptions.length) && Date.now() < deadline) await delay(5)
      const settledWithoutStop = settled
      await first.stop().catch(() => undefined)
      const readyAfterStop = first.isReady
      try {
        assert.equal(
          settledWithoutStop,
          true,
          `Fatal host bridge EIO left the deadline-free prompt pending; readyAfterStop=${readyAfterStop}`
        )
        assert.equal(first.isReady, false)
        assert.equal(first.currentRun(), undefined)
        assert.equal(writes, 1)
        assert.equal(effects, 1)
        assert.deepEqual(interruptions, [fault])
        assert.ok((await outcome) instanceof Error)
        await Promise.all(reentry)
        await first.close()
        assert.equal(interruptions.length, 1)
        await assert.rejects(first.prompt('phi-fatal-next', 'Must require a new runtime'))
        await access(durable)
        await access(otherJournal)
        assert.equal((await readdir(join(f.f.runtimeRoot, 'rpc-sessions'))).length, 1)
        assert.equal((await f.sdk.snapshot()).gateway.leases, 1)
        const failedStorage = f.f.preparations.find(
          (storage) => storage.scope.phiSessionId === f.f.scope.phiSessionId
        )!
        const healthyStorage = f.f.preparations.find(
          (storage) => storage.scope.phiSessionId === otherId
        )!
        assert.throws(() => failedStorage.lease.assertActive())
        healthyStorage.lease.assertActive()
        await f.tunnels[0].closed
        assert.equal(second.isReady, true)
        assert.equal(f.f.session.closed, false)
        await f.sdk.enqueue({ text: 'Other generation remains usable' })
        assert.equal(
          (await second.prompt('phi-fatal-isolated-run', 'Continue on the healthy session'))
            .outcome,
          'completed'
        )
      } finally {
        await first.close()
        await outcome
      }
    }
  )
