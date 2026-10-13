import { realpathSync } from 'node:fs'
import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import { consumeHostResultFile } from '../lib/rpc-host-result-file'
import {
  HOST_RESULT_FAILURE,
  hostResultLookupId,
  isHostResultPlaceholder,
  type HostResultIdentity
} from '../lib/rpc-host-result-protocol'

export interface RpcHostResultReadiness extends Pick<
  HostResultIdentity,
  'leaseId' | 'generation' | 'phiSessionId' | 'projectId' | 'cwd' | 'runId'
> {
  ompSessionId: string
  signal: AbortSignal
}
export interface RpcHostResultExtensionOptions {
  generationDirectory: string
  directory: string
  capability: string
  /** Root supplies a stable immutable ready-run binding; replacing it revokes authority. */
  readiness(): Readonly<RpcHostResultReadiness> | undefined
  /** Root's exact acknowledged host roster, never all tool names. */
  isHostTool(name: string): boolean
}
const failed = { content: [{ type: 'text' as const, text: HOST_RESULT_FAILURE }], isError: true }
export function createRpcHostResultExtension(
  options: RpcHostResultExtensionOptions
): ExtensionFactory {
  return (pi) => {
    const calls = new Map<string, { ready: Readonly<RpcHostResultReadiness>; name: string }>()
    const consumed = new Set<string>()
    const live = (
      ready: Readonly<RpcHostResultReadiness>,
      ctx: { cwd: string; agent: { kind: string }; sessionManager: { getSessionId(): string } }
    ): boolean => {
      const current = options.readiness()
      return (
        !!current &&
        current === ready &&
        !ready.signal.aborted &&
        ctx.agent.kind === 'main' &&
        ctx.sessionManager.getSessionId() === ready.ompSessionId &&
        realpathSync(ctx.cwd) === ready.cwd
      )
    }
    pi.on('tool_call', (event, ctx) => {
      if (!options.isHostTool(event.toolName)) return
      try {
        const ready = options.readiness()
        if (!ready || !live(ready, ctx)) return { block: true, reason: HOST_RESULT_FAILURE }
        for (const [key, call] of calls)
          if (call.ready !== ready || call.ready.signal.aborted) calls.delete(key)
        if (calls.size >= 64) return { block: true, reason: HOST_RESULT_FAILURE }
        const key = JSON.stringify([ready.runId, event.toolCallId])
        if (calls.has(key)) return { block: true, reason: HOST_RESULT_FAILURE }
        calls.set(key, { ready, name: event.toolName })
        return undefined
      } catch {
        return { block: true, reason: HOST_RESULT_FAILURE }
      }
    })
    pi.on('tool_result', (event, ctx) => {
      const placeholder = isHostResultPlaceholder(event.content)
      const current = options.readiness()
      const key = current && JSON.stringify([current.runId, event.toolCallId])
      const call = key ? calls.get(key) : undefined
      if (key) calls.delete(key)
      if (!placeholder) return undefined
      try {
        if (
          !call ||
          !options.isHostTool(event.toolName) ||
          call.name !== event.toolName ||
          !live(call.ready, ctx) ||
          consumed.size >= 10_000
        )
          return failed
        const identity = { ...call.ready, toolCallId: event.toolCallId, toolName: event.toolName }
        const lookup = hostResultLookupId(identity, options.capability)
        if (consumed.has(lookup)) return failed
        consumed.add(lookup)
        const result = consumeHostResultFile(
          options.generationDirectory,
          options.directory,
          identity,
          options.capability,
          call.ready.signal
        )
        if (!live(call.ready, ctx)) return failed
        return {
          content: result.content,
          details: result.details,
          isError: result.isError === true
        }
      } catch {
        return failed
      }
    })
    pi.on('session_shutdown', () => {
      calls.clear()
      consumed.clear()
    })
  }
}
