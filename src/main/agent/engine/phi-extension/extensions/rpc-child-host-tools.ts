import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@oh-my-pi/pi-coding-agent'
import { consumeHostResultFile } from '../lib/rpc-host-result-file'
import type { RpcChildHostResource } from '../lib/rpc-child-resources'
import type { RpcChildCall, RpcChildHostResult } from '../lib/rpc-child-protocol'
import type { RpcChildNativeExecution } from './rpc-child-native-tools'

export interface RpcChildHostResultBinding {
  readonly generationDirectory: string
  readonly directory: string
  readonly capability: string
  readonly leaseId: string
}
export interface RpcChildHostExecution extends RpcChildNativeExecution {
  executeHost(call: RpcChildCall, signal: AbortSignal): Promise<RpcChildHostResult>
  resultConsumed(call: RpcChildCall, invocationId: string, signal: AbortSignal): Promise<void>
}
/** Pinned SDK labels every mcp__ name as MCP, including registered extension overrides. */
export function rpcChildWrapperSourceMatches(
  tool: { readonly name: string; readonly site: string },
  source: string
): boolean {
  return (
    source === 'extension' ||
    (tool.site === 'host' && tool.name.startsWith('mcp__') && source === 'mcp')
  )
}
/** Uses the existing signed file transport; host DTO replies never become fabricated tool results. */
export function registerRpcChildHostTools(
  pi: ExtensionAPI,
  tools: readonly RpcChildHostResource[],
  resultBinding: RpcChildHostResultBinding,
  current: (ctx: ExtensionContext) => RpcChildHostExecution | undefined
): ReadonlyMap<string, string> {
  const installed = new Map<string, string>()
  for (const tool of tools) {
    const description = `Phi controlled host ${tool.name}. ${tool.description}`
    installed.set(tool.name, description)
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description,
      parameters: tool.parameters as ToolDefinition['parameters'],
      loadMode: 'essential',
      approval: 'read',
      execute: async (id, input, signal, _onUpdate, ctx) => {
        const binding = current(ctx)
        if (!binding || !binding.active(ctx))
          throw new Error('Phi child host execution is unavailable')
        const combined = signal ? AbortSignal.any([signal, binding.signal]) : binding.signal
        try {
          combined.throwIfAborted()
          const call = binding.consume(id, tool.name, input)
          if (!(await binding.approve(call, combined)) || !binding.active(ctx))
            throw new Error('Phi child host execution was refused')
          combined.throwIfAborted()
          const result = await binding.executeHost(call, combined)
          if (!binding.active(ctx)) throw new Error('Phi child host result lost its owner')
          const payload = consumeHostResultFile(
            resultBinding.generationDirectory,
            resultBinding.directory,
            {
              leaseId: resultBinding.leaseId,
              generation: binding.scope.generation,
              phiSessionId: binding.scope.phiSessionId,
              projectId: binding.scope.projectId,
              cwd: binding.scope.cwd,
              runId: result.runId,
              toolCallId: id,
              toolName: tool.name
            },
            resultBinding.capability,
            combined
          )
          // The exact execute invocation is acknowledged only after authenticated full consumption.
          await binding.resultConsumed(call, result.invocationId, combined)
          if (!binding.active(ctx)) throw new Error('Phi child host result expired')
          return payload
        } catch {
          binding.revoke()
          throw new Error('Phi child host execution was refused or interrupted')
        }
      }
    })
  }
  return installed
}
