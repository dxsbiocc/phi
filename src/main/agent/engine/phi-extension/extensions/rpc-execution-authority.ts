import { realpathSync } from 'node:fs'
import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import {
  createApprovalEnvelope,
  sameApprovalIdentity,
  validApprovalIdentity
} from '../lib/rpc-approval-protocol'
import { projectToolBoundaryDecision } from '../lib/project-boundary'
import { remoteUrlGuardDecision } from '../lib/remote-url'
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

export function createRpcExecutionAuthorityExtension(options: {
  identity: RpcExecutionLaunchIdentity
  capability: string
  roster: readonly RpcExecutionTool[]
}): { extension: ExtensionFactory; readiness(): Readonly<RpcApprovalReadiness> | undefined } {
  if (
    !executionCapability(options.capability) ||
    !validApprovalIdentity({ ...options.identity, ompSessionId: 'validate', runId: 'validate' })
  )
    throw new Error('Invalid execution authority configuration')
  const identity = executionLaunchIdentity(options.identity)
  const capability = options.capability
  const roster = executionRoster(options.roster)
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
            seen: new Set()
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
      const run = current
      try {
        const tool = tools.get(event.toolName)
        if (
          !activated ||
          !run ||
          run.signal.signal.aborted ||
          !tool ||
          ctx.agent.kind !== 'main' ||
          ctx.sessionManager.getSessionId() !== ompSessionId ||
          realpathSync(ctx.cwd) !== identity.cwd ||
          run.seen.has(event.toolCallId) ||
          run.seen.size >= MAX_EXECUTION_CALLS
        )
          return { block: true, reason: 'Phi main execution authority unavailable' }
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
      } catch {
        return { block: true, reason: 'Phi main execution authority refused input' }
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
