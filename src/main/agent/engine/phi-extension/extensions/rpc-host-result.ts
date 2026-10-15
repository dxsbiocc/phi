import { realpathSync } from 'node:fs'
import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import { consumeHostResultFile } from '../lib/rpc-host-result-file'
import {
  HOST_RESULT_FAILURE,
  hostResultLookupId,
  hostProgressSequence,
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
    const calls = new Map<
      string,
      { ready: Readonly<RpcHostResultReadiness>; name: string; sequence: number; failed?: boolean }
    >()
    const wrapped = new WeakSet<object>()
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
      if (ctx.agent.kind !== 'main') return
      if (!options.isHostTool(event.toolName)) return
      try {
        const ready = options.readiness()
        if (!ready || !live(ready, ctx)) return { block: true, reason: HOST_RESULT_FAILURE }
        for (const [key, call] of calls)
          if (call.ready !== ready || call.ready.signal.aborted) calls.delete(key)
        if (calls.size >= 64) return { block: true, reason: HOST_RESULT_FAILURE }
        const key = JSON.stringify([ready.runId, event.toolCallId])
        if (calls.has(key)) return { block: true, reason: HOST_RESULT_FAILURE }
        const session = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session
        const tool = session?.getToolByName(event.toolName)
        if (!session || session.sessionManager !== ctx.sessionManager || !tool)
          return { block: true, reason: HOST_RESULT_FAILURE }
        if (!wrapped.has(tool)) {
          const original = tool.execute
          tool.execute = function (id, args, signal, onUpdate, context) {
            const binding = options.readiness()
            const call = binding && calls.get(JSON.stringify([binding.runId, id]))
            return original.call(
              this,
              id,
              args,
              signal,
              (partial) => {
                if (!call || call.failed || !live(call.ready, ctx) || signal?.aborted) return
                try {
                  const sequence = hostProgressSequence(partial.content)
                  if (sequence === undefined) {
                    onUpdate?.(partial)
                    return
                  }
                  if (sequence !== call.sequence + 1) throw new Error('Out of order host progress')
                  const identity = {
                    ...call.ready,
                    toolCallId: id,
                    toolName: call.name,
                    progressSequence: sequence
                  }
                  const result = consumeHostResultFile(
                    options.generationDirectory,
                    options.directory,
                    identity,
                    options.capability,
                    call.ready.signal
                  )
                  if (!live(call.ready, ctx) || signal?.aborted) return
                  call.sequence = sequence
                  onUpdate?.({ ...result, details: result.details })
                } catch {
                  call.failed = true
                  // A private transport marker must never become a public partial result.
                  onUpdate?.({ ...failed, details: undefined })
                }
              },
              context
            )
          }
          wrapped.add(tool)
        }
        calls.set(key, { ready, name: event.toolName, sequence: 0 })
        return undefined
      } catch {
        return { block: true, reason: HOST_RESULT_FAILURE }
      }
    })
    pi.on('tool_result', (event, ctx) => {
      if (ctx.agent.kind !== 'main') return
      const placeholder = isHostResultPlaceholder(event.content)
      const current = options.readiness()
      const key = current && JSON.stringify([current.runId, event.toolCallId])
      const call = key ? calls.get(key) : undefined
      if (key) calls.delete(key)
      if (call?.failed) return failed
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
