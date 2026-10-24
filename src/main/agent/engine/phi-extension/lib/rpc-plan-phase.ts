import type { PhiWorkMode } from '../host'
import { RPC_MARKDOWN_PLAN_PROPOSAL_TOOL } from './rpc-prompt-policy'

export const RPC_ENTER_PLAN_MODE_TOOL = 'enter_plan_mode'
export const RPC_STRUCTURED_PLAN_PROPOSAL_TOOL = 'propose_plan_steps'
const transitionTools = new Set([
  RPC_ENTER_PLAN_MODE_TOOL,
  RPC_MARKDOWN_PLAN_PROPOSAL_TOOL,
  RPC_STRUCTURED_PLAN_PROPOSAL_TOOL
])
export const isRpcPlanTransitionTool = (name: string): boolean => transitionTools.has(name)

export interface RpcPlanRunBinding {
  readonly generation: number
  readonly phiSessionId: string
  readonly projectId: string
  readonly cwd: string
  readonly ompSessionId: string
  readonly runId: string
  readonly signal: AbortSignal
}

type Phase =
  | 'open'
  | 'manual-review'
  | 'structured-review'
  | 'manual-entry-pending'
  | 'structured-entry-pending'
  | 'manual-pending'
  | 'manual-approved'
  | 'terminal'
type Pending = {
  name: string
  toolCallId: string
  title?: string
  execute?: boolean
  reason?: string
}
type RunState = {
  binding: RpcPlanRunBinding
  phase: Phase
  batch: 'mixed' | string | undefined
  pending?: Pending
}

function sameRun(a: RpcPlanRunBinding, b: RpcPlanRunBinding): boolean {
  return (
    a.generation === b.generation &&
    a.phiSessionId === b.phiSessionId &&
    a.projectId === b.projectId &&
    a.cwd === b.cwd &&
    a.ompSessionId === b.ompSessionId &&
    a.runId === b.runId &&
    a.signal === b.signal &&
    !a.signal.aborted
  )
}

const initialPhase = (mode: PhiWorkMode | undefined): Phase =>
  mode === 'plan' ? 'manual-review' : mode === 'plan_execute' ? 'structured-review' : 'open'

export class RpcPlanPhase {
  private current?: RunState

  constructor(private readonly initialMode: PhiWorkMode | undefined) {}

  private state(binding: RpcPlanRunBinding | undefined): RunState | undefined {
    if (!binding || binding.signal.aborted) {
      this.current = undefined
      return undefined
    }
    if (!this.current || !sameRun(this.current.binding, binding))
      this.current = { binding, phase: initialPhase(this.initialMode), batch: undefined }
    return this.current
  }

  mode(binding: RpcPlanRunBinding | undefined): PhiWorkMode | undefined {
    const phase = this.state(binding)?.phase
    if (phase === 'manual-review' || phase === 'manual-pending' || phase === 'manual-entry-pending')
      return 'plan'
    if (phase === 'structured-review' || phase === 'structured-entry-pending') return 'plan_execute'
    if (phase === 'manual-approved') return 'direct'
    return this.initialMode
  }

  assistantMessage(binding: RpcPlanRunBinding | undefined, toolNames: readonly string[]): void {
    const state = this.state(binding)
    if (!state) return
    if (state.phase === 'manual-pending') state.phase = 'manual-approved'
    if (state.phase === 'manual-entry-pending') state.phase = 'manual-review'
    if (state.phase === 'structured-entry-pending') state.phase = 'structured-review'
    const hasTransition = toolNames.some((name) => transitionTools.has(name))
    state.batch = hasTransition
      ? toolNames.length === 1 && transitionTools.has(toolNames[0])
        ? toolNames[0]
        : 'mixed'
      : undefined
  }

  toolCall(
    binding: RpcPlanRunBinding | undefined,
    toolCallId: string,
    name: string,
    input: unknown,
    installed: (name: string) => boolean
  ): { allowed: boolean; reason?: string } {
    const state = this.state(binding)
    if (!state) return { allowed: false, reason: 'Phi plan run is unavailable' }
    if (
      state.batch === 'mixed' ||
      state.phase === 'terminal' ||
      state.phase === 'manual-pending' ||
      state.phase === 'manual-entry-pending' ||
      state.phase === 'structured-entry-pending' ||
      state.pending
    )
      return { allowed: false, reason: 'Plan transition requires an exclusive current response' }
    if (!transitionTools.has(name)) return { allowed: true }
    if (state.batch !== name || !installed(name))
      return { allowed: false, reason: 'Plan transition must be the sole authenticated tool call' }
    if (name === RPC_ENTER_PLAN_MODE_TOOL) {
      if (state.phase !== 'open' || this.initialMode !== 'auto')
        return { allowed: false, reason: 'Automatic plan entry is unavailable' }
      const value = input as { execute?: unknown; reason?: unknown } | null
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'execute,reason'
      )
        return { allowed: false, reason: 'Automatic plan input is invalid' }
      const reason = typeof value?.reason === 'string' ? value.reason.trim() : ''
      if (
        typeof value?.execute !== 'boolean' ||
        !reason ||
        value.reason !== reason ||
        Array.from(reason).length > 200
      )
        return { allowed: false, reason: 'Automatic plan reason is invalid' }
      state.pending = { name, toolCallId, execute: value.execute, reason }
    } else if (name === RPC_MARKDOWN_PLAN_PROPOSAL_TOOL) {
      if (state.phase !== 'manual-review')
        return { allowed: false, reason: 'Manual plan review is unavailable' }
      state.pending = { name, toolCallId, title: (input as { title?: string })?.title }
    } else {
      if (state.phase !== 'structured-review')
        return { allowed: false, reason: 'Structured plan review is unavailable' }
      state.pending = { name, toolCallId }
    }
    return { allowed: true }
  }

  verifiedResult(
    binding: RpcPlanRunBinding,
    toolCallId: string,
    name: string,
    result: { isError?: boolean; details?: unknown }
  ): void {
    const state = this.state(binding)
    const pending = state?.pending
    if (!state || !pending || pending.name !== name || pending.toolCallId !== toolCallId)
      throw new Error('Plan result has no current exclusive call')
    state.pending = undefined
    state.batch = undefined
    if (result.isError) return
    const details = result.details
    if (!details || typeof details !== 'object' || Array.isArray(details))
      throw new Error('Plan result has no signed decision')
    const decision = (details as { decision?: unknown }).decision
    if (name === RPC_ENTER_PLAN_MODE_TOOL) {
      const expected = pending.execute ? 'plan_execute' : 'plan'
      if (decision !== expected || (details as { reason?: unknown }).reason !== pending.reason)
        throw new Error('Plan entry result does not match the request')
      state.phase = pending.execute ? 'structured-entry-pending' : 'manual-entry-pending'
      return
    }
    if (!['approve', 'revise', 'cancel'].includes(String(decision)))
      throw new Error('Plan review decision is invalid')
    if (name === RPC_MARKDOWN_PLAN_PROPOSAL_TOOL) {
      if (
        (details as { title?: unknown }).title !== pending.title ||
        (details as { planFilePath?: unknown }).planFilePath !== 'local://PLAN.md'
      )
        throw new Error('Plan review draft identity changed')
      if (decision === 'approve') state.phase = 'manual-pending'
      if (decision === 'cancel') state.phase = 'terminal'
      return
    }
    if (decision === 'approve') {
      const planRunId = (details as { planRunId?: unknown }).planRunId
      if (typeof planRunId !== 'string' || !planRunId.trim() || planRunId.length > 256)
        throw new Error('Structured plan run confirmation is missing')
    }
    if (decision !== 'revise') state.phase = 'terminal'
  }

  failedPreflight(binding: RpcPlanRunBinding, toolCallId: string): void {
    const state = this.state(binding)
    if (state?.pending?.toolCallId === toolCallId) state.pending = undefined
  }

  clear(): void {
    this.current = undefined
  }
}
