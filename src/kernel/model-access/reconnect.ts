import { ModelAccessWaitCancelledError, ModelConnectionLostError } from './errors'

export interface ModelProxyRoute {
  readonly endpoint: string
  readonly bearerToken: string
  readonly generation: number
}

type Waiter = {
  resolve(route: ModelProxyRoute): void
  reject(error: unknown): void
  signal?: AbortSignal
  abort?: () => void
}

function errorCode(error: unknown): string | undefined {
  let current = error
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') return undefined
    const code = Reflect.get(current, 'code')
    if (typeof code === 'string') return code
    current = Reflect.get(current, 'cause')
  }
  return undefined
}

export function isPreResponseConnectionFailure(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ECONNREFUSED' || code === 'ECONNRESET'
}

function requestSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
  return init?.signal ?? (input instanceof Request ? input.signal : undefined)
}

function replaceAuthorization(headers: HeadersInit | undefined, bearerToken: string): Headers {
  const result = new Headers(headers)
  result.set('authorization', `Bearer ${bearerToken}`)
  return result
}

function inputForRoute(input: RequestInfo | URL, route: ModelProxyRoute): RequestInfo | URL {
  if (input instanceof Request) return route.endpoint
  return route.endpoint
}

export class ModelProxyReconnectController {
  private readonly waiters = new Set<Waiter>()
  private attached = false
  private attachGeneration = 0
  private configuredAttachGeneration = 0
  private route?: ModelProxyRoute
  private cancelled?: unknown

  constructor(
    private readonly options: {
      fetch?: typeof globalThis.fetch
      onStateChanged?: () => void
    } = {}
  ) {}

  get ready(): boolean {
    return (
      this.attached &&
      this.route !== undefined &&
      this.configuredAttachGeneration === this.attachGeneration
    )
  }

  get currentRoute(): ModelProxyRoute | undefined {
    return this.route
  }

  controllerAttached(): void {
    this.attached = true
    this.attachGeneration += 1
    this.configuredAttachGeneration = 0
    this.cancelled = undefined
    this.options.onStateChanged?.()
  }

  controllerDetached(): void {
    if (!this.attached) return
    this.attached = false
    this.configuredAttachGeneration = 0
    this.options.onStateChanged?.()
  }

  configured(endpoint: string, bearerToken: string): ModelProxyRoute {
    const route = Object.freeze({
      endpoint,
      bearerToken,
      generation: (this.route?.generation ?? 0) + 1
    })
    this.route = route
    if (this.attached) this.configuredAttachGeneration = this.attachGeneration
    this.options.onStateChanged?.()
    if (this.ready) this.resolveWaiters(route)
    return route
  }

  cancelWaiting(reason: unknown = new ModelAccessWaitCancelledError()): void {
    this.cancelled = reason
    for (const waiter of [...this.waiters]) {
      this.removeWaiter(waiter)
      waiter.reject(reason)
    }
  }

  waitUntilReady(signal?: AbortSignal): Promise<ModelProxyRoute> {
    if (this.ready && this.route) return Promise.resolve(this.route)
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.cancelled !== undefined) return Promise.reject(this.cancelled)
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) }
      if (signal) {
        waiter.abort = () => {
          this.removeWaiter(waiter)
          reject(signal.reason)
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      this.waiters.add(waiter)
    })
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const fetchImpl = this.options.fetch ?? globalThis.fetch
    const signal = requestSignal(input, init)
    const initialRoute = this.route
    const attempt = (route: ModelProxyRoute | undefined): Promise<Response> => {
      if (!route) return fetchImpl(input, init)
      return fetchImpl(inputForRoute(input, route), {
        ...init,
        headers: replaceAuthorization(init?.headers, route.bearerToken)
      })
    }

    let response: Response
    try {
      response = await attempt(initialRoute)
    } catch (error) {
      if (!isPreResponseConnectionFailure(error) || this.attached) throw error
      const route = await this.waitUntilReady(signal)
      return attempt(route)
    }
    if (!response.body) return response
    const body = this.retryingBody(response.body, async () => {
      const route = await this.waitUntilReady(signal)
      const retry = await attempt(route)
      if (!retry.ok || !retry.body) throw new ModelConnectionLostError()
      return retry.body
    })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }

  private retryingBody(
    initial: ReadableStream<Uint8Array>,
    retry: () => Promise<ReadableStream<Uint8Array>>
  ): ReadableStream<Uint8Array> {
    let reader = initial.getReader()
    let sawBytes = false
    let retried = false
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const result = await reader.read()
          if (result.done) {
            controller.close()
            return
          }
          if (result.value.byteLength > 0) sawBytes = true
          controller.enqueue(result.value)
        } catch (error) {
          if (!sawBytes && !retried && !this.attached && isPreResponseConnectionFailure(error)) {
            retried = true
            reader.releaseLock()
            reader = (await retry()).getReader()
            const result = await reader.read()
            if (result.done) {
              controller.close()
              return
            }
            if (result.value.byteLength > 0) sawBytes = true
            controller.enqueue(result.value)
            return
          }
          controller.error(sawBytes ? new ModelConnectionLostError() : error)
        }
      },
      cancel: async (reason) => {
        await reader.cancel(reason)
      }
    })
  }

  private resolveWaiters(route: ModelProxyRoute): void {
    for (const waiter of [...this.waiters]) {
      this.removeWaiter(waiter)
      waiter.resolve(route)
    }
  }

  private removeWaiter(waiter: Waiter): void {
    this.waiters.delete(waiter)
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort)
  }
}
