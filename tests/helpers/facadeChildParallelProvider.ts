import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ModelReply, ModelRequest } from './rpcHostResultModel'

export type ParallelModelReply = ModelReply & { tools?: NonNullable<ModelReply['tool']>[] }
export interface ParallelChildProvider {
  readonly url: string
  readonly requests: ModelRequest[]
  enqueue(...replies: ParallelModelReply[]): void
  close(): Promise<void>
}
/** A real bounded SSE provider; multiple model tool calls exercise the unmodified native scheduler. */
export async function startParallelChildProvider(): Promise<ParallelChildProvider> {
  const requests: ModelRequest[] = [],
    replies: ParallelModelReply[] = [],
    active = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions')
        throw new Error('Unexpected private provider route')
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk)
        length += bytes.length
        if (length > 2 * 1024 * 1024) throw new Error('Private provider request bound exceeded')
        chunks.push(bytes)
      }
      requests.push(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
      )
      const reply = replies.shift()
      if (!reply) throw new Error('No private provider reply remains')
      active.add(response)
      response.on('close', () => active.delete(response))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: unknown, finish: string | null = null): void => {
        response.write(
          `data: ${JSON.stringify({ id: `parallel-${requests.length}`, object: 'chat.completion.chunk', created: 0, model: 'private-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        )
      }
      chunk({ role: 'assistant', content: reply.text ?? '' })
      const tools = reply.tools ?? (reply.tool ? [reply.tool] : [])
      for (const [index, tool] of tools.entries()) {
        chunk({
          tool_calls: [
            {
              index,
              id: tool.id ?? `parallel-call-${index}`,
              type: 'function',
              function: { name: tool.name, arguments: '' }
            }
          ]
        })
        chunk({ tool_calls: [{ index, function: { arguments: JSON.stringify(tool.args) } }] })
      }
      if (reply.hold) return
      chunk({}, tools.length ? 'tool_calls' : 'stop')
      response.end('data: [DONE]\n\n')
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end('Private provider fixture failed')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    enqueue(...items) {
      replies.push(...items)
    },
    async close() {
      for (const response of active) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
