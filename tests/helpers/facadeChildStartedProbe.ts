import { mock } from 'node:test'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import type { RpcCommand, RpcFrame, RpcRequestOptions } from '../../src/main/agent/engine/rpc/types'

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export interface DelayedChildStarted {
  readonly started: Promise<{ nativeId: string; sessionFile: string }>
  readonly evidence: {
    parentAbortCalls: number
    cancels: Array<{ nativeId: string; cancelled: boolean }>
    aborted: string[]
  }
  nativeSnapshot(): Promise<unknown>
  release(): void
  restore(): void
}
/** Hold delivery of a real SDK started frame, while the actual child and control channel stay alive. */
export function delayActualChildStarted(): DelayedChildStarted {
  let ready!: (value: { nativeId: string; sessionFile: string }) => void
  const started = new Promise<{ nativeId: string; sessionFile: string }>((resolve) => {
    ready = resolve
  })
  const waiting: Array<() => void> = []
  let released = false,
    nativeId: string | undefined,
    snapshotReader: (() => Promise<unknown>) | undefined
  const evidence: DelayedChildStarted['evidence'] = {
    parentAbortCalls: 0,
    cancels: [],
    aborted: []
  }
  const onEvent = RpcConnection.prototype.onEvent
  const events = mock.method(
    RpcConnection.prototype,
    'onEvent',
    function (this: RpcConnection, listener: (frame: RpcFrame) => void) {
      return onEvent.call(this, (frame) => {
        const payload = frame.payload
        if (frame.type === 'subagent_lifecycle' && record(payload)) {
          if (
            !nativeId &&
            payload.status === 'started' &&
            typeof payload.id === 'string' &&
            typeof payload.sessionFile === 'string'
          ) {
            nativeId = payload.id
            snapshotReader = () => this.request({ type: 'get_subagents' })
            ready({ nativeId, sessionFile: payload.sessionFile })
          }
          if (nativeId && payload.id === nativeId && payload.status === 'aborted')
            evidence.aborted.push(nativeId)
          if (!released && payload.id === nativeId && payload.status === 'started') {
            waiting.push(() => listener(frame))
            return
          }
        }
        listener(frame)
      })
    }
  )
  const request = RpcConnection.prototype.request
  const requests = mock.method(
    RpcConnection.prototype,
    'request',
    function (this: RpcConnection, command: RpcCommand, options?: RpcRequestOptions) {
      const result = request.call(this, command, options)
      if (command.type !== 'cancel_subagent' || typeof command.subagentId !== 'string')
        return result
      const cancelledNativeId = command.subagentId
      return result.then((value) => {
        evidence.cancels.push({
          nativeId: cancelledNativeId,
          cancelled: record(value) && value.cancelled === true
        })
        return value
      })
    }
  )
  const abort = RpcConnection.prototype.abort
  const aborts = mock.method(RpcConnection.prototype, 'abort', function (this: RpcConnection) {
    evidence.parentAbortCalls++
    return abort.call(this)
  })
  const release = (): void => {
    released = true
    for (const notify of waiting.splice(0)) notify()
  }
  return {
    started,
    evidence,
    nativeSnapshot: () => {
      if (!snapshotReader) return Promise.reject(new Error('Actual native child has not started'))
      return snapshotReader()
    },
    release,
    restore() {
      release()
      events.mock.restore()
      requests.mock.restore()
      aborts.mock.restore()
    }
  }
}
