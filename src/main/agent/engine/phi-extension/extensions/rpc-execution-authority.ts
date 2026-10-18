import { realpathSync } from 'node:fs'
import type { ExtensionContext, ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import type { RpcTaskCall, RpcTaskParentRun, RpcVerifiedChildDispatch } from './rpc-task-admission'
import {
  createApprovalEnvelope,
  sameApprovalIdentity,
  validApprovalIdentity
} from '../lib/rpc-approval-protocol'
import { projectToolBoundaryDecision } from '../lib/project-boundary'
import { remoteUrlGuardDecision } from '../lib/remote-url'
import { classifyXdevCall } from '../lib/rpc-xdev'
import type { RpcApprovalReadiness } from './rpc-tool-approval'
import {
  executionBinding,
  executionLaunchIdentity,
  executionCapability,
  executionInput,
  executionRoster,
  MAX_EXECUTION_CALLS,
  parseExecutionMessage,
  RPC_EXECUTION_COMMAND,
  RPC_EXECUTION_DESCRIPTION,
  signExecutionMessage,
  type RpcExecutionLaunchIdentity,
  type RpcExecutionTool,
  type RpcExecutionControl,
  type RpcExecutionRetired
} from '../lib/rpc-execution-protocol'

/** Content-free diagnostic code; never echoes the error text, which may quote model input. */
function refusalCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message === 'Invalid approval identity') return 'invalid-call-identity'
  if (message === 'Invalid execution input') return 'invalid-input-schema'
  if (message.startsWith('Canonical JSON envelope')) return 'input-too-large'
  if (message.startsWith('Approval ') || message.startsWith('Invalid approval'))
    return 'invalid-input-shape'
  return 'internal'
}

export function createRpcExecutionAuthorityExtension(options: {
  identity: RpcExecutionLaunchIdentity
  capability: string
  roster: readonly RpcExecutionTool[]
  allowNativeTask?: boolean
  admitTask?: (event: RpcTaskCall, ctx: ExtensionContext) => void
  childPreflight?: RpcVerifiedChildDispatch
}): {
  extension: ExtensionFactory
  readiness(): Readonly<RpcApprovalReadiness> | undefined
  taskParent(): Readonly<RpcTaskParentRun> | undefined
  /** True while the current run's `write xd://<name>` transport call awaits its nested host call. */
  xdevDispatching(toolCallId: string, name: string): boolean
  revokeTaskParent(run: Readonly<RpcTaskParentRun>): void
} {
  if (
    !executionCapability(options.capability) ||
    !validApprovalIdentity({ ...options.identity, ompSessionId: 'validate', runId: 'validate' })
  )
    throw new Error('Invalid execution authority configuration')
  const identity = executionLaunchIdentity(options.identity)
  const capability = options.capability
  const roster = executionRoster(options.roster, { allowNativeTask: options.allowNativeTask })
  if (options.allowNativeTask === true && !options.admitTask)
    throw new Error('Native task requires exact root admission')
  if (JSON.stringify({ identity, roster }).includes(capability))
    throw new Error('Execution capability overlaps public configuration')
  const tools = new Map(roster.tools.map((tool) => [tool.name, tool]))
  let activated = false
  let sequence = 0
  let latestControl: RpcExecutionControl | undefined
  let current:
    | {
        control: RpcExecutionControl
        signal: AbortController
        originSequence: number
        seen: Set<string>
        /** toolCallId -> host tool named by an admitted `write xd://<name>` transport call. */
        xdev: Map<string, string>
      }
    | undefined
  let ompSessionId: string | undefined
  const revoke = (): void => {
    const old = current
    current = undefined
    old?.signal.abort()
  }
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand(RPC_EXECUTION_COMMAND, {
      description: RPC_EXECUTION_DESCRIPTION,
      handler: async (args, ctx) => {
        const request = parseExecutionMessage(args, capability)
        const actual = ctx.sessionManager.getSessionId()
        if (
          !request ||
          request.type !== 'phi_rpc_execution_control' ||
          ctx.agent.kind !== 'main' ||
          realpathSync(ctx.cwd) !== identity.cwd ||
          request.ompSessionId !== actual ||
          request.rosterHash !== roster.hash ||
          !sameApprovalIdentity(request, {
            ...identity,
            ompSessionId: actual,
            runId: request.runId
          }) ||
          request.sequence !== sequence + 1 ||
          (ompSessionId && ompSessionId !== actual)
        )
          throw new Error('Execution authority control refused')
        if (request.action === 'activate') {
          if (activated || current || !ctx.isIdle() || request.runId !== 'bridge-ready')
            throw new Error('Execution authority activation refused')
          activated = true
          ompSessionId = actual
        } else if (request.action === 'begin') {
          if (!activated || current || !ctx.isIdle() || request.runId === 'bridge-ready')
            throw new Error('Execution authority run refused')
          current = {
            control: request,
            signal: new AbortController(),
            originSequence: 0,
            seen: new Set(),
            xdev: new Map()
          }
        } else {
          if (!activated || (current && current.control.runId !== request.runId))
            throw new Error('Execution authority retirement refused')
          revoke()
          ctx.abort()
        }
        sequence = request.sequence
        latestControl = request
        ctx.ui.notify(
          JSON.stringify(
            signExecutionMessage(
              {
                ...executionBinding(request),
                action: request.action,
                requestId: request.requestId,
                type: 'phi_rpc_execution_ack'
              },
              capability
            )
          ),
          'info'
        )
      }
    })
    const retire = (
      reason: RpcExecutionRetired['reason'],
      notify: (message: string) => void
    ): void => {
      const control = current?.control ?? (reason !== 'finished' ? latestControl : undefined)
      revoke()
      if (control) {
        const binding = executionBinding(control)
        notify(
          JSON.stringify(
            signExecutionMessage(
              { ...binding, type: 'phi_rpc_execution_retired', reason },
              capability
            )
          )
        )
      }
    }
    pi.on('tool_call', async (event, ctx) => {
      if (ctx.agent.kind !== 'main') {
        try {
          return (
            options.childPreflight?.(event, ctx) ?? {
              block: true,
              reason: 'Phi main execution authority unavailable'
            }
          )
        } catch {
          return { block: true, reason: 'Phi main execution authority unavailable' }
        }
      }
      const run = current
      try {
        const tool = tools.get(event.toolName)
        // OMP re-dispatches `write xd://<host tool>` as a nested call of that tool with the same
        // toolCallId. The transport call signs nothing: the nested call is authorised exactly like a
        // direct host call (its own schema projection, origin and approval), once per transport call.
        const nested = tool?.site === 'host' && run?.xdev.get(event.toolCallId) === event.toolName
        if (
          !activated ||
          !run ||
          run.signal.signal.aborted ||
          !tool ||
          ctx.agent.kind !== 'main' ||
          ctx.sessionManager.getSessionId() !== ompSessionId ||
          realpathSync(ctx.cwd) !== identity.cwd ||
          (!nested && (run.seen.has(event.toolCallId) || run.seen.size >= MAX_EXECUTION_CALLS))
        )
          return { block: true, reason: 'Phi main execution authority unavailable' }
        if (nested) run.xdev.delete(event.toolCallId)
        const xdev = classifyXdevCall(event.toolName, event.input)
        if (xdev?.kind === 'refused')
          return { block: true, reason: 'Phi refuses this xd:// device call' }
        if (xdev?.kind === 'dispatch') {
          // Only a roster host tool may be driven through the transport; native tools, OMP's own
          // devices and unknown names stay refused. No origin is signed for the transport itself.
          if (tools.get(xdev.name)?.site !== 'host')
            return { block: true, reason: 'Phi refuses this xd:// device call' }
          run.seen.add(event.toolCallId)
          run.xdev.set(event.toolCallId, xdev.name)
          return undefined
        }
        if (event.toolName === 'task') {
          if (!options.admitTask) return { block: true, reason: 'Phi native task is unavailable' }
          options.admitTask(event, ctx)
        }
        const input = executionInput(tool, event.input)
        if (
          !projectToolBoundaryDecision(identity.cwd, event.toolName, input).allowed ||
          !remoteUrlGuardDecision(event.toolName, input).allowed
        )
          return { block: true, reason: 'Phi project boundary refused this call' }
        const envelope = createApprovalEnvelope(
          run.control,
          event.toolCallId,
          event.toolName,
          input
        )
        const binding = executionBinding(run.control)
        run.seen.add(event.toolCallId)
        ctx.ui.notify(
          JSON.stringify(
            signExecutionMessage(
              {
                ...binding,
                type: 'phi_rpc_execution_origin',
                originSequence: ++run.originSequence,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                inputDigest: envelope.inputDigest
              },
              capability
            )
          ),
          'info'
        )
        // Host execution must receive exactly the schema projection authenticated above.
        return tool.site === 'host' ? { input: JSON.parse(JSON.stringify(input)) } : undefined
      } catch (error) {
        return {
          block: true,
          reason: `Phi main execution authority refused input (${refusalCode(error)})`
        }
      }
    })
    pi.on('agent_end', (event, ctx) => {
      if (ctx.agent.kind === 'main' && !event.willContinue)
        retire('finished', (message) => ctx.ui.notify(message, 'info'))
    })
    pi.on('session_before_switch', (_, ctx) => {
      if (ctx.agent.kind !== 'main') return
      retire('session-change', (message) => ctx.ui.notify(message, 'info'))
      activated = false
    })
    pi.on('session_before_branch', (_, ctx) => {
      if (ctx.agent.kind !== 'main') return
      retire('session-change', (message) => ctx.ui.notify(message, 'info'))
      activated = false
    })
    pi.on('session_switch', (_, ctx) => {
      if (ctx.agent.kind !== 'main') return
      retire('session-change', (message) => ctx.ui.notify(message, 'info'))
      activated = false
    })
    pi.on('session_shutdown', (_, ctx) => {
      if (ctx.agent.kind !== 'main') return
      retire('shutdown', (message) => ctx.ui.notify(message, 'info'))
      activated = false
    })
  }
  return {
    extension,
    taskParent: () =>
      current && activated
        ? Object.freeze({
            runId: current.control.runId,
            controlSequence: current.control.sequence,
            signal: current.signal.signal
          })
        : undefined,
    xdevDispatching: (toolCallId, name) =>
      current !== undefined && activated && current.xdev.get(toolCallId) === name,
    revokeTaskParent: (run) => {
      if (
        current?.control.runId === run.runId &&
        current.control.sequence === run.controlSequence &&
        current.signal.signal === run.signal
      )
        revoke()
    },
    readiness: () =>
      current && activated && ompSessionId
        ? Object.freeze({
            ...identity,
            ompSessionId,
            runId: current.control.runId,
            signal: current.signal.signal
          })
        : undefined
  }
}
