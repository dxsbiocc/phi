import type {
  JsonValue,
  KernelHostCapabilityParams,
  KernelHostCapabilityResult
} from '../../../../shared/kernel-protocol'
import type { PhiToolResult } from '../types'
import { createDesktopMcpAdapter } from '../rpc/desktop-mcp-adapter'
import type { DesktopMcpAdapter, DesktopMcpOptions } from '../rpc/desktop-mcp-types'
import {
  KernelClientError,
  type KernelHostRequestContext,
  type KernelProtocolClient
} from '../kernel-client'

export const DESKTOP_MCP_HOST_CAPABILITIES = [
  'mcp.desktop.list',
  'mcp.desktop.call',
  'mcp.desktop.cancel',
  'mcp.desktop.close'
] as const

export interface DesktopMcpBrokerResolveInput {
  readonly bindingId: string
  readonly kernelSessionId: string
  readonly cwd: string
  readonly signal: AbortSignal
}

export interface DesktopMcpHostBrokerOptions {
  resolve(input: DesktopMcpBrokerResolveInput): Promise<DesktopMcpOptions | undefined>
  createAdapter?: typeof createDesktopMcpAdapter
  state?: DesktopMcpHostBrokerState
  /** Reattach unbinds one client without retiring desktop MCP processes. */
  retainStateOnClose?: boolean
}

export interface DesktopMcpHostBroker {
  closeSession(sessionId: string): Promise<void>
  close(): Promise<void>
}

interface OwnedDesktopMcp {
  readonly bindingId: string
  readonly adapter: DesktopMcpAdapter
  readonly calls: Map<string, AbortController>
}

export interface DesktopMcpHostBrokerState {
  readonly owned: Map<string, OwnedDesktopMcp>
}

export function createDesktopMcpHostBrokerState(): DesktopMcpHostBrokerState {
  return { owned: new Map() }
}

export async function closeDesktopMcpHostBrokerState(
  state: DesktopMcpHostBrokerState
): Promise<void> {
  const sessions = [...state.owned]
  state.owned.clear()
  await Promise.allSettled(
    sessions.map(async ([, current]) => {
      for (const controller of current.calls.values()) controller.abort(new Error('MCP closed'))
      current.calls.clear()
      current.adapter.retire(new Error('Kernel session closed'))
      await current.adapter.close()
    })
  )
}

function unavailable(reason: string, message: string): KernelClientError {
  return new KernelClientError({
    code: 'CAPABILITY_UNAVAILABLE',
    message,
    detail: { reason }
  })
}

function sessionId(context: KernelHostRequestContext): string {
  if (!context.sessionId) {
    throw unavailable('session_binding_required', 'Desktop MCP requires a kernel session binding.')
  }
  return context.sessionId
}

function jsonToolResult(result: PhiToolResult): KernelHostCapabilityResult<'mcp.desktop.call'> {
  return {
    content: result.content.map((part) => ({ ...part })),
    ...(result.details === undefined ? {} : { details: result.details as JsonValue }),
    ...(result.isError === undefined ? {} : { isError: result.isError })
  }
}

function listResult(adapter: DesktopMcpAdapter): KernelHostCapabilityResult<'mcp.desktop.list'> {
  return {
    tools: adapter.catalog.map((tool) => ({
      ...tool,
      parameters: structuredClone(tool.parameters) as Record<string, JsonValue>
    })),
    skipped: adapter.skipped.map((server) => ({ ...server }))
  }
}

function recentImages(
  params: KernelHostCapabilityParams<'mcp.desktop.call'>
): NonNullable<KernelHostCapabilityParams<'mcp.desktop.call'>['recentUserImages']> {
  return (params.recentUserImages ?? []).map((image) => ({ ...image }))
}

export function registerDesktopMcpHostBroker(
  client: KernelProtocolClient,
  options: DesktopMcpHostBrokerOptions
): DesktopMcpHostBroker {
  const createAdapter = options.createAdapter ?? createDesktopMcpAdapter
  const owned = options.state?.owned ?? new Map<string, OwnedDesktopMcp>()

  const closeSession = async (kernelSessionId: string): Promise<void> => {
    const current = owned.get(kernelSessionId)
    if (!current) return
    owned.delete(kernelSessionId)
    for (const controller of current.calls.values()) controller.abort(new Error('MCP closed'))
    current.calls.clear()
    current.adapter.retire(new Error('Kernel session closed'))
    await current.adapter.close()
  }

  const unregister = [
    client.registerHostCapability('mcp.desktop.list', async (params, context) => {
      const kernelSessionId = sessionId(context)
      const existing = owned.get(kernelSessionId)
      if (existing) {
        if (existing.bindingId !== params.bindingId) {
          throw unavailable('session_binding_changed', 'Desktop MCP session binding changed.')
        }
        return listResult(existing.adapter)
      }

      const resolved = await options.resolve({
        bindingId: params.bindingId,
        kernelSessionId,
        cwd: params.cwd,
        signal: context.signal
      })
      if (!resolved) {
        throw unavailable('desktop_mcp_unavailable', 'Desktop MCP is unavailable for this session.')
      }
      if (
        resolved.identity.runtimeSessionId !== kernelSessionId ||
        resolved.identity.cwd !== params.cwd
      ) {
        throw unavailable('session_binding_mismatch', 'Desktop MCP resolved a different session.')
      }

      let adapter: DesktopMcpAdapter
      try {
        adapter = await createAdapter({ ...resolved, signal: context.signal })
      } catch {
        throw unavailable('desktop_mcp_discovery_failed', 'Desktop MCP discovery failed.')
      }
      const registered = new Set(params.registeredToolNames)
      const conflict = adapter.catalog.find((tool) => registered.has(tool.name))
      if (conflict) {
        adapter.retire(new Error('MCP tool name conflict'))
        await adapter.close().catch(() => undefined)
        throw unavailable('tool_name_conflict', `Desktop MCP tool conflicts with ${conflict.name}.`)
      }
      owned.set(kernelSessionId, { bindingId: params.bindingId, adapter, calls: new Map() })
      return listResult(adapter)
    }),
    client.registerHostCapability('mcp.desktop.call', async (params, context) => {
      const kernelSessionId = sessionId(context)
      const current = owned.get(kernelSessionId)
      if (!current || current.bindingId !== params.bindingId) {
        throw unavailable('desktop_mcp_not_initialized', 'Desktop MCP is not initialized.')
      }
      const metadata = current.adapter.catalog.find((tool) => tool.name === params.name)
      const tool = current.adapter.tools.find((candidate) => candidate.name === params.name)
      if (!metadata || !tool || metadata.signature !== params.signature) {
        throw unavailable('tool_schema_changed', 'Desktop MCP tool schema changed.')
      }
      if (current.calls.has(params.toolCallId)) {
        throw new KernelClientError({
          code: 'DUPLICATE_REQUEST',
          message: 'Desktop MCP tool call id is already active.'
        })
      }
      const controller = new AbortController()
      current.calls.set(params.toolCallId, controller)
      const signal = AbortSignal.any([context.signal, controller.signal])
      try {
        try {
          const result = await tool.execute(
            params.toolCallId,
            params.input as Record<string, unknown>,
            context.progress
              ? (progress) => context.progress?.(jsonToolResult(progress))
              : undefined,
            { cwd: current.adapter.identity.cwd, recentUserImages: () => recentImages(params) },
            signal
          )
          return jsonToolResult(result)
        } catch {
          if (signal.aborted) {
            throw new KernelClientError({
              code: 'CANCELLED',
              message: 'Desktop MCP tool call was cancelled.',
              detail: { reason: 'desktop_mcp_call_cancelled' }
            })
          }
          throw unavailable('desktop_mcp_call_failed', 'Desktop MCP tool call failed.')
        }
      } finally {
        if (current.calls.get(params.toolCallId) === controller) {
          current.calls.delete(params.toolCallId)
        }
      }
    }),
    client.registerHostCapability('mcp.desktop.cancel', async (params, context) => {
      const current = owned.get(sessionId(context))
      if (current?.bindingId === params.bindingId) {
        current.calls.get(params.toolCallId)?.abort(new Error('MCP tool call cancelled'))
      }
      return null
    }),
    client.registerHostCapability('mcp.desktop.close', async (params, context) => {
      const kernelSessionId = sessionId(context)
      const current = owned.get(kernelSessionId)
      if (current && current.bindingId !== params.bindingId) {
        throw unavailable('session_binding_changed', 'Desktop MCP session binding changed.')
      }
      await closeSession(kernelSessionId)
      return null
    })
  ]

  return {
    closeSession,
    async close() {
      for (const remove of unregister.reverse()) remove()
      if (!options.retainStateOnClose) await Promise.allSettled([...owned.keys()].map(closeSession))
    }
  }
}
