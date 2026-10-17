import type { PhiHostRequestContext, PhiHostRequestHandler } from '../engine/types'
import type { createCapabilityService } from './capability-service'
import { CAPABILITY_HOST_METHODS } from './capability-tools'

interface ExternalSkills {
  findSkills(params: unknown, context: PhiHostRequestContext): Promise<unknown>
  install(params: unknown, context: PhiHostRequestContext): Promise<unknown>
  ownsCandidate(candidateId: string, runtimeSessionId: string): boolean
}

export interface CapabilityRunBinding {
  assertCurrent(): void
}

export interface CapabilityHost {
  handlers: Record<string, PhiHostRequestHandler>
  assertCurrent(context: PhiHostRequestContext): void
}

/** Owns cancellation and live run identity outside all model-supplied arguments. */
export function createCapabilityHost(options: {
  service: Pick<ReturnType<typeof createCapabilityService>, 'search' | 'install'>
  external: ExternalSkills
  resolveRun(runtimeSessionId: string): CapabilityRunBinding
  onInstalled?: (result: unknown, context: PhiHostRequestContext) => void | Promise<void>
}): CapabilityHost {
  const pending = new Map<
    string,
    { runtimeSessionId: string; toolCallId: string; controller: AbortController }
  >()
  const guards = new WeakMap<AbortSignal, () => void>()

  function assertCurrent(context: PhiHostRequestContext): void {
    context.signal?.throwIfAborted()
    const guard = context.signal && guards.get(context.signal)
    if (!guard) throw new Error('模块操作缺少有效的会话绑定')
    guard()
  }

  const invoke =
    (
      operation: (
        params: Record<string, unknown>,
        context: PhiHostRequestContext
      ) => Promise<unknown>
    ): PhiHostRequestHandler =>
    async (params, context) => {
      const input = inputRecord(params)
      const runtimeSessionId = identifier(input.runtimeSessionId)
      const toolCallId = identifier(input.toolCallId)
      const requestId = identifier(input.requestId)
      if (
        context.originSessionId !== runtimeSessionId ||
        context.toolCallId !== toolCallId ||
        context.agentRunId ||
        pending.has(requestId)
      )
        throw new Error('模块操作的会话或工具调用来源无效')
      const run = options.resolveRun(runtimeSessionId)
      run.assertCurrent()
      context.signal?.throwIfAborted()
      const controller = new AbortController()
      const abort = (): void => controller.abort(context.signal?.reason)
      context.signal?.addEventListener('abort', abort, { once: true })
      const trusted = { ...context, signal: controller.signal }
      pending.set(requestId, { runtimeSessionId, toolCallId, controller })
      guards.set(controller.signal, () => run.assertCurrent())
      try {
        assertCurrent(trusted)
        return await operation(input, trusted)
      } finally {
        pending.delete(requestId)
        guards.delete(controller.signal)
        context.signal?.removeEventListener('abort', abort)
      }
    }

  const handlers: Record<string, PhiHostRequestHandler> = {
    [CAPABILITY_HOST_METHODS.search]: invoke((params, context) =>
      options.service.search(params, context)
    ),
    [CAPABILITY_HOST_METHODS.install]: invoke(async (params, context) => {
      const result = await (options.external.ownsCandidate(
        String(params.candidateId),
        String(params.runtimeSessionId)
      )
        ? options.external.install(params, context)
        : options.service.install(params, context))
      if (
        result &&
        typeof result === 'object' &&
        'ok' in result &&
        result.ok === true &&
        'installed' in result &&
        result.installed === true
      )
        await options.onInstalled?.(result, context)
      return result
    }),
    [CAPABILITY_HOST_METHODS.findSkills]: invoke(async (params, context) => {
      // The model cannot bypass the application catalog by choosing the fallback tool directly.
      const result = await options.service.search({ ...params, type: undefined }, context)
      assertCurrent(context)
      if (result.candidates.length || !result.canFindExternal) return result
      return options.external.findSkills(params, context)
    }),
    [CAPABILITY_HOST_METHODS.cancel]: (params, context) => {
      const input = inputRecord(params)
      const operation = pending.get(identifier(input.requestId))
      if (
        operation &&
        context.originSessionId === operation.runtimeSessionId &&
        input.runtimeSessionId === operation.runtimeSessionId &&
        context.toolCallId === operation.toolCallId &&
        input.toolCallId === operation.toolCallId &&
        !context.agentRunId
      )
        operation.controller.abort(new Error('模块操作已取消'))
      return { cancelled: operation?.controller.signal.aborted === true }
    }
  }
  return { handlers, assertCurrent }
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('模块操作参数无效')
  return value as Record<string, unknown>
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || value.includes('\0'))
    throw new Error('模块操作标识无效')
  return value
}
