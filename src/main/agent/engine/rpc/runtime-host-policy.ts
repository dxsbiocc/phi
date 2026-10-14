import { randomUUID } from 'node:crypto'
import type { ToolApprovalRequest } from '../../tool-approval'
import type { PhiTool, PhiToolApproval } from '../types'
import { createApprovalEnvelope } from '../phi-extension/lib/rpc-approval-protocol'
import type { RpcExecutionIdentity } from '../phi-extension/lib/rpc-execution-protocol'
import { isRpcDesktopCoordinatedTool } from './desktop-tool-scope'
import type {
  RpcApprovalBridgeOptions,
  RpcApprovalDecision,
  RpcApprovalEvent
} from './approval-bridge'
import type { RpcExecutionRun } from './execution-authority'
import type { RpcHostToolRun } from './host-tool-bridge'
import { withRemoteSignal } from './history-pager'

export interface RpcRuntimeHostPolicyOptions {
  readonly tools: readonly PhiTool[]
  readonly currentRun: () => RpcExecutionRun | undefined
  readonly identity: () => Readonly<RpcExecutionIdentity>
  readonly signal: AbortSignal
  readonly approval: Pick<
    RpcApprovalBridgeOptions,
    'shouldGate' | 'requestToolApproval' | 'onEvent'
  > & { projectName?: string }
  /** Trusted live script/project classifier. Undefined is an explicit refusal. */
  readonly hostApprovalFor?: (
    toolName: string,
    input: Readonly<Record<string, unknown>>
  ) => PhiToolApproval | undefined
  readonly onDenied: (runId: string) => void
}
const rank = { read: 0, write: 1, exec: 2 } as const
/** Preserves signed-call authority and adds the desktop host policy before any host executor. */
export function createRpcRuntimeHostPolicy(options: RpcRuntimeHostPolicyOptions): {
  currentRun(): RpcHostToolRun | undefined
} {
  if (
    typeof options.approval?.shouldGate !== 'function' ||
    typeof options.approval?.requestToolApproval !== 'function' ||
    (options.hostApprovalFor !== undefined && typeof options.hostApprovalFor !== 'function')
  )
    throw new Error('Remote host policy requires trusted live policy and approval UI callbacks')
  const tools = new Map(
    options.tools.map((tool) => [
      tool.name,
      { approval: tool.approval, coordinated: isRpcDesktopCoordinatedTool(tool) }
    ])
  )
  for (const tool of tools.values()) {
    if (tool.approval !== undefined && !Object.hasOwn(rank, tool.approval))
      throw new Error('Invalid remote host approval classification')
    if (!tool.approval && !options.hostApprovalFor)
      throw new Error('Remote host tools require an explicit trusted approval classification')
  }
  const bindings = new WeakMap<RpcExecutionRun, RpcHostToolRun>()
  return {
    currentRun() {
      const original = options.currentRun()
      if (!original || original.signal.aborted || options.signal.aborted) return undefined
      const existing = bindings.get(original)
      if (existing) return existing
      const seen = new Set<string>()
      const wrapper: RpcHostToolRun = Object.freeze({
        id: original.id,
        signal: original.signal,
        async authorizeCall(
          toolCallId: string,
          name: string,
          input: Readonly<Record<string, unknown>>,
          signal: AbortSignal
        ) {
          const metadata = tools.get(name)
          if (!metadata || seen.has(toolCallId) || seen.size >= 4096) return undefined
          seen.add(toolCallId)
          const joined = AbortSignal.any([signal, original.signal, options.signal])
          const live = (): boolean =>
            !joined.aborted &&
            options.currentRun() === original &&
            original.authorizeCall === capturedAuthority
          const capturedAuthority = original.authorizeCall
          const classify = (): PhiToolApproval | undefined => {
            const dynamic = options.hostApprovalFor?.(name, input)
            if (options.hostApprovalFor && !dynamic) return undefined
            if (dynamic && !Object.hasOwn(rank, dynamic)) return undefined
            if (metadata.approval && !Object.hasOwn(rank, metadata.approval)) return undefined
            return dynamic && (!metadata.approval || rank[dynamic] > rank[metadata.approval])
              ? dynamic
              : metadata.approval
          }
          let request: Readonly<ToolApprovalRequest> | undefined
          const notify = (type: RpcApprovalEvent['type']): void => {
            if (!request) return
            try {
              void Promise.resolve(
                options.approval.onEvent?.({
                  type,
                  approvalId: request.requestId,
                  sessionId: request.sessionId!,
                  runId: original.id,
                  toolCallId,
                  request
                })
              ).catch(() => undefined)
            } catch {
              /* An observer cannot authorize or fail a tool operation. */
            }
          }
          try {
            if (
              !live() ||
              (await withRemoteSignal(
                Promise.resolve(capturedAuthority.call(original, toolCallId, name, input, joined)),
                joined
              )) !== 'main' ||
              !live()
            )
              return undefined
            const identity = options.identity()
            const envelope = createApprovalEnvelope(
              { ...identity, runId: original.id },
              toolCallId,
              name,
              input
            )
            const initial = classify()
            if (!initial) {
              options.onDenied(original.id)
              return undefined
            }
            // These are genuine scope-built browser/environment tools with their
            // own coordinator UI. Copies and name-only claims never receive this brand.
            if (metadata.coordinated || initial === 'read') return live() ? 'main' : undefined
            request = Object.freeze({
              requestId: randomUUID(),
              sessionId: identity.phiSessionId,
              sessionGeneration: identity.generation,
              runId: original.id,
              cwd: identity.cwd,
              ...(options.approval.projectName
                ? { projectName: options.approval.projectName }
                : {}),
              toolCallId,
              toolName: name,
              approvalDigest: envelope.inputDigest,
              ...(typeof input.command === 'string' ? { command: input.command } : {}),
              summary:
                typeof input.command === 'string'
                  ? input.command
                  : typeof input.path === 'string'
                    ? `${name}: ${input.path}`
                    : name
            })
            const gate = options.approval.shouldGate(request)
            if (typeof gate !== 'boolean' || !live() || classify() !== initial || !live()) {
              options.onDenied(original.id)
              return undefined
            }
            let decision: RpcApprovalDecision = 'approved'
            if (gate) {
              await notify('approval_requested')
              if (!live()) {
                await notify('approval_cancelled')
                return undefined
              }
              decision = await withRemoteSignal(
                Promise.resolve().then(() => {
                  joined.throwIfAborted()
                  return options.approval.requestToolApproval(request!, joined)
                }),
                joined
              )
            }
            const after = createApprovalEnvelope(
              { ...identity, runId: original.id },
              toolCallId,
              name,
              input
            )
            const currentGate = options.approval.shouldGate(request)
            if (
              !live() ||
              classify() !== initial ||
              after.inputDigest !== envelope.inputDigest ||
              typeof currentGate !== 'boolean' ||
              (!gate && currentGate) ||
              (await withRemoteSignal(
                Promise.resolve(capturedAuthority.call(original, toolCallId, name, input, joined)),
                joined
              )) !== 'main' ||
              !live()
            ) {
              if (!joined.aborted) options.onDenied(original.id)
              await notify('approval_cancelled')
              return undefined
            }
            if (decision !== 'approved') {
              if (decision !== 'cancelled') options.onDenied(original.id)
              await notify(decision === 'cancelled' ? 'approval_cancelled' : 'approval_denied')
              return undefined
            }
            // Authorization commits after the final trusted checks above. Observers
            // may stop execution, but cannot roll this decision into a second terminal.
            const committed = 'main' as const
            notify('approval_approved')
            return committed
          } catch {
            if (request) await notify(joined.aborted ? 'approval_cancelled' : 'approval_denied')
            if (!joined.aborted) options.onDenied(original.id)
            return undefined
          }
        }
      })
      bindings.set(original, wrapper)
      return wrapper
    }
  }
}
