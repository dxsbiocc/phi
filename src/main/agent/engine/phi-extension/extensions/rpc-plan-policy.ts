import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import {
  assertRpcPlanDraftMutationTarget,
  bindRpcMarkdownPlanProposal
} from '../lib/rpc-plan-draft'
import { rpcPlanningToolDecision, RPC_MARKDOWN_PLAN_PROPOSAL_TOOL } from '../lib/rpc-prompt-policy'
import { loadRpcPromptPolicy } from '../lib/rpc-prompt-policy-reader'
import type { RpcRuntimeConfig } from '../lib/rpc-runtime-config'
import {
  RpcPlanPhase,
  RPC_ENTER_PLAN_MODE_TOOL,
  type RpcPlanRunBinding
} from '../lib/rpc-plan-phase'

/** SDK handler inputs are shared; bind sole-call proof before execution origin signing. */
export function bindExclusiveRpcPlanEntry(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || !Object.isExtensible(input))
    throw new Error('Automatic plan input cannot be signed')
  Object.assign(input, { soleCall: true })
  if ((input as { soleCall?: unknown }).soleCall !== true)
    throw new Error('Automatic plan exclusivity could not be signed')
  return input as Record<string, unknown>
}

/** A signed session policy gates every main-agent planning call before execution origin signing. */
export function createRpcPlanningPolicyExtension(
  runtime: RpcRuntimeConfig,
  readiness: () => RpcPlanRunBinding | undefined
): { extension: ExtensionFactory; phase: RpcPlanPhase } {
  const policy = loadRpcPromptPolicy(runtime)
  const mode = policy?.workMode
  const phase = new RpcPlanPhase(mode)
  const installed = (name: string): boolean =>
    runtime.activeTools.includes(name) &&
    runtime.execution.tools.some((tool) => tool.site === 'host' && tool.name === name)
  const markdownReviewInstalled = installed(RPC_MARKDOWN_PLAN_PROPOSAL_TOOL)
  const extension: ExtensionFactory = (pi) => {
    pi.on('assistant_message', (event, ctx) => {
      if (ctx.agent.kind !== 'main') return
      phase.assistantMessage(
        readiness(),
        event.message.content.filter((part) => part.type === 'toolCall').map((part) => part.name)
      )
    })
    pi.on('tool_call', (event, ctx) => {
      if (ctx.agent.kind !== 'main') return undefined
      // A changed or removed publication cannot silently lift the read-only boundary.
      const current = loadRpcPromptPolicy(runtime)
      if (current?.workMode !== mode)
        return { block: true, reason: 'Phi RPC planning policy is unavailable' }
      const ready = readiness()
      if (
        !ready ||
        ready.ompSessionId !== ctx.sessionManager.getSessionId() ||
        ready.generation !== runtime.generation ||
        ready.phiSessionId !== runtime.phiSessionId ||
        ready.projectId !== runtime.projectId ||
        ready.cwd !== runtime.projectRoot
      )
        return { block: true, reason: 'Phi RPC plan run is unavailable' }
      const admission = phase.toolCall(
        ready,
        event.toolCallId,
        event.toolName,
        event.input,
        installed
      )
      if (!admission.allowed) return { block: true, reason: admission.reason }
      if (event.toolName === RPC_ENTER_PLAN_MODE_TOOL) {
        try {
          return { input: bindExclusiveRpcPlanEntry(event.input) }
        } catch {
          phase.failedPreflight(ready, event.toolCallId)
          return { block: true, reason: 'Automatic plan entry cannot be signed' }
        }
      }
      const activeMode = phase.mode(ready)
      if (activeMode !== 'plan' && activeMode !== 'plan_execute') return undefined
      const decision = rpcPlanningToolDecision(
        activeMode,
        event.toolName,
        event.input,
        markdownReviewInstalled
      )
      if (!decision.allowed) {
        phase.failedPreflight(ready, event.toolCallId)
        return { block: true, reason: decision.reason }
      }
      if (activeMode === 'plan' && (event.toolName === 'write' || event.toolName === 'edit')) {
        try {
          assertRpcPlanDraftMutationTarget(ctx.sessionManager)
        } catch {
          phase.failedPreflight(ready, event.toolCallId)
          return { block: true, reason: 'Session plan draft target is unsafe' }
        }
      }
      if (activeMode === 'plan' && event.toolName === RPC_MARKDOWN_PLAN_PROPOSAL_TOOL) {
        try {
          return { input: bindRpcMarkdownPlanProposal(ctx.sessionManager, event.input) }
        } catch {
          phase.failedPreflight(ready, event.toolCallId)
          return { block: true, reason: 'Session plan draft is unavailable for review' }
        }
      }
      return undefined
    })
    pi.on('session_shutdown', () => phase.clear())
  }
  return { extension, phase }
}
