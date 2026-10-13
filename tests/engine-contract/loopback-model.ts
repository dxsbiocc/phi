import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type ModelReply = {
  text?: string
  /** Optional bounded SSE deltas for large RPC framing contracts; ordinary replies keep two chunks. */
  textChunkChars?: number
  tool?: { name: string; args: Record<string, unknown>; id?: string }
  hold?: boolean
}
export type ModelRequest = { messages: Array<Record<string, unknown>>; [key: string]: unknown }

/** A provider, not an engine stub: the real SDK parses these streaming chunks. */
export async function startLoopbackModel(): Promise<{
  url: string
  requests: ModelRequest[]
  enqueue(...replies: ModelReply[]): void
  close(): Promise<void>
}> {
  const requests: ModelRequest[] = []
  const replies: ModelReply[] = []
  const active = new Set<ServerResponse>()
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end('Unexpected model endpoint')
        return
      }
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push(JSON.parse(body) as ModelRequest)
      const reply = replies.shift()
      if (!reply) {
        response.writeHead(500).end('No scripted model reply remains')
        return
      }
      active.add(response)
      response.on('close', () => active.delete(response))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: unknown, finish: string | null = null): void => {
        response.write(
          `data: ${JSON.stringify({
            id: `contract-${requests.length}`,
            object: 'chat.completion.chunk',
            created: 0,
            model: 'contract-model',
            choices: [{ index: 0, delta, finish_reason: finish }]
          })}\n\n`
        )
      }
      chunk({ role: 'assistant', content: '' })
      if (reply.text) {
        if (reply.textChunkChars === undefined) {
          const split = Math.max(1, Math.floor(reply.text.length / 2))
          chunk({ content: reply.text.slice(0, split) })
          chunk({ content: reply.text.slice(split) })
        } else {
          if (!Number.isInteger(reply.textChunkChars) || reply.textChunkChars <= 0) {
            throw new Error('textChunkChars must be a positive integer')
          }
          for (let offset = 0; offset < reply.text.length; offset += reply.textChunkChars) {
            chunk({ content: reply.text.slice(offset, offset + reply.textChunkChars) })
          }
        }
      }
      if (reply.tool) {
        chunk({
          tool_calls: [
            {
              index: 0,
              id: reply.tool.id ?? `call-${requests.length}`,
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
      chunk({}, reply.tool ? 'tool_calls' : 'stop')
      response.write('data: [DONE]\n\n')
      response.end()
    } catch (error) {
      response.writeHead(500).end(String(error))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    enqueue: (...items) => replies.push(...items),
    async close(): Promise<void> {
      for (const response of active) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
