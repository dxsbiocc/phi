import assert from 'node:assert/strict'
import { mock } from 'node:test'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import type { RuntimeAgentSession } from '../../src/main/agent/runtime/runtime-adapter'
import { createRunId, findPhiSessionById } from '../../src/main/agent/session/session-store'
import { saveRemoteHostProfile } from '../../src/main/agent/remote-hosts'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import type { RpcFrame } from '../../src/main/agent/engine/rpc/types'

async function until(check: () => boolean): Promise<void> {
  const start = Date.now()
  while (!check()) {
    assert.ok(Date.now() - start < 15000, 'compaction boundary did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Existing real app/CLI with only the trusted settings lookup held at an await boundary. */
export async function runCompactionBoundary(
  f: FacadeMetadataFixture,
  proxy: RuntimeAgentSession,
  mode: string
): Promise<void> {
  const original = findPhiSessionById(f.phi.sessionId)!,
    channels = f.channels.length
  const rebind = (): void => {
    if (original.projectLocation?.kind !== 'ssh') throw new Error('Missing fixture SSH project')
    saveRemoteHostProfile(
      {
        id: original.projectLocation.hostProfileId,
        label: 'Rebound fixture host',
        hostAlias: 'rebound-synthetic-host'
      },
      process.env.PI_CODING_AGENT_DIR!
    )
  }
  if (mode.startsWith('manual-lookup-')) {
    let held = false,
      release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const onEvent = RpcConnection.prototype.onEvent
    const probe = mock.method(
      RpcConnection.prototype,
      'onEvent',
      function (this: RpcConnection, listener: (frame: RpcFrame) => void) {
        return onEvent.call(this, (frame) => {
          if (
            frame.type === 'extension_ui_request' &&
            frame.method === 'notify' &&
            typeof frame.message === 'string'
          ) {
            try {
              const value = JSON.parse(frame.message)
              if (value.type === 'phi_rpc_compaction_control' && value.operation === 'settings') {
                held = true
                void gate.then(() => listener(frame))
                return
              }
            } catch {
              /* Unrelated notifications retain their existing route. */
            }
          }
          listener(frame)
        })
      }
    )
    try {
      const rejected = assert.rejects(
        proxy.compact(),
        /cancel|stopped|changed|改变|binding|closing|HOST/
      )
      await until(() => held)
      if (mode === 'manual-lookup-abort')
        await assert.rejects(proxy.abort(), /cancel|stopped|closing|Owned/)
      else rebind()
      release()
      await rejected
      assert.equal(f.provider.requests.length, 0, 'cancelled lookup cannot dispatch a summary')
      assert.deepEqual(findPhiSessionById(f.phi.sessionId)!.runtimeRef, original.runtimeRef)
      assert.equal(f.channels.length, channels)
      return
    } finally {
      release()
      probe.mock.restore()
    }
  }
  if (mode === 'busy' || mode === 'approval') {
    let approve: ((result: 'approved') => void) | undefined
    f.configureApproval({
      shouldGate: () => true,
      requestToolApproval: () =>
        new Promise((resolve) => {
          approve = resolve
        })
    })
    f.provider.enqueue(
      mode === 'busy'
        ? { text: 'Owned original model turn remains active', hold: true }
        : {
            tool: {
              name: 'write',
              args: { path: 'blocked-approval.txt', content: 'must not write' }
            }
          }
    )
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: () => proxy.prompt('Keep the original run active')
    })
    await until(() => (mode === 'busy' ? f.provider.requests.length > 0 : !!approve))
    const before = findPhiSessionById(f.phi.sessionId)!
    await assert.rejects(proxy.compact(), /idle|active|running/)
    await assert.rejects(proxy.setAutoCompactionSettings({ enabled: false }), /idle|active|running/)
    assert.equal(f.channels.length, channels)
    assert.deepEqual(findPhiSessionById(f.phi.sessionId)!.runtimeRef, before.runtimeRef)
    assert.equal(findPhiSessionById(f.phi.sessionId)!.autoCompaction, undefined)
    assert.equal(f.provider.requests.length, 1, 'rejected controls must not invoke a provider')
    f.runners.stopRun(f.phi.sessionId)
    await proxy.abort()
    approve?.('approved')
    await run.done
    assert.equal(await f.exists(f.f.scope.projectRoot + '/blocked-approval.txt'), false)
    return
  }
  let held = false,
    release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const request = f.bridge.request.bind(f.bridge)
  const probe = mock.method(f.bridge, 'request', async (method, params) => {
    const result = await request(method, params)
    if (method === 'settings.autoCompactionDefaults' && params.includePolicy === true) {
      held = true
      await gate
    }
    return result
  })
  try {
    const pending = proxy.setAutoCompactionSettings({ enabled: false, thresholdPercent: 70 })
    const rejected = assert.rejects(pending, /cancel|stopped|changed|改变|binding|STALE|HOST/)
    await until(() => held)
    const stopped =
      mode === 'lookup-abort' ? assert.rejects(proxy.abort(), /cancel|stopped/) : undefined
    if (mode !== 'lookup-abort') {
      rebind()
    }
    release()
    await stopped
    await rejected
    assert.equal(f.channels.length, channels, 'unaccepted lookup cannot retire or start a CLI')
    assert.deepEqual(findPhiSessionById(f.phi.sessionId)!.runtimeRef, original.runtimeRef)
    assert.equal(findPhiSessionById(f.phi.sessionId)!.autoCompaction, undefined)
    assert.equal(f.provider.requests.length, 0)
  } finally {
    release()
    probe.mock.restore()
  }
}
