import { randomUUID } from 'node:crypto'
import type { ToolApprovalRequest } from '../../../tool-approval'
import { createRpcChildCall, type RpcChildCall } from '../../phi-extension/lib/rpc-child-protocol'
import type { RpcApprovalDecision, RpcApprovalEvent } from '../approval-bridge'
import { withRemoteSignal } from '../history-pager'
import type { RpcChildRun, RpcChildRunRegistry } from './run-registry'

export interface RpcChildApprovalOptions {
  readonly shouldGate: (request: Readonly<ToolApprovalRequest>) => boolean
  readonly requestToolApproval: (
    request: Readonly<ToolApprovalRequest>,
    signal: AbortSignal
  ) => RpcApprovalDecision | Promise<RpcApprovalDecision>
  readonly onEvent?: (event: RpcApprovalEvent) => void | Promise<void>
  readonly projectName?: string
}
export interface RpcChildApprovalPermit {
  readonly result: Promise<boolean>
  canCommit(): boolean
  /** The URI writer owns commit; retirement without a write is cancellation. */
  finish(written: boolean, allowed?: boolean): void
}
const nativeRisk = new Map([
  ['read', 'read'],
  ['write', 'write'],
  ['bash', 'exec'],
  ['powershell', 'exec']
])
/** Prepares one exact decision; only the official reply writer finalizes its approval event. */
export class RpcChildApprovalBridge {
  constructor(
    private readonly registry: RpcChildRunRegistry,
    private readonly options: RpcChildApprovalOptions
  ) {
    this.options = Object.freeze({ ...options })
    if (
      typeof options.shouldGate !== 'function' ||
      typeof options.requestToolApproval !== 'function'
    )
      throw new Error('Child approval requires live policy and UI callbacks')
  }
  prepare(run: RpcChildRun, call: RpcChildCall, signal: AbortSignal): RpcChildApprovalPermit {
    const joined = AbortSignal.any([signal, run.signal])
    const live = (): boolean => !joined.aborted && this.registry.current(run.scope) === run
    const exact = (): boolean => {
      try {
        return (
          createRpcChildCall(run.scope, call.toolCallId, call.toolName, call.input).inputDigest ===
          call.inputDigest
        )
      } catch {
        return false
      }
    }
    let finished = false,
      requested = false,
      gate: boolean | undefined
    let decision: RpcApprovalDecision = 'cancelled'
    let request: Readonly<ToolApprovalRequest> | undefined
    const notify = (type: RpcApprovalEvent['type']): void => {
      if (!request) return
      try {
        void Promise.resolve(
          this.options.onEvent?.({
            type,
            approvalId: request.requestId,
            sessionId: run.scope.phiSessionId,
            runId: run.id,
            toolCallId: call.toolCallId,
            request
          })
        ).catch(() => undefined)
      } catch {
        /* Observers cannot change the committed decision. */
      }
    }
    const canCommit = (): boolean => {
      try {
        return (
          !finished &&
          decision === 'approved' &&
          live() &&
          exact() &&
          (gate === undefined || (!!request && this.options.shouldGate(request) === gate)) &&
          !finished &&
          live()
        )
      } catch {
        return false
      }
    }
    const finish = (written: boolean, allowed = false): void => {
      if (finished) return
      finished = true
      if (requested)
        notify(
          written && allowed
            ? 'approval_approved'
            : written && decision === 'denied'
              ? 'approval_denied'
              : 'approval_cancelled'
        )
    }
    // Admission installs the permit before observers or UI can reenter retirement.
    const result = Promise.resolve().then(async (): Promise<boolean> => {
      try {
        if (finished || !live() || !exact() || !run.profile.tools.includes(call.toolName))
          return false
        const risk = nativeRisk.get(call.toolName)
        if (!risk) return false
        if (risk === 'read') {
          decision = 'approved'
          return canCommit()
        }
        request = Object.freeze({
          requestId: randomUUID(),
          sessionId: run.scope.phiSessionId,
          sessionGeneration: run.scope.generation,
          runId: run.id,
          agentRunId: run.id,
          cwd: run.scope.cwd,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          approvalDigest: call.inputDigest,
          ...(this.options.projectName ? { projectName: this.options.projectName } : {}),
          ...(typeof call.input.command === 'string' ? { command: call.input.command } : {}),
          summary:
            typeof call.input.command === 'string'
              ? call.input.command
              : typeof call.input.path === 'string'
                ? `${call.toolName}: ${call.input.path}`
                : call.toolName
        })
        gate = this.options.shouldGate(request)
        if (typeof gate !== 'boolean' || finished || !live() || !exact()) return false
        decision = 'approved'
        if (gate) {
          requested = true
          notify('approval_requested')
          if (finished || !live()) {
            decision = 'cancelled'
            return false
          }
          decision = await withRemoteSignal(
            Promise.resolve().then(() => {
              joined.throwIfAborted()
              return this.options.requestToolApproval(request!, joined)
            }),
            joined
          )
        }
        if (!canCommit()) {
          if (decision === 'approved') decision = 'cancelled'
          return false
        }
        return true
      } catch {
        decision = joined.aborted ? 'cancelled' : 'denied'
        return false
      }
    })
    return Object.freeze({ result, canCommit, finish })
  }
}
