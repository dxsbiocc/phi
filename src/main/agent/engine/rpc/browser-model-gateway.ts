import { timingSafeEqual } from 'node:crypto'
import type { BrowserTextVault } from '../../browser/browser-text-vault'
import type { ModelGatewayLease } from '../model-gateway-types'
import {
  createGatewayHttpListener,
  type GatewayHttpListener
} from '../in-process/model-gateway-http'
import { readGatewayJson } from '../in-process/model-gateway-request'
import { boundedGatewayStream, GATEWAY_STREAM_LIMITS } from '../in-process/model-gateway-stream'
import { assertBrowserHistoryPrivate, browserToolStreamProjector } from './browser-tool-stream'

export interface BrowserModelGatewayOptions {
  lease: ModelGatewayLease
  vault: BrowserTextVault
  signal: AbortSignal
  currentRunSignal(): AbortSignal | undefined
}
const unavailable = (): Response => new Response('Model request unavailable', { status: 502 })
/** Desktop-only model egress. Raw typeText bytes never enter the server SDK or its journal. */
export async function createBrowserModelGateway(
  options: BrowserModelGatewayOptions
): Promise<GatewayHttpListener> {
  const { lease } = options
  const requests = new Set<AbortController>()
  let retired = false
  const listener = await createGatewayHttpListener(
    (head) => {
      const url = new URL(head.url)
      if (
        retired ||
        options.signal.aborted ||
        head.method !== 'POST' ||
        url.pathname !== '/v1/pi/stream' ||
        url.search
      )
        return new Response('Model request unavailable', { status: 404 })
      const expected = Buffer.from(`Bearer ${lease.bearerToken}`)
      const actual = Buffer.from(head.headers.get('authorization') ?? '')
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
        return new Response('Model gateway authentication failed', { status: 401 })
      if (requests.size >= 4) return new Response('Model request unavailable', { status: 429 })
      if (head.headers.get('content-type')?.split(';', 1)[0].trim() !== 'application/json')
        return new Response('Invalid model request', { status: 400 })
      return undefined
    },
    async (request) => {
      const run = options.currentRunSignal()
      if (!run || run.aborted) return unavailable()
      const controller = new AbortController()
      requests.add(controller)
      const signal = AbortSignal.any([options.signal, request.signal, run, controller.signal])
      const abort = (): void => controller.abort(new Error('Browser model stream stopped'))
      signal.addEventListener('abort', abort, { once: true })
      let owns = false
      const finish = (): void => {
        requests.delete(controller)
        signal.removeEventListener('abort', abort)
      }
      try {
        signal.throwIfAborted()
        const payload = await readGatewayJson(request, signal)
        assertBrowserHistoryPrivate(payload)
        const modelId =
          payload && typeof payload === 'object' ? Reflect.get(payload, 'modelId') : undefined
        const model = lease.models.find((model) => `${model.provider}/${model.id}` === modelId)
        if (!model) return new Response('Invalid model request', { status: 400 })
        const response = await fetch(`http://127.0.0.1:${lease.localPort}/v1/pi/stream`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${lease.bearerToken}`
          },
          body: JSON.stringify(payload),
          signal,
          redirect: 'manual'
        })
        signal.throwIfAborted()
        if (!response.ok || !response.body || response.redirected) {
          await response.body?.cancel().catch(() => undefined)
          return unavailable()
        }
        const identity = { provider: model.provider, id: model.id, api: 'openai-completions' }
        const project = browserToolStreamProjector(options.vault, signal)
        const body = boundedGatewayStream(
          response.body,
          controller,
          identity,
          finish,
          GATEWAY_STREAM_LIMITS,
          (event) => {
            const message = event.message ?? event.error ?? event.partial
            if (
              message &&
              typeof message === 'object' &&
              typeof Reflect.get(message, 'api') === 'string'
            )
              identity.api = Reflect.get(message, 'api')
            return project(event)
          }
        )
        owns = true
        return new Response(body, {
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store'
          }
        })
      } catch {
        controller.abort()
        return unavailable()
      } finally {
        if (!owns) finish()
      }
    }
  )
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closing) return closing
    retired = true
    options.signal.removeEventListener('abort', abort)
    for (const controller of requests) controller.abort()
    options.vault.clear()
    return (closing = listener.close())
  }
  const abort = (): void => {
    void close().catch(() => undefined)
  }
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) {
    await close()
    options.signal.throwIfAborted()
  }
  return { port: listener.port, close }
}
