import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteSessionRuntime } from '../src/main/agent/engine/rpc/remote-session-runtime'
import {
  RPC_COMPACTION_COMMAND,
  RPC_COMPACTION_DESCRIPTION
} from '../src/main/agent/engine/phi-extension/lib/rpc-compaction-control'
import type { RpcFrame } from '../src/main/agent/engine/rpc/types'

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
/** Actual runtime/control methods with a held protocol outcome; no fake SDK session is claimed. */
function lifecycleFixture(
  ackFailure?: Error,
  sdkMaintenanceBusy = false
): {
  runtime: RemoteSessionRuntime
  events: string[]
  listeners: Set<(frame: RpcFrame) => void>
  submitted(): number
} {
  const runtime = Object.create(RemoteSessionRuntime.prototype) as RemoteSessionRuntime
  const events: string[] = [],
    listeners = new Set<(frame: RpcFrame) => void>()
  let submitted = 0
  let physicallyClosed = false
  const snapshot = {
    reference: { ompSessionId: 'omp' },
    checkpoint: { journalPath: '/owned/journal' },
    model: { provider: 'fixture', id: 'm' },
    thinkingLevel: 'off'
  }
  Object.assign(runtime, {
    closing: undefined as Promise<void> | undefined,
    ready: true,
    gate: false,
    lifetime: new AbortController(),
    childVaults: new Map(),
    detach: [],
    options: {},
    host: {
      isReady: true,
      dispose() {
        /* No host tool is registered in this protocol-only fixture. */
      }
    },
    snapshot,
    config: { nonce: 'owned', phiSessionId: 'phi', generation: 1 },
    manualCancelled: false,
    manualFailureClosing: false,
    connection: {
      isReady: true,
      onEvent: (listener: (frame: RpcFrame) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      onDisconnect: () => () => {},
      request: async (frame: { type: string }) => {
        if (frame.type === 'get_state')
          return {
            sessionId: 'omp',
            sessionFile: '/owned/journal',
            model: snapshot.model,
            thinkingLevel: 'off',
            isStreaming: false,
            isCompacting: sdkMaintenanceBusy,
            isSettled: !sdkMaintenanceBusy,
            hasPendingAsyncWork: sdkMaintenanceBusy,
            queuedMessageCount: 0
          }
        if (frame.type === 'get_available_commands')
          return {
            commands: [
              {
                name: RPC_COMPACTION_COMMAND,
                description: RPC_COMPACTION_DESCRIPTION,
                source: 'extension'
              }
            ]
          }
        throw new Error(frame.type)
      },
      prompt: async () => {
        submitted++
        return { status: 'completed', agentInvoked: false }
      },
      abort: async () => {
        events.push('abort-ack')
        if (ackFailure) throw ackFailure
      },
      close: async () => {
        if (!physicallyClosed) {
          physicallyClosed = true
          events.push('physical-close')
        }
      }
    },
    active() {
      if (this.closing) throw new Error('closing')
      this.lifetime.signal.throwIfAborted()
    },
    withCheckpoint: async (operation: () => Promise<unknown>) => operation(),
    compactionPolicyUnderGate: async () => ({
      enabled: true,
      thresholdPercent: 80,
      thresholdTokens: -1,
      methodOrder: ['soft']
    })
  })
  return { runtime, events, listeners, submitted: () => submitted }
}

test('an accepted SDK maintenance operation rejects controls without aborting or closing its generation', async () => {
  const f = lifecycleFixture(undefined, true)
  await assert.rejects(f.runtime.compact(), /verified idle SDK session/)
  assert.equal(f.runtime.isReady, true)
  await assert.rejects(f.runtime.assertIdle(), /verified idle SDK session/)
  assert.deepEqual(f.events, [])
  assert.equal(f.submitted(), 0)
})

for (const mode of ['close', 'stop', 'failed-ack', 'self-failure'] as const)
  test(`manual compaction ${mode} settles owned transport without a final notification`, async () => {
    const failure = new Error('injected abort acknowledgement failure')
    const f = lifecycleFixture(mode === 'failed-ack' ? failure : undefined)
    let manualSettled = false
    const manual = f.runtime.compact()
    void manual.then(
      () => {
        manualSettled = true
      },
      () => {
        manualSettled = true
        f.events.push('manual-settled')
      }
    )
    for (let i = 0; i < 5; i++) await flush()
    assert.equal(f.submitted(), 1)
    let ending: Promise<unknown>
    if (mode === 'self-failure') {
      for (const listener of f.listeners)
        listener({ type: 'extension_error', extensionPath: `command:${RPC_COMPACTION_COMMAND}` })
      ending = manual
    } else
      ending = mode === 'stop' ? f.runtime.stop() : f.runtime.close(new Error('external close'))
    const ended = ending.then(
      () => undefined,
      (error) => error
    )
    for (let i = 0; i < 10; i++) await flush()
    assert.equal(
      manualSettled,
      true,
      'confirmed abort or physical retirement must unblock a lost outcome'
    )
    assert.equal(f.events.filter((value) => value === 'physical-close').length, 1)
    assert.equal(f.listeners.size, 0)
    if (mode === 'failed-ack') {
      assert.equal(await ended, failure)
      assert.ok(
        f.events.indexOf('physical-close') < f.events.indexOf('manual-settled'),
        'unknown abort must physically retire before releasing its pending owner'
      )
    } else await ended
    await manual.catch(() => undefined)
    const closes = f.events.filter((value) => value === 'physical-close').length
    for (const listener of f.listeners)
      listener({ type: 'extension_error', extensionPath: `command:${RPC_COMPACTION_COMMAND}` })
    assert.equal(
      f.events.filter((value) => value === 'physical-close').length,
      closes,
      'late outcomes cannot close another generation'
    )
  })
