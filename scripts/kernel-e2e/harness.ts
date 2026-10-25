import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { KernelProtocolClient } from '../../src/main/agent/engine/kernel-client'
import type { SafeModelDescriptor } from '../../src/main/agent/engine/model-gateway-types'
import type { JsonValue, KernelEventFrame } from '../../src/shared/kernel-protocol'

export const PROVIDER_ID = 'phi-kernel-e2e'
export const MODEL_ID = 'scripted-g1'
export const MODEL_DESCRIPTOR: SafeModelDescriptor = Object.freeze({
  provider: PROVIDER_ID,
  id: MODEL_ID,
  name: 'G1 scripted loopback',
  reasoning: false,
  input: Object.freeze(['text'] as const),
  contextWindow: 32768,
  maxTokens: 256,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
})

export interface ModelReply {
  text?: string
  tool?: { name: string; id: string; args: Record<string, unknown> }
}

interface ModelRequest {
  messages?: Array<Record<string, unknown>>
  context?: { messages?: Array<Record<string, unknown>> }
  modelId?: string
  tools?: unknown[]
}

function nativeReply(reply: ModelReply): string {
  const stopReason = reply.tool ? 'toolUse' : 'stop'
  const content = reply.tool
    ? [
        {
          type: 'toolCall',
          id: reply.tool.id,
          name: reply.tool.name,
          arguments: reply.tool.args
        }
      ]
    : [{ type: 'text', text: reply.text ?? '' }]
  return [
    `data: ${JSON.stringify({
      type: 'done',
      reason: stopReason,
      message: {
        role: 'assistant',
        api: 'openai-completions',
        provider: PROVIDER_ID,
        model: MODEL_ID,
        content,
        stopReason,
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      }
    })}\n\n`,
    'data: [DONE]\n\n'
  ].join('')
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function record(value: JsonValue | unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

export function bounded<T>(operation: Promise<T>, label: string, timeoutMs = 60_000): Promise<T> {
  return new Promise<T>((resolveOperation, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label} after ${timeoutMs} ms.`)),
      timeoutMs
    )
    operation.then(
      (value) => {
        clearTimeout(timeout)
        resolveOperation(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

export async function startLoopbackProvider(token: string): Promise<{
  url: string
  port: number
  requests: ModelRequest[]
  enqueue(...replies: ModelReply[]): void
  holdNextRequestBeforeResponse(): Promise<void>
  dropActiveConnections(): void
  completedRequestCount(): number
  close(): Promise<void>
}> {
  const requests: ModelRequest[] = []
  const replies: ModelReply[] = []
  const active = new Set<ServerResponse>()
  let completedRequests = 0
  let holdNextRequest = false
  let heldRequestReached: (() => void) | undefined
  const server = createServer(async (request, response) => {
    try {
      const native = request.url === '/v1/pi/stream'
      if (request.method !== 'POST' || (!native && request.url !== '/v1/chat/completions')) {
        response.writeHead(404).end('Unexpected test endpoint')
        return
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end('Invalid test bearer token')
        return
      }
      let body = ''
      for await (const chunk of request) body += chunk
      const parsed = JSON.parse(body) as ModelRequest
      requests.push(parsed)
      const messages = parsed.messages ?? parsed.context?.messages ?? []
      if (native && holdNextRequest) {
        holdNextRequest = false
        active.add(response)
        const closed = new Promise<void>((complete) => response.once('close', complete))
        response.on('close', () => active.delete(response))
        heldRequestReached?.()
        heldRequestReached = undefined
        await closed
        return
      }
      const taskAssessment =
        messages.length === 2 &&
        messages.some(
          (message) =>
            (message.role === 'system' || message.role === 'developer') &&
            typeof message.content === 'string' &&
            message.content.includes('Is this specialist suitable for the exact delegated task')
        ) &&
        (!Array.isArray(parsed.tools) || parsed.tools.length === 0)
      const reply = taskAssessment ? { text: 'suitable' } : replies.shift()
      if (!reply) {
        response.writeHead(500).end('No scripted reply remains')
        return
      }
      active.add(response)
      response.on('close', () => active.delete(response))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (native) {
        completedRequests++
        response.end(nativeReply(reply))
        return
      }
      const chunk = (delta: unknown, finishReason: string | null = null): void => {
        response.write(
          `data: ${JSON.stringify({
            id: `g1-${requests.length}`,
            object: 'chat.completion.chunk',
            created: 0,
            model: MODEL_ID,
            choices: [{ index: 0, delta, finish_reason: finishReason }]
          })}\n\n`
        )
      }
      chunk({ role: 'assistant', content: '' })
      if (reply.text) {
        const split = Math.max(1, Math.floor(reply.text.length / 2))
        chunk({ content: reply.text.slice(0, split) })
        chunk({ content: reply.text.slice(split) })
      }
      if (reply.tool) {
        chunk({
          tool_calls: [
            {
              index: 0,
              id: reply.tool.id,
              type: 'function',
              function: { name: reply.tool.name, arguments: '' }
            }
          ]
        })
        chunk({
          tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.tool.args) } }]
        })
      }
      chunk({}, reply.tool ? 'tool_calls' : 'stop')
      response.write('data: [DONE]\n\n')
      completedRequests++
      response.end()
    } catch (error) {
      if (!response.headersSent) response.writeHead(500)
      response.end(errorMessage(error))
    }
  })
  await new Promise<void>((complete, reject) => {
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('Timed out starting the loopback provider.'))
    }, 5_000)
    const finish = (action: () => void): void => {
      clearTimeout(timeout)
      server.off('error', onError)
      action()
    }
    const onError = (error: Error): void => finish(() => reject(error))
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => finish(complete))
  })
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    enqueue: (...items) => replies.push(...items),
    holdNextRequestBeforeResponse() {
      if (holdNextRequest || heldRequestReached) {
        throw new Error('A loopback provider request is already held')
      }
      holdNextRequest = true
      return new Promise<void>((complete) => {
        heldRequestReached = complete
      })
    },
    dropActiveConnections() {
      for (const response of active) response.destroy()
    },
    completedRequestCount: () => completedRequests,
    async close() {
      for (const response of active) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((complete) => server.close(() => complete()))
    }
  }
}

export function agentConfig(baseUrl: string, token: string): { models: string; config: string } {
  return {
    models: JSON.stringify({
      providers: {
        [PROVIDER_ID]: {
          baseUrl,
          apiKey: token,
          api: 'openai-completions',
          models: [
            {
              id: MODEL_DESCRIPTOR.id,
              name: MODEL_DESCRIPTOR.name,
              reasoning: MODEL_DESCRIPTOR.reasoning,
              input: [...MODEL_DESCRIPTOR.input],
              contextWindow: MODEL_DESCRIPTOR.contextWindow,
              maxTokens: MODEL_DESCRIPTOR.maxTokens,
              cost: MODEL_DESCRIPTOR.cost
            }
          ]
        }
      }
    }),
    config: JSON.stringify({
      compaction: { enabled: false, thresholdPercent: 80, thresholdTokens: -1 },
      mcp: { enableProjectConfig: false },
      defaultProvider: PROVIDER_ID,
      defaultModel: MODEL_ID
    })
  }
}

export class ScenarioClient {
  private readonly completions = new Map<string, { status: string; detail?: string }>()
  private readonly waiters = new Map<
    string,
    {
      complete(completion: { status: string; detail?: string }): void
      reject(error: Error): void
      timeout: NodeJS.Timeout
    }
  >()
  readonly events: KernelEventFrame[] = []
  private readonly stopEvents: () => void

  constructor(readonly client: KernelProtocolClient) {
    this.stopEvents = client.onEvent((event) => {
      this.events.push(event)
      if (event.type !== 'run.completed') return
      const payload = record(event.payload)
      if (typeof payload.runId !== 'string' || typeof payload.status !== 'string') return
      const completion = {
        status: payload.status,
        ...(typeof payload.detail === 'string' ? { detail: payload.detail } : {})
      }
      this.completions.set(payload.runId, completion)
      const waiter = this.waiters.get(payload.runId)
      if (waiter) {
        clearTimeout(waiter.timeout)
        waiter.complete(completion)
      }
      this.waiters.delete(payload.runId)
    })
  }

  get lastSeen(): number {
    return this.events.at(-1)?.seq ?? 0
  }

  async create(cwd: string, approval: boolean): Promise<string> {
    const result = record(
      await bounded(
        this.client.request('session.create', {
          cwd,
          model: { provider: PROVIDER_ID, id: MODEL_ID },
          sessionManager: { kind: 'memory' },
          enableToolApproval: approval,
          autoCompaction: { enabled: false },
          resourceOptions: {
            noExtensions: true,
            noSkills: true,
            noContextFiles: true,
            noPromptTemplates: true,
            noThemes: true
          }
        }),
        'session.create'
      )
    )
    const sessionId = result.sessionId
    if (typeof sessionId !== 'string') throw new TypeError('Kernel create result omitted sessionId')
    return sessionId
  }

  async prompt(sessionId: string, text: string): Promise<{ runId: string; status: string }> {
    const runId = await this.startPrompt(sessionId, text)
    const completion = await this.waitForRun(runId)
    return { runId, status: completion.status }
  }

  async startPrompt(sessionId: string, text: string): Promise<string> {
    const result = record(
      await bounded(
        this.client.request('session.prompt', { text }, { sessionId }),
        'session.prompt acceptance'
      )
    )
    const runId = result.runId
    if (typeof runId !== 'string') throw new TypeError('Kernel prompt result omitted runId')
    return runId
  }

  async snapshot(sessionId: string): Promise<Record<string, unknown>> {
    return record(
      await bounded(this.client.request('session.snapshot', {}, { sessionId }), 'session.snapshot')
    )
  }

  hasCompleted(runId: string): boolean {
    return this.completions.has(runId)
  }

  waitForRun(runId: string): Promise<{ status: string; detail?: string }> {
    const completion = this.completions.get(runId)
    if (completion) return Promise.resolve(completion)
    return new Promise((complete, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(runId)
        reject(new Error(`Timed out waiting for kernel run ${runId}.`))
      }, 60_000)
      this.waiters.set(runId, { complete, reject, timeout })
    })
  }

  close(): void {
    this.stopEvents()
    for (const [runId, waiter] of this.waiters) {
      clearTimeout(waiter.timeout)
      waiter.reject(new Error(`Kernel scenario closed while waiting for run ${runId}.`))
    }
    this.waiters.clear()
  }
}
