import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export const VENDOR_REFS = {
  anthropicKey: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
  anthropicOAuth: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
  responses: { provider: 'phi-parity-responses', id: 'responses-parity' },
  codex: { provider: 'openai-codex', id: 'gpt-5.4' }
} as const
export type VendorKind = keyof typeof VENDOR_REFS
export const VENDOR_SECRETS = {
  key: 'synthetic-parity-desktop-api-key',
  oauth: 'sk-ant-oat01-synthetic-parity-access',
  refresh: 'synthetic-parity-refresh-token',
  error: 'synthetic-private-provider-error',
  thinking: 'opaque-thinking-signature',
  redacted: 'opaque-redacted-thinking',
  encrypted: 'opaque-encrypted-reasoning'
} as const
export interface VendorReply {
  tool?: boolean
  hold?: boolean
  status?: number
  text?: string
}
export interface VendorRequest {
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Record<string, unknown>
}

function anthropicEvents(body: Record<string, unknown>, reply: VendorReply): unknown[] {
  const tools = body.tools as Array<{ name: string }> | undefined
  const name = tools?.find((tool) => /inspect$/i.test(tool.name))?.name ?? 'inspect'
  const events: unknown[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_parity',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 }
      }
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Inspect the ordinary fixture' }
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: VENDOR_SECRETS.thinking }
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'redacted_thinking', data: VENDOR_SECRETS.redacted }
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: reply.text ?? 'Vendor text 中文🙂' }
    },
    { type: 'content_block_stop', index: 2 }
  ]
  if (reply.tool)
    events.push(
      {
        type: 'content_block_start',
        index: 3,
        content_block: { type: 'tool_use', id: 'call_parity', name, input: {} }
      },
      {
        type: 'content_block_delta',
        index: 3,
        delta: { type: 'input_json_delta', partial_json: '{"path":"ordinary.txt"}' }
      },
      { type: 'content_block_stop', index: 3 }
    )
  if (!reply.hold)
    events.push(
      {
        type: 'message_delta',
        delta: { stop_reason: reply.tool ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 12 }
      },
      { type: 'message_stop' }
    )
  return events
}

function responsesEvents(body: Record<string, unknown>, reply: VendorReply): unknown[] {
  const reason = {
    type: 'reasoning',
    id: 'rs_parity',
    summary: [{ type: 'summary_text', text: 'Inspect the ordinary fixture' }],
    encrypted_content: VENDOR_SECRETS.encrypted
  }
  const message = {
    type: 'message',
    id: 'msg_parity',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: reply.text ?? 'Vendor text 中文🙂', annotations: [] }]
  }
  const call = {
    type: 'function_call',
    id: 'fc_parity',
    call_id: 'call_parity',
    name: 'inspect',
    arguments: '{"path":"ordinary.txt"}',
    status: 'completed'
  }
  const output = reply.tool ? [reason, message, call] : [reason, message]
  const events: unknown[] = [
    {
      type: 'response.created',
      response: { id: 'resp_parity', status: 'in_progress', output: [] }
    },
    { type: 'response.output_item.added', output_index: 0, item: { ...reason, summary: [] } },
    {
      type: 'response.reasoning_summary_part.added',
      item_id: reason.id,
      output_index: 0,
      summary_index: 0,
      part: { type: 'summary_text', text: '' }
    },
    {
      type: 'response.reasoning_summary_text.delta',
      item_id: reason.id,
      output_index: 0,
      summary_index: 0,
      delta: reason.summary[0].text
    },
    {
      type: 'response.reasoning_summary_text.done',
      item_id: reason.id,
      output_index: 0,
      summary_index: 0,
      text: reason.summary[0].text
    },
    {
      type: 'response.reasoning_summary_part.done',
      item_id: reason.id,
      output_index: 0,
      summary_index: 0,
      part: reason.summary[0]
    },
    { type: 'response.output_item.done', output_index: 0, item: reason },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { ...message, status: 'in_progress', content: [] }
    },
    {
      type: 'response.content_part.added',
      item_id: message.id,
      output_index: 1,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    },
    {
      type: 'response.output_text.delta',
      item_id: message.id,
      output_index: 1,
      content_index: 0,
      delta: message.content[0].text
    },
    {
      type: 'response.output_text.done',
      item_id: message.id,
      output_index: 1,
      content_index: 0,
      text: message.content[0].text
    },
    {
      type: 'response.content_part.done',
      item_id: message.id,
      output_index: 1,
      content_index: 0,
      part: message.content[0]
    },
    { type: 'response.output_item.done', output_index: 1, item: message }
  ]
  if (reply.tool)
    events.push(
      {
        type: 'response.output_item.added',
        output_index: 2,
        item: { ...call, arguments: '', status: 'in_progress' }
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: call.id,
        output_index: 2,
        delta: call.arguments
      },
      {
        type: 'response.function_call_arguments.done',
        item_id: call.id,
        output_index: 2,
        arguments: call.arguments
      },
      { type: 'response.output_item.done', output_index: 2, item: call }
    )
  if (!reply.hold)
    events.push({
      type: 'response.completed',
      response: {
        id: 'resp_parity',
        object: 'response',
        model: body.model,
        status: 'completed',
        output,
        usage: {
          input_tokens: 10,
          output_tokens: 12,
          total_tokens: 22,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 4 }
        }
      }
    })
  return events
}

/** Physical Node HTTP is independent of Bun's provider and gateway transports. */
export async function startVendorProvider(): Promise<{
  url: string
  requests: VendorRequest[]
  enqueue(...replies: VendorReply[]): void
  active(): number
  upgrades(): number
  close(): Promise<void>
}> {
  const requests: VendorRequest[] = []
  const replies: VendorReply[] = []
  const active = new Set<ServerResponse>()
  let upgrades = 0
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !/\/(messages|responses)(\?.*)?$/.test(request.url ?? '')) {
        response.writeHead(404).end('Unexpected private vendor endpoint')
        return
      }
      request.setEncoding('utf8')
      let raw = ''
      for await (const chunk of request) {
        raw += chunk
        if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('Oversized private request')
      }
      const body = JSON.parse(raw) as Record<string, unknown>
      requests.push({ path: request.url!, headers: { ...request.headers }, body })
      const reply = replies.shift() ?? { text: 'Next turn received' }
      if (reply.status) {
        response.writeHead(reply.status, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'authentication_error',
              message: `${VENDOR_SECRETS.error} ${VENDOR_SECRETS.key} http://${request.headers.host}/private?credential=${VENDOR_SECRETS.refresh}`
            }
          })
        )
        return
      }
      active.add(response)
      response.on('close', () => active.delete(response))
      request.socket.once('close', () => active.delete(response))
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-private-vendor': VENDOR_SECRETS.key
      })
      const events = request.url!.includes('/messages')
        ? anthropicEvents(body, reply)
        : responsesEvents(body, reply)
      for (const event of events) {
        const type = (event as { type: string }).type
        response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)
      }
      if (!reply.hold) response.end()
    } catch {
      if (!response.headersSent) response.writeHead(500)
      response.end('Private vendor fixture failed')
    }
  })
  server.on('upgrade', (_request, socket) => {
    upgrades++
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    enqueue: (...items) => replies.push(...items),
    active: () => active.size,
    upgrades: () => upgrades,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}
