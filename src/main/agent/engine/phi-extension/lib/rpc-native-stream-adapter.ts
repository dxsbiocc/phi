import { AssistantMessageEventStream } from '@oh-my-pi/pi-ai/utils/event-stream'
import type { StreamFn } from '@oh-my-pi/pi-agent-core'
import type { AssistantMessageEvent, FetchImpl } from '@oh-my-pi/pi-ai'
import {
  integrity,
  NativeSseCapture,
  NativeStreamIntegrityError,
  NATIVE_EVENT_BYTES
} from './rpc-native-sse'
import { repairNativeTerminal } from './rpc-native-repair'
import { projectNativeWireBody } from './rpc-native-wire'

export interface TrustedNativeStreamScope {
  readonly generation: number
  /** Exact native POST URL from the owned lease, including its base path. */
  readonly endpoint: string
  readonly models: readonly { readonly provider: string; readonly id: string }[]
  readonly signal?: AbortSignal
  isActive(): boolean
}
function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError')
}
function untilAbort<T>(promise: PromiseLike<T>, signal: AbortSignal, graceMs = 0): Promise<T> {
  const source = Promise.resolve(promise)
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = (): void => {
      if (graceMs) timer ??= setTimeout(() => reject(abortError()), graceMs)
      else reject(abortError())
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    // Observe late rejection even when cancellation already won the race.
    source.then(resolve, reject).finally(() => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    })
  })
}
export function validateNativeStreamScope(scope: TrustedNativeStreamScope): void {
  integrity(
    Number.isSafeInteger(scope.generation) &&
      scope.generation > 0 &&
      typeof scope.isActive === 'function'
  )
  integrity(typeof scope.endpoint === 'string')
  let url: URL
  try {
    url = new URL(scope.endpoint)
  } catch {
    throw new NativeStreamIntegrityError()
  }
  integrity(
    ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.endsWith('/v1/pi/stream') &&
      url.href === scope.endpoint
  )
  integrity(Array.isArray(scope.models) && scope.models.length > 0 && scope.models.length <= 4096)
  const seen = new Set<string>()
  for (const model of scope.models) {
    integrity(
      typeof model.provider === 'string' &&
        model.provider.length > 0 &&
        model.provider.length <= 256 &&
        typeof model.id === 'string' &&
        model.id.length > 0 &&
        model.id.length <= 256
    )
    const key = JSON.stringify([model.provider, model.id])
    integrity(!seen.has(key))
    seen.add(key)
  }
}

/** Preserve the real SDK wrapper; observe only the exact owned native transport. */
export function createNativeStreamIntegrityAdapter(
  original: StreamFn,
  supplied: TrustedNativeStreamScope
): StreamFn {
  validateNativeStreamScope(supplied)
  const scope = Object.freeze({
    ...supplied,
    models: Object.freeze(supplied.models.map((model) => Object.freeze({ ...model })))
  })
  const approved = new Set(scope.models.map((model) => JSON.stringify([model.provider, model.id])))
  return (model, context, options) => {
    if (model.transport !== 'pi-native') return original(model, context, options)
    const out = new AssistantMessageEventStream()
    const controller = new AbortController()
    let capture = new NativeSseCapture()
    const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>()
    const removals: Array<() => void> = []
    let captureError: Error | undefined
    let fetching = false
    const stop = (): void => {
      controller.abort()
      for (const reader of readers) void reader.cancel().catch(() => undefined)
    }
    for (const signal of new Set(
      [scope.signal, options?.signal].filter((item): item is AbortSignal => Boolean(item))
    )) {
      const abort = (): void => {
        stop()
      }
      signal.addEventListener('abort', abort, { once: true })
      removals.push(() => signal.removeEventListener('abort', abort))
      if (signal.aborted) abort()
    }
    const active = (): void => {
      if (controller.signal.aborted) throw abortError()
      integrity(scope.isActive() && !scope.signal?.aborted)
    }
    const push = (event: AssistantMessageEvent): void => {
      // Native snapshots are already bounded upstream. Bound this extra queue too.
      const queued = out.queue.filter(Boolean)
      integrity(queued.length < 256)
      let bytes = Buffer.byteLength(JSON.stringify(event))
      integrity(bytes <= NATIVE_EVENT_BYTES)
      for (const entry of queued) {
        bytes += Buffer.byteLength(JSON.stringify(entry))
        integrity(bytes <= NATIVE_EVENT_BYTES)
      }
      out.push(event)
    }
    const selectedFetch = options?.fetch ?? globalThis.fetch
    const tappedFetch: FetchImpl = new Proxy(selectedFetch, {
      apply(target, receiver, args: Parameters<FetchImpl>) {
        return (async (): Promise<Response> => {
          active()
          const [input, init] = args
          const url = input instanceof Request ? input.url : String(input)
          integrity(
            url === scope.endpoint &&
              (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() ===
                'POST' &&
              !fetching
          )
          const requestBody = projectNativeWireBody(init?.body, `${model.provider}/${model.id}`)
          let requestHeaders = init?.headers
          const declaredHeaders = new Headers(
            init?.headers ?? (input instanceof Request ? input.headers : undefined)
          )
          if (declaredHeaders.has('content-length')) {
            // Derive the projected body's length without changing ordinary
            // header objects or the gateway's actual Authorization header.
            declaredHeaders.delete('content-length')
            requestHeaders = declaredHeaders
          }
          fetching = true
          const requestCapture = new NativeSseCapture()
          capture.clear()
          capture = requestCapture
          captureError = undefined
          for (const reader of readers) void reader.cancel().catch(() => undefined)
          const fetchSignals = [
            controller.signal,
            init?.signal,
            input instanceof Request ? input.signal : undefined
          ].filter((item): item is AbortSignal => Boolean(item))
          const requestSignal = AbortSignal.any(fetchSignals)
          let response: Response
          try {
            const acquisition = Promise.resolve(
              Reflect.apply(target, receiver, [
                input,
                {
                  ...init,
                  body: requestBody,
                  headers: requestHeaders,
                  redirect: 'manual',
                  signal: requestSignal
                }
              ]) as Promise<Response>
            )
            void acquisition.then(
              (late) => {
                if (requestSignal.aborted || !scope.isActive())
                  void late.body?.cancel().catch(() => undefined)
              },
              () => undefined
            )
            response = await untilAbort(acquisition, requestSignal)
          } finally {
            fetching = false
          }
          if (controller.signal.aborted || !scope.isActive()) {
            void response.body?.cancel().catch(() => undefined)
            active()
          }
          integrity(!response.redirected && (!response.url || response.url === scope.endpoint))
          if (!response.ok || !response.body) return response
          integrity(
            /^text\/event-stream(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')
          )
          const reader = response.body.getReader()
          readers.add(reader)
          const requestAbort = (): void => {
            void reader.cancel().catch(() => undefined)
          }
          requestSignal.addEventListener('abort', requestAbort, { once: true })
          let released = false
          const release = (): void => {
            if (!released) {
              released = true
              readers.delete(reader)
              requestSignal.removeEventListener('abort', requestAbort)
              reader.releaseLock()
            }
          }
          const body = new ReadableStream<Uint8Array>({
            async pull(sink) {
              try {
                active()
                if (requestSignal.aborted) throw abortError()
                const next = await untilAbort(reader.read(), controller.signal)
                active()
                if (requestSignal.aborted) throw abortError()
                if (next.done) {
                  requestCapture.finish()
                  release()
                  sink.close()
                  return
                }
                requestCapture.feed(next.value)
                const terminal = requestCapture.rawTerminal
                if (terminal?.type === 'done' || terminal?.type === 'error') {
                  const message = terminal.type === 'done' ? terminal.message : terminal.error
                  integrity(message.provider === model.provider && message.model === model.id)
                }
                sink.enqueue(next.value)
              } catch (error) {
                if (error instanceof NativeStreamIntegrityError && capture === requestCapture)
                  captureError = error
                void reader.cancel().catch(() => undefined)
                release()
                sink.error(error)
              }
            },
            async cancel(reason) {
              try {
                await reader.cancel(reason)
              } finally {
                release()
              }
            }
          })
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          })
        })()
      }
    })
    void (async () => {
      let iterator: AsyncIterator<AssistantMessageEvent> | undefined
      try {
        active()
        integrity(
          approved.has(JSON.stringify([model.provider, model.id])) &&
            typeof model.baseUrl === 'string' &&
            model.baseUrl.replace(/\/+$/u, '') + '/v1/pi/stream' === scope.endpoint
        )
        const inner = await untilAbort(
          Promise.resolve(
            original(model, context, { ...options, signal: controller.signal, fetch: tappedFetch })
          ),
          controller.signal
        )
        out.forwardLocalWorkFrom(inner)
        iterator = inner[Symbol.asyncIterator]()
        let terminal = false
        while (true) {
          const next = await untilAbort(Promise.resolve(iterator.next()), controller.signal, 500)
          if (next.done) break
          const event = next.value
          if (controller.signal.aborted && event.type === 'error') {
            push(event)
            terminal = true
            break
          }
          active()
          if (captureError) throw captureError
          if (event.type === 'done' || event.type === 'error') terminal = true
          if (event.type === 'done') {
            integrity(capture.rawTerminal?.type === 'done')
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              await untilAbort(
                Promise.race([
                  capture.completed,
                  new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new NativeStreamIntegrityError()), 1000)
                  })
                ]),
                controller.signal
              )
              active()
              push(repairNativeTerminal(event, capture, model))
            } finally {
              if (timer) clearTimeout(timer)
            }
          } else push(event)
        }
        if (!terminal) out.end(await untilAbort(inner.result(), controller.signal))
      } catch (error) {
        out.fail(error)
      } finally {
        stop()
        for (const remove of removals) remove()
        if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => undefined)
        out.forwardLocalWorkFrom(undefined)
        capture.clear()
      }
    })()
    return out
  }
}
