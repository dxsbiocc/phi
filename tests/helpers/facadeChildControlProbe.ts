import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import type {
  RpcCommand,
  RpcRequestOptions,
  RpcControlChannel
} from '../../src/main/agent/engine/rpc/types'

export interface HeldChildCancellationAck {
  readonly acknowledged: Promise<void>
  release(): void
  readonly evidence: { cancelled?: boolean; parentAbortCalls: number }
  restore(): void
}
/** Delay one actual official cancellation ACK; the native request and response stay real. */
export function holdChildCancellationAck(): HeldChildCancellationAck {
  let ready!: () => void, release!: () => void
  const acknowledged = new Promise<void>((resolve) => {
    ready = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = RpcConnection.prototype.request
  let claimed = false
  const evidence: { cancelled?: boolean; parentAbortCalls: number } = { parentAbortCalls: 0 }
  const request = mock.method(
    RpcConnection.prototype,
    'request',
    function (this: RpcConnection, command: RpcCommand, options?: RpcRequestOptions) {
      const result = original.call(this, command, options)
      if (command.type !== 'cancel_subagent' || claimed) return result
      claimed = true
      return result.then(async (value) => {
        assert.ok(value && typeof value === 'object' && 'cancelled' in value)
        evidence.cancelled = value.cancelled === true
        ready()
        await held
        return value
      })
    }
  )
  const originalAbort = RpcConnection.prototype.abort
  const abort = mock.method(RpcConnection.prototype, 'abort', function (this: RpcConnection) {
    evidence.parentAbortCalls++
    return originalAbort.call(this)
  })
  return {
    acknowledged,
    release,
    evidence,
    restore() {
      request.mock.restore()
      abort.mock.restore()
    }
  }
}

export interface HeldMainApprovalCommit {
  readonly submitted: Promise<void>
  release(): void
  restore(): void
}
/** Delay only notification of the first physically delivered main allow, not its SDK decision or tool result. */
export function holdMainApprovalCommit(): HeldMainApprovalCommit {
  let submitted!: () => void, release!: () => void
  const ready = new Promise<void>((resolve) => {
    submitted = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let claimed = false
  const bind = RpcConnection.prototype.bindControl
  const spy = mock.method(RpcConnection.prototype, 'bindControl', function (this: RpcConnection) {
    const channel = bind.call(this)
    const wrapped: RpcControlChannel = {
      ...channel,
      async sendControl(frame, commit) {
        await channel.sendControl(frame, commit)
        if (
          !claimed &&
          frame.type === 'extension_ui_response' &&
          'confirmed' in frame &&
          frame.confirmed === true
        ) {
          claimed = true
          submitted()
          await held
        }
      }
    }
    return Object.freeze(wrapped)
  })
  return {
    submitted: ready,
    release,
    restore() {
      release()
      spy.mock.restore()
    }
  }
}
