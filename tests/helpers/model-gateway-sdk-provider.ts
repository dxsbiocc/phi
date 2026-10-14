import { readFile } from 'node:fs/promises'
import { createServer, type RequestListener, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { GatewayFixtureReply, GatewayFixtureSnapshot } from './model-gateway-sdk-fixture'

/** Standard Node HTTP owns the fake provider so disconnect observations are physical. */
export async function startGatewayFixtureProvider(options: {
  errorSentinel: string
  certificate?: string
  key?: string
}): Promise<{
  url: string
  enqueue(...replies: GatewayFixtureReply[]): void
  snapshot(): Pick<GatewayFixtureSnapshot, 'providerRequests' | 'activeProviderStreams'>
  resetStats(): void
  close(): Promise<void>
}> {
  const stats: Pick<GatewayFixtureSnapshot, 'providerRequests'> = { providerRequests: [] }
  const replies: GatewayFixtureReply[] = []
  const active = new Set<ServerResponse>()
  const handleProvider: RequestListener = async (request, response) => {
    try {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end('Unexpected private provider endpoint')
        return
      }
      request.setEncoding('utf8')
      let raw = ''
      for await (const chunk of request) {
        raw += chunk
        if (raw.length > 4 * 1024 * 1024) throw new Error('Private provider input too large')
      }
      const body = JSON.parse(raw) as Record<string, unknown>
      stats.providerRequests.push({ path: request.url, headers: { ...request.headers }, body })
      const reply = replies.shift() ?? { text: 'fixture reply' }
      if (reply.redirect) {
        response.writeHead(reply.status ?? 307, { location: reply.redirect }).end()
        return
      }
      if (reply.status && reply.status !== 200) {
        response.writeHead(reply.status, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: { message: reply.error ?? options.errorSentinel, type: 'authentication_error' }
          })
        )
        return
      }
      active.add(response)
      response.on('close', () => active.delete(response))
      request.socket.once('close', () => active.delete(response))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: unknown, finish: string | null = null): void => {
        response.write(
          `data: ${JSON.stringify({
            id: `fixture-${stats.providerRequests.length}`,
            object: 'chat.completion.chunk',
            created: 0,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }]
          })}\n\n`
        )
      }
      chunk({ role: 'assistant', content: '' })
      if (reply.thinking) chunk({ reasoning_content: reply.thinking })
      if (reply.text) {
        const size = reply.textChunkChars ?? reply.text.length
        if (!Number.isSafeInteger(size) || size < 1)
          throw new Error('Invalid private fixture text chunk size')
        for (let offset = 0; offset < reply.text.length; offset += size)
          chunk({ content: reply.text.slice(offset, offset + size) })
      }
      if (reply.tool) {
        chunk({
          tool_calls: [
            {
              index: 0,
              id: reply.tool.id ?? 'fixture-call',
              type: 'function',
              function: { name: reply.tool.name, arguments: '' }
            }
          ]
        })
        chunk({
          tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.tool.args) } }]
        })
      }
      if (reply.hold) return
      chunk({}, reply.finishReason ?? (reply.tool ? 'tool_calls' : 'stop'))
      response.end('data: [DONE]\n\n')
    } catch {
      if (!response.headersSent) response.writeHead(500)
      response.end('Private provider failed')
    }
  }

  const server =
    options.certificate && options.key
      ? createHttpsServer(
          { key: await readFile(options.key), cert: await readFile(options.certificate) },
          handleProvider
        )
      : createServer(handleProvider)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: `${options.certificate ? 'https' : 'http'}://127.0.0.1:${(server.address() as AddressInfo).port}`,
    enqueue: (...items) => replies.push(...items),
    snapshot: () => ({
      providerRequests: structuredClone(stats.providerRequests),
      activeProviderStreams: active.size
    }),
    resetStats: () => {
      stats.providerRequests = []
    },
    close: async () => {
      for (const response of active) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
