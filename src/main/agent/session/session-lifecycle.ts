export interface SessionSnapshot {
  path: string | undefined
  cwd: string
  permissionMode: string
}

export interface SessionLifecycleRecord<TResult> {
  readonly generation: number
  readonly snapshot: SessionSnapshot
  readonly promise: Promise<TResult>
}

export class StaleSessionError extends Error {
  constructor() {
    super('Session was superseded before it became active')
    this.name = 'StaleSessionError'
  }
}

export function isStaleSessionError(error: unknown): error is StaleSessionError {
  return error instanceof StaleSessionError
}

export class SessionLifecycle<TResult> {
  private generation = 0
  private current: SessionLifecycleRecord<TResult> | null = null

  get currentGeneration(): number {
    return this.generation
  }

  get currentRecord(): SessionLifecycleRecord<TResult> | null {
    return this.current
  }

  advance(): SessionLifecycleRecord<TResult> | null {
    const previous = this.current
    this.generation += 1
    this.current = null
    return previous
  }

  getOrCreate(
    snapshot: SessionSnapshot,
    factory: (snapshot: SessionSnapshot, generation: number) => Promise<TResult>,
    onStaleResult?: (result: TResult) => void | Promise<void>
  ): SessionLifecycleRecord<TResult> {
    if (this.current?.generation === this.generation) {
      return this.current
    }

    const generation = this.generation
    const capturedSnapshot = { ...snapshot }
    const record: SessionLifecycleRecord<TResult> = {
      generation,
      snapshot: capturedSnapshot,
      promise: Promise.resolve()
        .then(() => factory({ ...capturedSnapshot }, generation))
        .then(async (result) => {
          if (!this.isCurrent(record)) {
            await onStaleResult?.(result)
            throw new StaleSessionError()
          }
          return result
        })
        .catch((error) => {
          if (this.current === record) {
            this.current = null
          }
          throw error
        })
    }

    this.current = record
    return record
  }

  isCurrent(record: SessionLifecycleRecord<TResult> | null | undefined): boolean {
    return Boolean(record && this.current === record && record.generation === this.generation)
  }

  isCurrentGeneration(generation: number): boolean {
    return generation === this.generation
  }
}
