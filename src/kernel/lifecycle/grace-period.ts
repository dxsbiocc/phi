export type KernelGracePeriodOptions = {
  graceMs: number
  onExpire(): void | Promise<void>
  onError?(error: unknown): void
}

export class KernelGracePeriod {
  private timer?: NodeJS.Timeout
  private closed = false
  private expired = false
  private attached = false

  constructor(private readonly options: KernelGracePeriodOptions) {
    if (!Number.isSafeInteger(options.graceMs) || options.graceMs <= 0) {
      throw new RangeError('graceMs must be a positive integer')
    }
  }

  /** Arms the initial grace period unless a controller already attached during startup. */
  startDisconnected(): void {
    if (!this.attached) this.schedule()
  }

  /** A desktop is attached, so its sessions are in use. */
  get controllerPresent(): boolean {
    return this.attached
  }

  controllerAttached(): void {
    this.attached = true
    this.clearTimer()
  }

  controllerDetached(): void {
    this.attached = false
    this.schedule()
  }

  close(): void {
    this.closed = true
    this.clearTimer()
  }

  private schedule(): void {
    if (this.closed || this.expired) return
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.closed || this.expired) return
      this.expired = true
      try {
        void Promise.resolve(this.options.onExpire()).catch((error: unknown) => {
          this.options.onError?.(error)
        })
      } catch (error) {
        this.options.onError?.(error)
      }
    }, this.options.graceMs)
    this.timer.unref()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
