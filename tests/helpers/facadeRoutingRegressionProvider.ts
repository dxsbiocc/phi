import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** Scripted localhost vendor only; the real SDK still owns parsing, streaming and cancellation. */
export async function facadeRegressionProvider(): Promise<{
  url: string
  requests: unknown[]
  enqueue(text: string, hold?: boolean): void
  enqueueStreamError(text: string): void
  releaseHeld(): void
  close(): Promise<void>
}> {
  const replies: Array<{ text: string; hold: boolean; finishReason?: 'error'; thinking?: string }> =
    []
  const requests: unknown[] = []
  const active = new Set<ServerResponse>()
  const held = new Map<ServerResponse, () => void>()
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const reply = replies.shift()
    if (!reply) {
      response.writeHead(500).end('Missing synthetic reply')
      return
    }
    active.add(response)
    response.on('close', () => {
      active.delete(response)
      held.delete(response)
    })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta: unknown, finish: string | null = null): void => {
      response.write(
        `data: ${JSON.stringify({ id: `regression-${requests.length}`, object: 'chat.completion.chunk', created: 0, model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      )
    }
    const finish = (): void => {
      held.delete(response)
      chunk({}, reply.finishReason ?? 'stop')
      response.end('data: [DONE]\n\n')
    }
    chunk({
      role: 'assistant',
      ...(reply.thinking ? { reasoning_content: reply.thinking } : { content: reply.text })
    })
    if (reply.hold) held.set(response, finish)
    else finish()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    enqueue(text, hold = false) {
      replies.push({ text, hold })
    },
    enqueueStreamError(text) {
      replies.push({ text: '', thinking: text, hold: false, finishReason: 'error' })
    },
    releaseHeld() {
      for (const finish of [...held.values()]) finish()
    },
    async close() {
      for (const response of active) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
