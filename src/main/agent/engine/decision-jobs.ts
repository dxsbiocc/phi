import { DECISION_TIMEOUT_MS } from './decision-client'

/** Session-independent job identities prevent a stopped task from cancelling its successor. */
export class DecisionJobs {
  private readonly active = new Map<string, AbortController>()
  private readonly cancelled = new Map<string, number>()
  constructor(private readonly timeoutMs = DECISION_TIMEOUT_MS) {}

  cancel(jobId: string): void {
    this.prune()
    const active = this.active.get(jobId)
    if (active) active.abort(new Error('Decision cancelled'))
    else {
      if (this.cancelled.size >= 1024) this.cancelled.delete(this.cancelled.keys().next().value!)
      this.cancelled.set(jobId, Date.now() + this.timeoutMs)
    }
  }

  async run<T>(
    jobId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    this.prune()
    signal?.throwIfAborted()
    if (this.cancelled.has(jobId)) throw new Error('Decision cancelled before dispatch')
    if (this.active.has(jobId) || this.active.size >= 64)
      throw new Error('Decision job unavailable')
    const controller = new AbortController()
    this.active.set(jobId, controller)
    const abort = (): void => {
      controller.abort(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () => controller.abort(new Error('Decision deadline exceeded')),
      this.timeoutMs
    )
    let rejectOnAbort: (() => void) | undefined
    try {
      if (signal?.aborted) abort()
      controller.signal.throwIfAborted()
      const aborted = new Promise<never>((_, reject) => {
        rejectOnAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
      })
      const result = await Promise.race([operation(controller.signal), aborted])
      controller.signal.throwIfAborted()
      return result
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort)
      this.active.delete(jobId)
    }
  }

  close(): void {
    for (const controller of this.active.values())
      controller.abort(new Error('Decision runtime closed'))
    this.cancelled.clear()
  }

  private prune(): void {
    for (const [id, expiry] of this.cancelled) if (expiry <= Date.now()) this.cancelled.delete(id)
  }
}
