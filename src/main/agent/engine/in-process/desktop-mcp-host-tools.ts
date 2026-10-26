import type { PhiTool, PhiToolResult } from '../types'
import { validHostResultPayload } from '../phi-extension/lib/rpc-host-result-protocol'
import { isRecord, stringValue } from './common'
import { requestHost } from './ipc'

const BUILTIN_TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'bash',
  'glob',
  'grep',
  'find',
  'eval',
  'task',
  'wait',
  'learn',
  'manage_skill',
  'context_notes',
  'new_context'
] as const

interface DesktopMcpMetadata {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  signature: string
}

export interface DesktopMcpHostTools {
  readonly tools: PhiTool[]
  readonly skipped: Array<{ name: string; reason: string }>
  close(): Promise<void>
}

function metadata(value: unknown): DesktopMcpMetadata[] {
  if (!Array.isArray(value)) throw new Error('Desktop MCP catalog omitted tools')
  return value.map((item) => {
    if (
      !isRecord(item) ||
      !stringValue(item.name).startsWith('mcp__') ||
      typeof item.label !== 'string' ||
      typeof item.description !== 'string' ||
      !isRecord(item.parameters) ||
      !/^[a-f0-9]{64}$/.test(stringValue(item.signature))
    ) {
      throw new Error('Desktop MCP catalog was invalid')
    }
    return {
      name: item.name as string,
      label: item.label,
      description: item.description,
      parameters: item.parameters,
      signature: item.signature as string
    }
  })
}

function result(value: unknown): PhiToolResult {
  if (!validHostResultPayload(value)) throw new Error('Desktop MCP tool result was invalid')
  return value
}

export async function loadDesktopMcpHostTools(options: {
  sessionId: string
  cwd: string
  bindingId: string
  registeredToolNames: readonly string[]
}): Promise<DesktopMcpHostTools> {
  const registeredToolNames = [...new Set([...BUILTIN_TOOL_NAMES, ...options.registeredToolNames])]
  const listed = await requestHost(
    'mcp.desktop.list',
    {
      bindingId: options.bindingId,
      cwd: options.cwd,
      registeredToolNames
    },
    { originSessionId: options.sessionId }
  )
  if (!isRecord(listed)) throw new Error('Desktop MCP catalog was invalid')
  const catalog = metadata(listed.tools)
  const reserved = new Set(registeredToolNames)
  const conflict = catalog.find((tool) => reserved.has(tool.name))
  if (conflict) throw new Error(`Desktop MCP tool conflicts with ${conflict.name}`)

  const tools = catalog.map((source): PhiTool => ({
    name: source.name,
    label: source.label,
    description: source.description,
    parameters: structuredClone(source.parameters),
    site: 'host',
    strict: false,
    loadMode: 'discoverable',
    approval: 'write',
    async execute(toolCallId, input, onUpdate, _context, signal) {
      const onAbort = (): void => {
        void requestHost(
          'mcp.desktop.cancel',
          { bindingId: options.bindingId, toolCallId },
          { originSessionId: options.sessionId }
        ).catch(() => undefined)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const value = await requestHost(
          'mcp.desktop.call',
          {
            bindingId: options.bindingId,
            toolCallId,
            name: source.name,
            signature: source.signature,
            input
          },
          { originSessionId: options.sessionId },
          (progress) => {
            if (!signal?.aborted && validHostResultPayload(progress)) onUpdate?.(progress)
          }
        )
        signal?.throwIfAborted()
        return result(value)
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    }
  }))
  const skipped = Array.isArray(listed.skipped)
    ? listed.skipped.flatMap((item) =>
        isRecord(item) && typeof item.name === 'string' && typeof item.reason === 'string'
          ? [{ name: item.name, reason: item.reason }]
          : []
      )
    : []
  return {
    tools,
    skipped,
    async close() {
      await requestHost(
        'mcp.desktop.close',
        { bindingId: options.bindingId },
        { originSessionId: options.sessionId }
      )
    }
  }
}
