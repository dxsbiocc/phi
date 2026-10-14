import '../engine-contract/network-guard'
import { appendFileSync } from 'node:fs'
const path = process.env.PHI_GATEWAY_CLI_WIRE_AUDIT
const originalFetch = globalThis.fetch
const describe = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const safeKey = (key: string): string =>
  /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key) ? key : '<nonstandard>'
const audited = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  let audit: Record<string, unknown> | undefined
  if (path && url.pathname === '/v1/pi/stream' && typeof init?.body === 'string') {
    const raw = JSON.parse(init.body) as {
      options?: Record<string, unknown>
      context?: {
        systemPrompt?: unknown
        messages?: Array<Record<string, unknown>>
        tools?: Array<Record<string, unknown>>
      }
    }
    const headers = new Headers(init.headers)
    audit = {
      bodyKeys: Object.keys(raw).map(safeKey),
      contextKeys: Object.keys(raw.context ?? {}).map(safeKey),
      options: Object.fromEntries(
        Object.entries(raw.options ?? {}).map(([key, value]) => [safeKey(key), describe(value)])
      ),
      messages: raw.context?.messages?.map((message) => ({
        role: message.role,
        content: describe(message.content),
        timestamp: describe(message.timestamp)
      })),
      tools: raw.context?.tools?.map((tool) => ({
        keys: Object.keys(tool).map(safeKey),
        parameters: describe(tool.parameters),
        description: describe(tool.description)
      })),
      systemPrompt: describe(raw.context?.systemPrompt),
      bearerMatches:
        headers.get('authorization') === `Bearer ${process.env.PHI_GATEWAY_CLI_EXPECTED_BEARER}`
    }
  }
  const response = await originalFetch(input, init)
  if (path && audit)
    appendFileSync(path, JSON.stringify({ ...audit, status: response.status }) + '\n', {
      mode: 0o600
    })
  return response
}) as typeof fetch
Object.defineProperty(audited, 'preconnect', { value: Reflect.get(originalFetch, 'preconnect') })
globalThis.fetch = audited
