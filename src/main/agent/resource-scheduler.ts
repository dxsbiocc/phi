import {
  createResourceAdmission,
  resourcesConflict,
  type ExecutionResource
} from './resource-admission'

const MAX_WAITING = 256

interface WaitingOperation {
  owner: string
  resources: readonly ExecutionResource[]
  start(release: () => void): void
}

interface ResourceScheduler {
  run<T>(
    resources: readonly ExecutionResource[],
    signal: AbortSignal | undefined,
    execute: () => T | PromiseLike<T>,
    onWait?: () => void
  ): Promise<T>
}

/** FIFO for conflicting requests. Compatible work can pass a blocked request. */
export function createResourceScheduler(): ResourceScheduler {
  const admission = createResourceAdmission()
  const waiting: WaitingOperation[] = []
  let nextOwner = 0

  function pump(): void {
    for (let index = 0; index < waiting.length;) {
      const operation = waiting[index]
      if (
        waiting
          .slice(0, index)
          .some((prior) => resourcesConflict(prior.resources, operation.resources))
      ) {
        index++
        continue
      }
      const release = admission.reserve(operation.owner, operation.resources)
      if (!release) {
        index++
        continue
      }
      waiting.splice(index, 1)
      operation.start(release)
    }
  }

  function run<T>(
    resources: readonly ExecutionResource[],
    signal: AbortSignal | undefined,
    execute: () => T | PromiseLike<T>,
    onWait?: () => void
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (waiting.length >= MAX_WAITING) {
      return Promise.reject(new Error('Resource scheduler queue is full.'))
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        const index = waiting.indexOf(operation)
        if (index === -1) return
        waiting.splice(index, 1)
        signal?.removeEventListener('abort', onAbort)
        reject(signal?.reason)
        pump()
      }
      const operation: WaitingOperation = {
        owner: String(++nextOwner),
        resources: resources.map(({ namespace, segments, access }) => ({
          namespace,
          segments: [...segments],
          access
        })),
        start(release) {
          signal?.removeEventListener('abort', onAbort)
          // Invoke only after the scan, and keep the claim until actual settlement,
          // even if the cancellation signal arrives while the tool is still working.
          void Promise.resolve()
            .then(() => {
              signal?.throwIfAborted()
              return execute()
            })
            .finally(() => {
              release()
              pump()
            })
            .then(resolve, reject)
        }
      }
      waiting.push(operation)
      signal?.addEventListener('abort', onAbort, { once: true })
      pump()
      if (onWait && waiting.includes(operation)) {
        try {
          onWait()
        } catch {
          // An observation cannot cancel dispatch or strand the resource.
        }
      }
    })
  }

  return { run }
}
