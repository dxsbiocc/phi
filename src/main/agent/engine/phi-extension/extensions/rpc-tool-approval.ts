import { realpathSync } from 'node:fs'
import type { ExtensionContext, ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import type { RpcTaskCall, RpcTaskParentRun, RpcVerifiedChildDispatch } from './rpc-task-admission'
import {
  createApprovalEnvelope,
  RPC_APPROVAL_TITLE,
  sameApprovalIdentity,
  validApprovalIdentity,
  type RpcApprovalIdentity
} from '../lib/rpc-approval-protocol'
import { projectToolBoundaryDecision } from '../lib/project-boundary'
import { remoteUrlGuardDecision } from '../lib/remote-url'

export interface RpcApprovalReadiness extends RpcApprovalIdentity {
  readonly signal: AbortSignal
}

export interface RpcToolApprovalOptions {
  /** Injected only after root's bridge-ready handshake, never from tool arguments. */
  readiness(): Readonly<RpcApprovalReadiness> | undefined
  /** Trusted roster/policy; host tools retain their coordinator's own approvals. */
  classifyTool(
    toolName: string,
    input: Readonly<Record<string, unknown>>
  ): 'read' | 'write' | 'exec' | 'host' | 'delegate' | undefined
  admitTask?: (event: RpcTaskCall, ctx: ExtensionContext) => void
  childPreflight?: RpcVerifiedChildDispatch
  /** R6 opt-in: a negative MAIN decision ends only its still-current turn. */
  mainNegativeApproval?: {
    parentRun(): Readonly<RpcTaskParentRun> | undefined
    sealParent(run: Readonly<RpcTaskParentRun>, ctx: ExtensionContext): void
  }
}
const nativeRisky = new Set(['write', 'edit', 'bash', 'powershell'])
const blocked = { block: true as const, reason: 'Phi main RPC approval is unavailable or denied' }

/** Foundation only: production rpc-entry remains readonly until root composes attested R5. */
export function createRpcToolApprovalExtension(options: RpcToolApprovalOptions): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event, ctx) => {
      if (ctx.agent.kind !== 'main') {
        try {
          return options.childPreflight?.(event, ctx) ?? blocked
        } catch {
          return blocked
        }
      }
      try {
        const ready = options.readiness()
        if (
          !ready ||
          !validApprovalIdentity(ready) ||
          ctx.agent.kind !== 'main' ||
          ctx.sessionManager.getSessionId() !== ready.ompSessionId ||
          realpathSync(ctx.cwd) !== ready.cwd ||
          ready.signal.aborted
        )
          return blocked
        const identity = Object.freeze({ ...ready })
        const envelope = createApprovalEnvelope(
          identity,
          event.toolCallId,
          event.toolName,
          event.input
        )
        const boundary = projectToolBoundaryDecision(identity.cwd, event.toolName, envelope.input)
        const url = remoteUrlGuardDecision(event.toolName, envelope.input)
        if (!boundary.allowed || !url.allowed)
          return { block: true, reason: boundary.reason ?? url.reason }
        const classification = options.classifyTool(event.toolName, envelope.input)
        if (!classification) return blocked
        if (event.toolName === 'task' || classification === 'delegate') {
          if (event.toolName !== 'task' || classification !== 'delegate' || !options.admitTask)
            return blocked
          options.admitTask(event, ctx)
          return undefined
        }
        if (
          !nativeRisky.has(event.toolName) &&
          (classification === 'read' || classification === 'host')
        )
          return undefined
        // Native mutation/command tools never inherit a read/host policy classification.
        if (classification !== 'write' && classification !== 'exec') return blocked
        const parent = options.mainNegativeApproval?.parentRun()
        if (
          options.mainNegativeApproval &&
          (!parent ||
            parent.runId !== identity.runId ||
            parent.signal !== ready.signal ||
            !Number.isSafeInteger(parent.controlSequence) ||
            parent.controlSequence < 1)
        )
          return blocked
        // Public wrapped UI pauses the real handler budget. No human deadline is introduced.
        const approved = await ctx.ui.confirm(RPC_APPROVAL_TITLE, JSON.stringify(envelope), {
          signal: ready.signal
        })
        const current = options.readiness()
        if (!approved) {
          const currentParent = options.mainNegativeApproval?.parentRun()
          if (
            parent &&
            currentParent?.runId === parent.runId &&
            currentParent.controlSequence === parent.controlSequence &&
            currentParent.signal === parent.signal &&
            current &&
            sameApprovalIdentity(identity, current) &&
            current.signal === ready.signal &&
            ctx.agent.kind === 'main' &&
            ctx.sessionManager.getSessionId() === identity.ompSessionId &&
            realpathSync(ctx.cwd) === identity.cwd
          )
            options.mainNegativeApproval?.sealParent(parent, ctx)
          return blocked
        }
        if (
          ctx.agent.kind !== 'main' ||
          ctx.sessionManager.getSessionId() !== identity.ompSessionId ||
          realpathSync(ctx.cwd) !== identity.cwd ||
          ready.signal.aborted ||
          !current ||
          !sameApprovalIdentity(identity, current) ||
          current.signal !== ready.signal ||
          current.signal.aborted
        )
          return blocked
        // Recheck the effective input and live classification after the asynchronous dialog.
        const after = createApprovalEnvelope(
          identity,
          event.toolCallId,
          event.toolName,
          event.input
        )
        if (
          after.inputDigest !== envelope.inputDigest ||
          options.classifyTool(event.toolName, after.input) !== classification
        )
          return blocked
        return undefined
      } catch {
        return blocked
      }
    })
  }
}
