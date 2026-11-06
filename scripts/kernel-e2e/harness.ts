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

const PLAN_STEP_AGENT = {
  name: 'PlanStep',
  description: 'Executes one approved plan step.',
  tools: ['read', 'write', 'edit', 'grep', 'glob', 'bash'],
  skills: [],
  invocation: 'host' as const,
  visibility: 'entry' as const,
  warnings: [],
  systemPrompt: 'Execute exactly the assigned plan step and return a concise report.',
  source: 'phi' as const,
  filePath: '/phi/bundled/agents/PlanStep.md'
}

export interface ModelReply {
  /** Optional latest-user-message discriminator for concurrent scripted sessions. */
  match?: string
  /** Optional test gate that keeps this matching model request in flight until released. */
  gate?: string
  text?: string
  tool?: { name: string; id: string; args: Record<string, unknown> }
}

export interface ModelRequest {
  messages?: Array<Record<string, unknown>>
  context?: { messages?: Array<Record<string, unknown>> }
  modelId?: string
  tools?: unknown[]
}

function requestText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(requestText).join('\n')
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  return typeof record.text === 'string' ? record.text : requestText(record.content)
}

function latestUserText(messages: Array<Record<string, unknown>>): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'user') return requestText(message.content)
  }
  return ''
}

/** The full pi-native event sequence the desktop gateway streams (start, block events, done). */
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
  const message = {
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
  const events: unknown[] = [{ type: 'start', partial: { ...message, content: [] } }]
  if (reply.tool) {
    const toolCall = content[0]
    events.push(
      { type: 'toolcall_start', contentIndex: 0, partial: message },
      {
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: JSON.stringify(reply.tool.args),
        partial: message
      },
      { type: 'toolcall_end', contentIndex: 0, toolCall, partial: message }
    )
  } else {
    const text = reply.text ?? ''
    events.push(
      { type: 'text_start', contentIndex: 0, partial: message },
      { type: 'text_delta', contentIndex: 0, delta: text, partial: message },
      { type: 'text_end', contentIndex: 0, content: text, partial: message }
    )
  }
  events.push({ type: 'done', reason: stopReason, message })
  return [...events.map((event) => `data: ${JSON.stringify(event)}\n\n`), 'data: [DONE]\n\n'].join(
    ''
  )
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function record(value: JsonValue | unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

/** One model turn over a slow VPN link (~6-8 s per round trip) with several tool calls. */
export const RUN_WAIT_MS = 4 * 60_000

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

export function boundedByDeadline<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs: number,
  overallDeadlineAt: number
): Promise<T> {
  const remainingMs = Math.max(0, overallDeadlineAt - Date.now())
  const overallExpiresFirst = remainingMs <= timeoutMs
  const effectiveTimeoutMs = Math.max(0, Math.min(timeoutMs, remainingMs))
  return new Promise<T>((resolveOperation, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          overallExpiresFirst
            ? `Overall kernel E2E deadline expired during "${label}".`
            : `Step "${label}" timed out after ${timeoutMs} ms.`
        )
      )
    }, effectiveTimeoutMs)
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
  waitForGate(name: string): Promise<void>
  releaseGate(name: string): void
  holdNextRequestBeforeResponse(): Promise<void>
  dropActiveConnections(): void
  completedRequestCount(): number
  close(): Promise<void>
}> {
  const requests: ModelRequest[] = []
  const replies: ModelReply[] = []
  const active = new Set<ServerResponse>()
  type LoopbackGate = {
    reached: Promise<void>
    markReached(): void
    released: Promise<void>
    release(): void
  }
  const gates = new Map<string, LoopbackGate>()
  const gateFor = (name: string): LoopbackGate => {
    let gate = gates.get(name)
    if (gate) return gate
    const reached = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    gate = {
      reached: reached.promise,
      markReached: reached.resolve,
      released: released.promise,
      release: released.resolve
    }
    gates.set(name, gate)
    return gate
  }
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
      let reply: ModelReply | undefined
      if (taskAssessment) {
        reply = { text: 'suitable' }
      } else {
        const latest = latestUserText(messages)
        let index = replies.findIndex(
          (candidate) => !candidate.match || latest.includes(candidate.match)
        )
        if (index < 0) {
          const all = requestText(messages)
          index = replies.findIndex((candidate) =>
            Boolean(candidate.match && all.includes(candidate.match))
          )
        }
        if (index >= 0) reply = replies.splice(index, 1)[0]
      }
      if (!reply) {
        response.writeHead(500).end('No matching scripted reply remains')
        return
      }
      if (reply.gate) {
        const gate = gateFor(reply.gate)
        gate.markReached()
        await gate.released
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
    waitForGate: (name) => gateFor(name).reached,
    releaseGate(name) {
      gateFor(name).release()
    },
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
      for (const gate of gates.values()) gate.release()
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

  async create(
    cwd: string,
    approval: boolean,
    options: {
      workMode?: 'direct' | 'plan' | 'plan_execute' | 'auto'
      phiAgents?: JsonValue[]
      sessionManager?: JsonValue
    } = {}
  ): Promise<string> {
    const result = record(
      await bounded(
        this.client.request('session.create', {
          cwd,
          model: { provider: PROVIDER_ID, id: MODEL_ID },
          sessionManager: options.sessionManager ?? { kind: 'memory' },
          enableToolApproval: approval,
          workMode: options.workMode ?? 'direct',
          phiAgents: [PLAN_STEP_AGENT],
          autoCompaction: { enabled: false },
          resourceOptions: {
            noExtensions: true,
            noSkills: true,
            noContextFiles: true,
            noPromptTemplates: true,
            noThemes: true
          },
          ...(options.phiAgents ? { phiAgents: options.phiAgents } : {})
        }),
        'session.create'
      )
    )
    const sessionId = result.sessionId
    if (typeof sessionId !== 'string') throw new TypeError('Kernel create result omitted sessionId')
    return sessionId
  }

  async prompt(
    sessionId: string,
    text: string
  ): Promise<{ runId: string; status: string; detail?: string }> {
    const runId = await this.startPrompt(sessionId, text)
    const completion = await this.waitForRun(runId)
    return { runId, ...completion }
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
      }, RUN_WAIT_MS)
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
