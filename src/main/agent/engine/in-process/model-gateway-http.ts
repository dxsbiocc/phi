import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'

export interface GatewayRequestHead {
  readonly method: string
  readonly url: string
  readonly headers: Headers
}
export interface GatewayHttpListener {
  readonly port: number
  close(): Promise<void>
}

function waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      response.off('drain', drained)
      response.off('close', stopped)
      response.off('error', stopped)
      signal.removeEventListener('abort', stopped)
    }
    const drained = (): void => {
      cleanup()
      resolve()
    }
    const stopped = (): void => {
      cleanup()
      reject(new Error('Model gateway client stopped'))
    }
    response.once('drain', drained)
    response.once('close', stopped)
    response.once('error', stopped)
    signal.addEventListener('abort', stopped, { once: true })
    if (signal.aborted || response.destroyed) stopped()
  })
}

async function sendResponse(
  response: Response,
  outgoing: ServerResponse,
  signal: AbortSignal
): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers))
  if (!response.body) {
    outgoing.end()
    return
  }
  const reader = response.body.getReader()
  // The SDK producer is drained by the bounded stream. This consumer stops
  // reading at actual writable backpressure instead of moving its queue into
  // Bun1.3.14's unbounded fetch Response/uWS pipe.
  void reader.closed.catch(() => undefined)
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) return
    while (!signal.aborted) {
      const next = await reader.read()
      if (next.done || signal.aborted) break
      if (!outgoing.write(next.value)) await waitForDrain(outgoing, signal)
    }
    if (!signal.aborted) outgoing.end()
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function requestBody(incoming: IncomingMessage): ReadableStream<Uint8Array> {
  // Node and DOM stream types differ; bridge through their public reader
  // instead of installing Bun globals or asserting two incompatible types.
  const reader = Readable.toWeb(incoming).getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read()
      if (next.done) {
        reader.releaseLock()
        controller.close()
      } else if (next.value instanceof Uint8Array) controller.enqueue(next.value)
      else controller.error(new Error('Invalid model request body'))
    },
    async cancel() {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  })
}

function requestHead(incoming: IncomingMessage): GatewayRequestHead {
  const headers = new Headers()
  for (let index = 0; index < incoming.rawHeaders.length; index += 2)
    headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1])
  return {
    method: incoming.method ?? '',
    // Host cannot affect routing, provider identity or the internal Request.
    url: new URL(incoming.url ?? '/', 'http://phi.gateway').href,
    headers
  }
}

/** Node writable/drain has verified socket backpressure in the pinned Bun. */
export async function createGatewayHttpListener(
  admit: (head: GatewayRequestHead) => Response | undefined,
  handle: (request: Request) => Promise<Response>
): Promise<GatewayHttpListener> {
  const requests = new Set<AbortController>()
  const server = createServer((incoming, outgoing) => {
    const controller = new AbortController()
    requests.add(controller)
    const abort = (): void => {
      if (!outgoing.writableFinished) controller.abort()
    }
    incoming.once('aborted', abort)
    incoming.once('error', abort)
    incoming.socket.once('close', abort)
    outgoing.once('close', abort)
    outgoing.on('error', abort)
    // Pinned Bun1.3.14 omits Node close/aborted after a fully consumed POST.
    // Its public address() reflects the native handle being cleared on EOF.
    // Observe only while this response is active; never infer EOF from an
    // empty writable queue or the consumed IncomingMessage.destroyed flag.
    const peer = incoming.socket
    const disconnected = setInterval(() => {
      if (!outgoing.writableFinished && peer.address() === null) {
        controller.abort()
        outgoing.destroy()
      }
    }, 25)
    disconnected.unref()
    const run = async (): Promise<void> => {
      const head = requestHead(incoming)
      const rejected = admit(head)
      if (rejected) {
        // Do not read an unauthenticated body, including chunked bodies. Close
        // after the fixed response rather than keeping a draining connection.
        outgoing.setHeader('connection', 'close')
        await sendResponse(rejected, outgoing, controller.signal)
        return
      }
      const request = new Request(head.url, {
        method: head.method,
        headers: head.headers,
        body: requestBody(incoming),
        signal: controller.signal,
        ...{ duplex: 'half' }
      })
      await sendResponse(await handle(request), outgoing, controller.signal)
    }
    void run()
      .catch(() => {
        controller.abort()
        if (!outgoing.headersSent && !outgoing.destroyed)
          outgoing.writeHead(500, { 'content-type': 'text/plain' }).end('Model gateway unavailable')
        else outgoing.destroy()
      })
      .finally(() => {
        clearInterval(disconnected)
        requests.delete(controller)
        incoming.off('aborted', abort)
        incoming.off('error', abort)
        incoming.socket.off('close', abort)
        outgoing.off('close', abort)
        // Keep the local error handler through final asynchronous HTTP flush.
        outgoing.once('close', () => outgoing.off('error', abort))
      })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (): void => reject(new Error('Model gateway listener could not bind'))
      server.once('error', failed)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', failed)
        resolve()
      })
    })
  } catch {
    server.close()
    throw new Error('Model gateway listener could not bind')
  }
  let closing: Promise<void> | undefined
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      (closing ??= (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined
        for (const request of requests) request.abort()
        // The pinned runtime can omit socket.close for completed POSTs; do not
        // retain a second socket registry that depends on those missing events.
        server.closeAllConnections()
        // Bun1.3.14 also stops listening here; Node keeps its listener open.
        if (!server.listening) return
        try {
          await Promise.race([
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()))
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Model gateway listener cleanup timed out')),
                5000
              )
            })
          ])
        } catch {
          throw new Error('Model gateway listener cleanup failed')
        } finally {
          clearTimeout(timer)
        }
      })())
  }
}
