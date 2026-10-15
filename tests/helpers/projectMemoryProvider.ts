import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ModelReply, ModelRequest, startHostResultModel } from './rpcHostResultModel'

export type MemoryModelRequest = { project: 'A' | 'B'; phase: 'stage1' | 'stage2' }

/** Real SSE provider; memory side calls never consume an explicit user-turn reply. */
export async function startProjectMemoryModel(
  options: Parameters<typeof startHostResultModel>[0] = {}
): Promise<
  Awaited<ReturnType<typeof startHostResultModel>> & {
    memoryRequests: MemoryModelRequest[]
    holdProject(project: 'A' | 'B'): void
    heldClosed(project: 'A' | 'B'): number
  }
> {
  const requests: ModelRequest[] = []
  const memoryRequests: MemoryModelRequest[] = []
  const replies: ModelReply[] = []
  const active = new Set<ServerResponse>()
  const held = new Set<string>()
  const closed = new Map<string, number>()
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end('Unexpected memory provider endpoint')
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const payload = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      ) as ModelRequest
      requests.push(payload)
      const system = JSON.stringify(
        payload.messages.filter(
          (message) => message.role === 'system' || message.role === 'developer'
        )
      )
      // These are the pinned SDK18.10.3 system headers. JSON field names are not
      // purpose markers: the stage-two schema is carried in the user task.
      const phase = system.includes('Memory-stage-one extractor.')
        ? 'stage1'
        : system.includes('memory-stage-two consolidator.')
          ? 'stage2'
          : undefined
      const project = JSON.stringify(payload.messages).includes('PROJECT_B_FACT') ? 'B' : 'A'
      let reply: ModelReply | undefined
      let heldSummary = false
      if (phase) {
        memoryRequests.push({ project, phase })
        heldSummary = phase === 'stage2' && held.has(project)
        reply = {
          text: JSON.stringify(
            phase === 'stage1'
              ? {
                  raw_memory: 'PROJECT_' + project + '_FACT: outputs belong under results/.',
                  rollout_summary: 'PROJECT_' + project + '_FACT completed.',
                  rollout_slug: 'project_' + project.toLowerCase()
                }
              : {
                  memory_md: '# Project ' + project + '\nPROJECT_' + project + '_FACT',
                  memory_summary: 'PROJECT_' + project + '_SUMMARY: outputs belong under results/.',
                  skills: []
                }
          ),
          hold: heldSummary
        }
      } else reply = options?.replyFor?.(payload) ?? replies.shift()
      if (!reply) throw new Error('No scripted explicit model reply remains')
      active.add(response)
      response.once('close', () => {
        active.delete(response)
      })
      // Cancellation contracts host this provider in Node: Bun's node:http
      // POST/SSE shim does not reliably report client disconnects. Observe the
      // actual TCP socket rather than treating response cleanup as proof.
      request.socket.once('close', () => {
        active.delete(response)
        if (heldSummary && !response.writableEnded)
          closed.set(project, (closed.get(project) ?? 0) + 1)
      })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: unknown, finish: string | null = null): void => {
        response.write(
          `data: ${JSON.stringify({
            id: `memory-contract-${requests.length}`,
            object: 'chat.completion.chunk',
            created: 0,
            model: String(payload.model ?? 'contract-model'),
            choices: [{ index: 0, delta, finish_reason: finish }]
          })}\n\n`
        )
      }
      chunk({ role: 'assistant', content: '' })
      if (reply.text) chunk({ content: reply.text })
      if (reply.tool) {
        chunk({
          tool_calls: [
            {
              index: 0,
              id: reply.tool.id ?? 'contract-call',
              type: 'function',
              function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) }
            }
          ]
        })
      }
      if (reply.hold) return
      chunk({}, reply.tool ? 'tool_calls' : 'stop')
      response.end('data: [DONE]\n\n')
    } catch (error) {
      if (!response.headersSent) response.writeHead(500)
      response.end(String(error))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  let closing: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    memoryRequests,
    enqueue: (...items) => replies.push(...items),
    holdProject: (project) => {
      held.add(project)
    },
    heldClosed: (project) => closed.get(project) ?? 0,
    close: () =>
      (closing ??= (async () => {
        for (const response of active) response.destroy()
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      })())
  }
}
