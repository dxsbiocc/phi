export class OfficeOperationQueueError extends Error {
  readonly code = 'workbook_busy' as const

  constructor() {
    super('Office 文档正在关闭，暂时无法读取')
    this.name = 'OfficeOperationQueueError'
  }
}

export class OfficeOperationQueueCancelledError extends Error {
  readonly code = 'operation_cancelled' as const

  constructor(readonly owner: string) {
    super('排队中的文档操作已取消')
    this.name = 'OfficeOperationQueueCancelledError'
  }
}

export interface OfficeOperationQueueRunOptions {
  readonly owner: string
  readonly signal?: AbortSignal
}

interface OfficeOperationQueueHooks {
  readonly onEnqueue?: () => void
  readonly beforeStart?: (signal: AbortSignal) => Promise<void>
  readonly onIdle?: () => void
}

export class OfficeDocumentOperationQueue {
  private tail: Promise<void> = Promise.resolve()
  private active?: AbortController
  private readonly stopController = new AbortController()
  private stopped = false
  private pending = 0

  constructor(private readonly hooks: OfficeOperationQueueHooks = {}) {}

  get idle(): boolean {
    return this.pending === 0
  }

  async run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    options?: OfficeOperationQueueRunOptions
  ): Promise<T> {
    this.pending += 1
    this.hooks.onEnqueue?.()
    let release!: () => void
    const turn = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.tail
    this.tail = previous.catch(() => undefined).then(() => turn)
    let controller: AbortController | undefined
    try {
      await this.waitForTurn(previous, options)
      if (this.stopped) throw new OfficeOperationQueueError()
      if (options?.signal?.aborted) {
        throw new OfficeOperationQueueCancelledError(options.owner)
      }
      controller = new AbortController()
      this.active = controller
      const healthSignal = options?.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal
      await this.hooks.beforeStart?.(healthSignal)
      if (options?.signal?.aborted) {
        throw new OfficeOperationQueueCancelledError(options.owner)
      }
      return await operation(controller.signal)
    } finally {
      if (this.active === controller) this.active = undefined
      this.pending -= 1
      release()
      if (this.pending === 0) this.hooks.onIdle?.()
    }
  }

  cancel(): void {
    this.stopped = true
    this.stopController.abort()
    this.active?.abort()
  }

  drain(): Promise<void> {
    return this.tail.catch(() => undefined)
  }

  private waitForTurn(
    previous: Promise<void>,
    options: OfficeOperationQueueRunOptions | undefined
  ): Promise<void> {
    if (this.stopped) return Promise.reject(new OfficeOperationQueueError())
    if (options?.signal?.aborted) {
      return Promise.reject(new OfficeOperationQueueCancelledError(options.owner))
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (result: () => void): void => {
        if (settled) return
        settled = true
        options?.signal?.removeEventListener('abort', cancelOwner)
        this.stopController.signal.removeEventListener('abort', cancelQueue)
        result()
      }
      const cancelOwner = (): void =>
        finish(() => reject(new OfficeOperationQueueCancelledError(options!.owner)))
      const cancelQueue = (): void => finish(() => reject(new OfficeOperationQueueError()))
      options?.signal?.addEventListener('abort', cancelOwner, { once: true })
      this.stopController.signal.addEventListener('abort', cancelQueue, { once: true })
      void previous.catch(() => undefined).then(() => finish(resolve))
    })
  }
}
