import { randomUUID } from 'node:crypto'
import { getOmpBridge } from '../omp-bridge'
import type { PhiTool, PhiToolResult } from '../types'
import { validHostResultPayload } from '../phi-extension/lib/rpc-host-result-protocol'
import { rpcIdentifier, rpcToolCallId } from './control-frame'
import { webSearchPath, webSearchRecord } from './desktop-websearch-protocol'
import { skippedMcpServersValue } from '../../../../shared/mcpSkippedServers'
import { DESKTOP_MCP_STAGES, desktopMcpStageOf } from './desktop-mcp-stages'
import type {
  DesktopMcpAdapter,
  DesktopMcpOptions,
  DesktopMcpToolMetadata
} from './desktop-mcp-types'

const adapters = new WeakSet<object>()
export function isDesktopMcpAdapter(value: object): value is DesktopMcpAdapter {
  return adapters.has(value)
}

/** Trusted catalog -> one real session-private MCP manager, with no SDK conversation. */
export async function createDesktopMcpAdapter(
  options: DesktopMcpOptions
): Promise<DesktopMcpAdapter> {
  const identity = Object.freeze({
    runtimeSessionId: options.identity.runtimeSessionId,
    sessionId: options.identity.sessionId,
    projectId: options.identity.projectId,
    cwd: options.identity.cwd
  })
  if (
    ![identity.runtimeSessionId, identity.sessionId, identity.projectId].every(rpcIdentifier) ||
    !webSearchPath(identity.cwd) ||
    !webSearchPath(options.agentDir) ||
    !webSearchPath(options.resourceCwd) ||
    !Array.isArray(options.serverNames) ||
    options.serverNames.length > 256 ||
    options.serverNames.some((name) => !rpcIdentifier(name)) ||
    new Set(options.serverNames).size !== options.serverNames.length ||
    typeof options.approvalFor !== 'function'
  )
    throw new Error('MCP adapter requires a trusted session and resource catalog')
  options.beforeDispatch?.()
  if (options.serverNames.length === 0) {
    const empty: DesktopMcpAdapter = Object.freeze({
      identity,
      tools: Object.freeze([]),
      skipped: Object.freeze([]),
      approvalFor: () => undefined,
      retire: () => {},
      close: async () => {}
    })
    adapters.add(empty)
    return empty
  }
  const bridge = options.bridge ?? getOmpBridge()
  const worker = bridge.retainResourceWorker()
  const retirement = new AbortController()
  const lifetime = AbortSignal.any([
    retirement.signal,
    worker.signal,
    ...(options.signal ? [options.signal] : [])
  ])
  const scopeId = randomUUID()
  const calls = new Map<string, { update?: (value: PhiToolResult) => void; signal: AbortSignal }>()
  const active = new Set<Promise<unknown>>()
  const off = bridge.onResourceProgress(scopeId, (value) => {
    if (
      !webSearchRecord(value) ||
      !rpcIdentifier(value.requestId) ||
      !validHostResultPayload(value.result)
    )
      return
    const call = calls.get(value.requestId)
    if (!lifetime.aborted && call && !call.signal.aborted) {
      try {
        options.beforeDispatch?.()
      } catch {
        retirement.abort(new Error('MCP session binding changed'))
        return
      }
      try {
        call.update?.(value.result)
      } catch {
        /* An observer cannot replay or fail an MCP call. */
      }
    }
  })
  const cancel = (requestId?: string): void => {
    if (!worker.signal.aborted)
      void bridge
        .request('mcp.desktopCancel', { scopeId, ...(requestId ? { requestId } : {}) })
        .catch(() => {})
  }
  const abort = (): void => cancel()
  lifetime.addEventListener('abort', abort, { once: true })
  let closing: Promise<void> | undefined
  async function close(): Promise<void> {
    if (!retirement.signal.aborted) retirement.abort(new Error('MCP adapter retired'))
    return (closing ??= (async () => {
      try {
        if (!worker.signal.aborted) await bridge.request('mcp.desktopClose', { scopeId })
        await Promise.allSettled([...active])
      } finally {
        lifetime.removeEventListener('abort', abort)
        off()
        worker.release()
      }
    })())
  }
  try {
    lifetime.throwIfAborted()
    options.beforeDispatch?.()
    const creating = bridge.request<unknown>('mcp.desktopCreate', {
      scopeId,
      identity,
      agentDir: options.agentDir,
      resourceCwd: options.resourceCwd,
      serverNames: [...options.serverNames],
      allowStdio: options.allowStdio === true,
      remoteProjectMcpServers: options.remoteProjectMcpServers ?? []
    })
    active.add(creating)
    let created: unknown
    try {
      created = await creating
    } finally {
      active.delete(creating)
    }
    lifetime.throwIfAborted()
    options.beforeDispatch?.()
    const skipped = webSearchRecord(created) ? skippedMcpServersValue(created.skipped) : undefined
    if (!webSearchRecord(created) || !skipped || Object.keys(created).length !== 2)
      throw new Error('MCP catalog was invalid')
    const discovered = created.tools
    if (
      !Array.isArray(discovered) ||
      discovered.length > 4096 ||
      discovered.some(
        (tool) =>
          !webSearchRecord(tool) ||
          !rpcIdentifier(tool.name) ||
          !tool.name.startsWith('mcp__') ||
          typeof tool.label !== 'string' ||
          typeof tool.description !== 'string' ||
          !webSearchRecord(tool.parameters) ||
          typeof tool.signature !== 'string' ||
          !/^[a-f0-9]{64}$/.test(tool.signature)
      )
    )
      throw new Error('MCP catalog was invalid')
    const metadata = discovered as DesktopMcpToolMetadata[]
    if (new Set(metadata.map((tool) => tool.name)).size !== metadata.length)
      throw new Error('MCP catalog is ambiguous')
    const tools = Object.freeze(
      metadata.map((source): PhiTool =>
        Object.freeze({
          name: source.name,
          label: source.label,
          description: source.description,
          parameters: structuredClone(source.parameters),
          site: 'host',
          strict: false,
          loadMode: 'discoverable',
          approval: 'write',
          async execute(toolCallId, params, onUpdate, context, signal) {
            options.beforeDispatch?.()
            if (
              !rpcToolCallId(toolCallId) ||
              context.cwd !== identity.cwd ||
              !webSearchRecord(params)
            )
              throw new Error('Invalid MCP tool invocation')
            const linked = AbortSignal.any([lifetime, ...(signal ? [signal] : [])])
            linked.throwIfAborted()
            const requestId = randomUUID()
            const onAbort = (): void => cancel(requestId)
            options.beforeDispatch?.()
            linked.addEventListener('abort', onAbort, { once: true })
            calls.set(requestId, { update: onUpdate, signal: linked })
            const operation = bridge.request<unknown>('mcp.desktopCall', {
              scopeId,
              requestId,
              toolCallId,
              name: source.name,
              signature: source.signature,
              input: params
            })
            active.add(operation)
            try {
              const result = await operation
              linked.throwIfAborted()
              options.beforeDispatch?.()
              if (!validHostResultPayload(result)) throw new Error('MCP tool result was invalid')
              return result
            } catch {
              if (linked.aborted) throw new Error('MCP tool call cancelled')
              throw new Error('MCP tool call failed')
            } finally {
              calls.delete(requestId)
              active.delete(operation)
              linked.removeEventListener('abort', onAbort)
            }
          }
        })
      )
    )
    const adapter: DesktopMcpAdapter = {
      identity,
      tools,
      skipped: Object.freeze(skipped.map((server) => Object.freeze(server))),
      approvalFor(name, input) {
        if (lifetime.aborted || !tools.some((tool) => tool.name === name)) return undefined
        return options.approvalFor(name, input) ?? 'write'
      },
      retire(reason = new Error('MCP adapter retired')) {
        retirement.abort(reason)
      },
      close
    }
    adapters.add(adapter)
    return Object.freeze(adapter)
  } catch (error) {
    const cancelled = lifetime.aborted
    const stage = desktopMcpStageOf(error)
    await close().catch(() => {})
    if (cancelled) throw new Error('MCP discovery cancelled')
    throw new Error(
      stage ? `MCP discovery failed while ${DESKTOP_MCP_STAGES[stage]}` : 'MCP discovery failed'
    )
  }
}
