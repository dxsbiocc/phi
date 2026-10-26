import { randomUUID } from 'node:crypto'
import { HostRequestContext, HostResponse, UnknownRecord, toJsonSafe } from './common'
import { pendingHostRequests } from './state'

export type WorkerOutbound = {
  send(value: unknown): void
  event(name: string, payload: unknown, extra: UnknownRecord): void
  hostRequest(
    method: string,
    params: unknown,
    context?: HostRequestContext,
    onProgress?: (progress: unknown) => void
  ): Promise<unknown>
}

let workerOutbound: WorkerOutbound | undefined
let workerToJsonSafe = toJsonSafe

function configuredOutbound(): WorkerOutbound {
  if (!workerOutbound) throw new Error('Worker outbound is not configured')
  return workerOutbound
}

export function setWorkerOutbound(
  outbound: WorkerOutbound | undefined,
  options: { toJsonSafe?: typeof toJsonSafe } = {}
): void {
  workerOutbound = outbound
  workerToJsonSafe = options.toJsonSafe ?? toJsonSafe
}

export function createStdoutWorkerOutbound(
  write: (line: string) => unknown = (line) => process.stdout.write(line)
): WorkerOutbound {
  const writeFrame = (value: unknown): void => {
    write(`${JSON.stringify(value)}\n`)
  }
  return {
    send: writeFrame,
    event(name, payload, extra) {
      writeFrame({ type: 'event', event: name, payload, ...extra })
    },
    hostRequest(method, params, context) {
      const id = randomUUID()
      writeFrame({
        type: 'hostRequest',
        id,
        method,
        params,
        ...(context ? { context } : {})
      })
      return new Promise<unknown>((resolve, reject) => {
        pendingHostRequests.set(id, { resolve, reject })
      })
    }
  }
}

export function send(value: unknown): void {
  configuredOutbound().send(workerToJsonSafe(value))
}

export function sendEvent(event: string, payload: unknown, extra: UnknownRecord = {}): void {
  const safe = workerToJsonSafe({ payload, extra }) as {
    payload: unknown
    extra: UnknownRecord
  }
  configuredOutbound().event(event, safe.payload, safe.extra)
}

export function isHostResponse(value: unknown): value is HostResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'hostResponse' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  )
}

export function requestHost(
  method: string,
  params: unknown,
  context?: HostRequestContext,
  onProgress?: (progress: unknown) => void
): Promise<unknown> {
  const safe = workerToJsonSafe({ params, ...(context ? { context } : {}) }) as {
    params: unknown
    context?: HostRequestContext
  }
  return configuredOutbound().hostRequest(method, safe.params, safe.context, onProgress)
}

export function handleHostResponse(response: HostResponse): void {
  const pending = pendingHostRequests.get(response.id)
  if (!pending) return
  pendingHostRequests.delete(response.id)
  if (response.ok) {
    pending.resolve(response.result)
  } else {
    const error = new Error(response.error)
    if (response.stack) error.stack = response.stack
    pending.reject(error)
  }
}
