import { lstatSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { approvalIdentifier, createApprovalEnvelope } from '../lib/rpc-approval-protocol'
import type { AgentSession, ExtensionContext, ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import {
  validateRpcForegroundTaskInput,
  childConfigDigest,
  type RpcChildRuntimeConfig
} from '../lib/rpc-child-config'
import {
  hasReservedRpcChildUri,
  projectRpcChildModel,
  projectRpcChildRoute,
  sameRpcChildModel,
  sameRpcChildRoute,
  sameRpcChildRoot,
  validateRpcChildRoot,
  type RpcChildRootScope
} from '../lib/rpc-child-protocol'
import { makeRpcTaskSettlement } from '../lib/rpc-task-settlement-protocol'

type BeforeToolCall = NonNullable<AgentSession['agent']['beforeToolCall']>
type Registry = ReturnType<Parameters<ExtensionFactory>[0]['pi']['AgentRegistry']['global']>
type AgentReference = NonNullable<ReturnType<Registry['get']>>
export interface RpcTaskParentRun {
  readonly runId: string
  readonly controlSequence: number
  readonly signal: AbortSignal
}
interface Installation {
  readonly session: AgentSession
  readonly previous: BeforeToolCall
  readonly wrapper: BeforeToolCall
}
interface SettlementParent {
  readonly run: Readonly<RpcTaskParentRun>
  readonly root: RpcChildRootScope
  readonly ref: AgentReference
  readonly session: AgentSession
  readonly calls: Set<SettlementCall>
  spawnAllowed: boolean
}
interface SettlementCall {
  readonly parent: SettlementParent
  readonly ctx: ExtensionContext
  readonly toolCallId: string
  readonly inputDigest: string
  ended: boolean
  sent: boolean
}
export interface RpcTaskAdmissionOptions {
  readonly config: Readonly<RpcChildRuntimeConfig>
  readonly signal: AbortSignal
  readonly root: () => Readonly<RpcChildRootScope> | undefined
  /** Rechecks immutable compiler publication and static private config before every task. */
  readonly assertPublication: () => void
  readonly parentRun?: () => Readonly<RpcTaskParentRun> | undefined
  readonly onChildAborted?: (run: Readonly<RpcTaskParentRun>) => void
}
export interface RpcTaskCall {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
}
export type RpcVerifiedChildDispatch = (
  event: RpcTaskCall,
  ctx: ExtensionContext
) => { block: true; reason: string } | { input: Record<string, unknown> }
/** Deliberately rejects ambient agent resources; this is a conservative policy, not SDK discovery. */
export function assertRpcTaskProjectResourcesAbsent(cwd: string): void {
  for (let directory = cwd; ; directory = dirname(directory)) {
    for (const resource of [
      '.omp/agents',
      '.omp/plugins',
      '.claude/plugins',
      '.claude/settings.json',
      '.claude/settings.local.json'
    ]) {
      try {
        lstatSync(join(directory, resource))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new Error('Project agent resources cannot be verified')
      }
      throw new Error('Project and ancestor agent resources are unsupported for native child tasks')
    }
    if (dirname(directory) === directory) break
  }
}
/** Keeps the actual native TaskTool/SDK handler and validates both public raw/effective inputs. */
export function createRpcTaskAdmissionExtension(options: RpcTaskAdmissionOptions): {
  extension: ExtensionFactory
  preflight(event: RpcTaskCall, ctx: ExtensionContext): void
  assertInstalled(ctx: ExtensionContext): void
  sealParent(run: Readonly<RpcTaskParentRun>, ctx: ExtensionContext): boolean
  isStreamActive(): boolean
  dispose(): void
} {
  const installations = new Map<AgentSession, Installation>()
  const prepared = new Map<string, { session: AgentSession; input: string }>()
  const accepted = new Map<
    string,
    {
      session: AgentSession
      agent: string
      root: RpcChildRootScope
      run: Readonly<RpcTaskParentRun>
    }
  >()
  const launches = new Map<string, { session: AgentSession; run: Readonly<RpcTaskParentRun> }>()
  const parentKey = (run: Readonly<RpcTaskParentRun>, id: string): string =>
    JSON.stringify([run.runId, run.controlSequence, id])
  const children = new Map<
    AgentReference,
    {
      session: AgentSession
      root: RpcChildRootScope
      run: Readonly<RpcTaskParentRun>
      file: string
    }
  >()
  const detach = new Set<() => void>()
  const settlementParents = new Map<AbortSignal, SettlementParent>()
  const settlementCalls = new Map<string, SettlementCall>()
  const pendingSettlements = new Map<string, SettlementCall>()
  const settledToolIds = new Set<string>()
  let blocked: Readonly<RpcTaskParentRun> | undefined
  const digest = childConfigDigest(options.config)
  let api: Parameters<ExtensionFactory>[0] | undefined
  let disposed = false
  const resources = (session: AgentSession): void => {
    assertRpcTaskProjectResourcesAbsent(options.config.projectRoot)
    const roots = session.effectiveExtensionRoots
    if (
      roots.mode !== 'explicit-only' ||
      roots.configured.length !== 0 ||
      roots.explicit.length !== 1 ||
      session.preparedExtensions?.length !== 1 ||
      session.extensionPaths?.length !== 1
    )
      throw new Error('Native child tasks require one exact trusted parent extension')
  }
  const actualRoot = (ctx: ExtensionContext): AgentSession => {
    options.signal.throwIfAborted()
    const root = options.root()
    const ref = api?.pi.AgentRegistry.global().get(ctx.agent.id)
    const session = ref?.session
    if (
      disposed ||
      !root ||
      !session ||
      ref.kind !== 'main' ||
      ctx.agent.kind !== 'main' ||
      ctx.agent.id !== root.rootAgentId ||
      session.sessionManager !== ctx.sessionManager ||
      ctx.sessionManager.getSessionId() !== root.rootOmpSessionId ||
      session.sessionId !== root.rootOmpSessionId ||
      session.sessionFile !== root.rootSessionFile ||
      realpathSync(ctx.cwd) !== root.cwd
    )
      throw new Error('Native task root authority is unavailable')
    return session
  }
  const actual = (ctx: ExtensionContext): AgentSession => {
    const session = actualRoot(ctx)
    if (childConfigDigest(options.config) !== digest)
      throw new Error('Native task root authority is unavailable')
    const expected = options.config.profiles[0]
    for (const model of [session.model, session.agent.state.model])
      if (
        !sameRpcChildModel(projectRpcChildModel(model), expected.model) ||
        !sameRpcChildRoute(projectRpcChildRoute(model), expected.route)
      )
        throw new Error('Native task parent model or route differs')
    options.assertPublication()
    return session
  }
  const savedRootMatches = (call: SettlementCall, ctx: ExtensionContext): boolean => {
    const { root, ref, session } = call.parent
    try {
      return (
        !disposed &&
        !options.signal.aborted &&
        api?.pi.AgentRegistry.global().get(root.rootAgentId) === ref &&
        ref.kind === 'main' &&
        ref.session === session &&
        ctx.agent.kind === 'main' &&
        ctx.agent.id === root.rootAgentId &&
        ctx.sessionManager === session.sessionManager &&
        ctx.sessionManager.getSessionId() === root.rootOmpSessionId &&
        session.sessionId === root.rootOmpSessionId &&
        session.sessionFile === root.rootSessionFile &&
        realpathSync(ctx.cwd) === root.cwd
      )
    } catch {
      return false
    }
  }
  const settleNoSpawn = (call: SettlementCall): void => {
    if (
      call.sent ||
      !call.ended ||
      !call.parent.run.signal.aborted ||
      call.parent.spawnAllowed ||
      !savedRootMatches(call, call.ctx)
    )
      return
    try {
      if (childConfigDigest(options.config) !== digest) return
      const receipt = makeRpcTaskSettlement(options.config, call.parent.root, {
        parentRunId: call.parent.run.runId,
        controlSequence: call.parent.run.controlSequence,
        toolCallId: call.toolCallId,
        inputDigest: call.inputDigest
      })
      call.sent = true
      settledToolIds.add(call.toolCallId)
      call.ctx.ui.notify(JSON.stringify(receipt), 'info')
    } catch {
      /* Missing delivery leaves the original task unconfirmed. */
    }
  }
  const captureSettlement = (
    event: RpcTaskCall,
    ctx: ExtensionContext,
    session: AgentSession
  ): void => {
    if (!options.parentRun) return
    const run = options.parentRun(),
      root = options.root()
    if (
      !run ||
      run.signal.aborted ||
      !root ||
      !Number.isSafeInteger(run.controlSequence) ||
      run.controlSequence < 1
    )
      throw new Error('Native task parent is unavailable')
    const scope = validateRpcChildRoot(root)
    const envelope = createApprovalEnvelope(
      {
        nonce: options.config.nonce,
        phiSessionId: scope.phiSessionId,
        projectId: scope.projectId,
        cwd: scope.cwd,
        generation: scope.generation,
        ompSessionId: scope.rootOmpSessionId,
        runId: run.runId
      },
      event.toolCallId,
      'task',
      event.input
    )
    const key = parentKey(run, event.toolCallId)
    const known = settlementCalls.get(key)
    if (known) {
      if (
        known.parent.run.signal !== run.signal ||
        known.parent.session !== session ||
        !sameRpcChildRoot(known.parent.root, scope) ||
        known.inputDigest !== envelope.inputDigest
      )
        throw new Error('Native task settlement binding differs')
      return
    }
    if (
      settledToolIds.has(event.toolCallId) ||
      pendingSettlements.has(event.toolCallId) ||
      settlementCalls.size >= 4096
    )
      throw new Error('Native task settlement is unavailable')
    let parent = settlementParents.get(run.signal)
    if (
      parent &&
      (parent.run.runId !== run.runId ||
        parent.run.controlSequence !== run.controlSequence ||
        parent.session !== session ||
        !sameRpcChildRoot(parent.root, scope))
    )
      throw new Error('Native task parent settlement differs')
    if (!parent) {
      const ref = api!.pi.AgentRegistry.global().get(scope.rootAgentId)!
      parent = { run, root: scope, ref, session, calls: new Set(), spawnAllowed: false }
      settlementParents.set(run.signal, parent)
      const captured = parent
      const closed = (): void => {
        for (const call of captured.calls) settleNoSpawn(call)
      }
      run.signal.addEventListener('abort', closed, { once: true })
      detach.add(() => run.signal.removeEventListener('abort', closed))
    }
    const call: SettlementCall = {
      parent,
      ctx,
      toolCallId: event.toolCallId,
      inputDigest: envelope.inputDigest,
      ended: false,
      sent: false
    }
    parent.calls.add(call)
    settlementCalls.set(key, call)
    pendingSettlements.set(event.toolCallId, call)
  }
  const install = (ctx: ExtensionContext): void => {
    const session = actual(ctx)
    const previousInstallation = installations.get(session)
    if (previousInstallation) {
      if (session.agent.beforeToolCall !== previousInstallation.wrapper)
        throw new Error('Native task admission hook was replaced')
      return
    }
    const previous = session.agent.beforeToolCall
    if (!previous) throw new Error('Native task SDK dispatch callback is unavailable')
    const wrapper: BeforeToolCall = async (call, signal) => {
      if (call.tool.name !== 'task') return previous.call(session.agent, call, signal)
      const refused = {
        block: true as const,
        reason: 'Phi native task admission refused this call'
      }
      try {
        signal?.throwIfAborted()
        if (actual(ctx) !== session || hasReservedRpcChildUri(call.toolCall.arguments))
          return refused
        const raw = validateRpcForegroundTaskInput(call.toolCall.arguments, options.config, {
          allowIntent: true
        })
        const effective = validateRpcForegroundTaskInput(call.args, options.config)
        if (JSON.stringify(raw) !== JSON.stringify(effective)) return refused
        resources(session)
        prepared.set(call.toolCall.id, { session, input: JSON.stringify(effective) })
        const result = await previous.call(session.agent, call, signal)
        if (result?.block) return result
        signal?.throwIfAborted()
        if (
          actual(ctx) !== session ||
          session.agent.beforeToolCall !== wrapper ||
          JSON.stringify(
            validateRpcForegroundTaskInput(result?.args ?? call.args, options.config)
          ) !== JSON.stringify(effective)
        )
          return refused
        const parent = options.parentRun?.()
        const root = options.root()
        if (parent && root) {
          const key = parentKey(parent, call.toolCall.id)
          if (parent.signal.aborted || accepted.has(key) || accepted.size >= 4096) return refused
          accepted.set(key, { session, agent: effective.agent, root, run: parent })
        }
        return result
      } catch (error) {
        if (
          error instanceof Error &&
          error.message ===
            'Project and ancestor agent resources are unsupported for native child tasks'
        )
          return {
            block: true,
            reason: 'Project and ancestor agent resources are unsupported for native child tasks'
          }
        return refused
      } finally {
        prepared.delete(call.toolCall.id)
      }
    }
    session.agent.beforeToolCall = wrapper
    installations.set(session, { session, previous, wrapper })
    const registry = api!.pi.AgentRegistry.global()
    // Native executor dual-publishes this scoped bus payload; identity still comes from real refs.
    detach.add(
      api!.events.on('task:subagent:lifecycle', (input: unknown) => {
        if (!input || typeof input !== 'object') return
        const event = input as Record<string, unknown>
        if (
          event.status !== 'started' ||
          event.agentSource !== 'user' ||
          typeof event.id !== 'string' ||
          typeof event.parentToolCallId !== 'string' ||
          typeof event.sessionFile !== 'string'
        )
          return
        const launch = launches.get(event.id)
        const parent = launch && accepted.get(parentKey(launch.run, event.parentToolCallId))
        const ref = registry.get(event.id)
        if (
          !parent ||
          launch?.session !== session ||
          parent.run.signal !== launch.run.signal ||
          parent.session !== session ||
          parent.agent !== event.agent ||
          !ref?.session ||
          ref.kind !== 'sub' ||
          ref.parentId !== parent.root.rootAgentId ||
          ref.sessionFile !== event.sessionFile ||
          ref.session.sessionManager.getHeader()?.parentSession !== parent.root.rootSessionFile
        )
          return
        children.set(ref, { session, root: parent.root, run: parent.run, file: event.sessionFile })
      })
    )
    detach.add(
      registry.onChange((event) => {
        if (
          event.type !== 'status_changed' ||
          event.ref.status !== 'aborted' ||
          event.ref.session !== null
        )
          return
        const child = children.get(event.ref)
        const current = options.parentRun?.()
        if (
          !child ||
          child.session !== session ||
          registry.get(event.ref.id) !== event.ref ||
          event.ref.kind !== 'sub' ||
          event.ref.parentId !== child.root.rootAgentId ||
          event.ref.sessionFile !== child.file ||
          registry.get(child.root.rootAgentId)?.session !== session ||
          session.sessionId !== child.root.rootOmpSessionId ||
          session.sessionFile !== child.root.rootSessionFile ||
          !current ||
          current.runId !== child.run.runId ||
          current.controlSequence !== child.run.controlSequence ||
          current.signal !== child.run.signal
        )
          return
        blocked = child.run
        // This synchronous tombstone precedes TaskTool continuation and the delayed RPC ACK.
        try {
          options.onChildAborted?.(child.run)
        } catch {
          /* The provider gate is already closed. */
        }
      })
    )
  }
  return {
    extension: (pi) => {
      api = pi
      const instruction =
        'Phi delegation policy: use native task only with an explicit agent from ' +
        JSON.stringify(options.config.profiles.map((profile) => profile.definition.nativeName)) +
        '. These agents are blocking foreground tasks with only their declared read/write/bash tools. ' +
        'The default task agent and other bundled agents are unavailable. Do not request background, models, tools, effort, isolation, schemas or nested agents in task arguments.'
      pi.on('before_agent_start', (_event, ctx) =>
        ctx.agent.kind === 'main'
          ? {
              systemPrompt: [
                ...ctx.getSystemPrompt().filter((part) => part !== instruction),
                instruction
              ]
            }
          : undefined
      )
      pi.on('session_start', (_event, ctx) => {
        if (ctx.agent.kind === 'main') install(ctx)
      })
      pi.on('session_switch', (_event, ctx) => {
        if (ctx.agent.kind === 'main') install(ctx)
      })
      pi.on('tool_execution_end', (event, ctx) => {
        const call = pendingSettlements.get(event.toolCallId)
        if (event.toolName !== 'task' || !call || !savedRootMatches(call, ctx)) return
        call.ended = true
        pendingSettlements.delete(event.toolCallId)
        settleNoSpawn(call)
      })
      pi.on('before_subagent_spawn', (event, ctx) => {
        if (ctx.agent.kind !== 'main') return undefined
        try {
          resources(actual(ctx))
        } catch {
          return { block: true, reason: 'Project agent resources cannot be verified' }
        }
        if (!options.parentRun) return undefined
        const run = options.parentRun()
        if (
          !run ||
          run.signal.aborted ||
          event.invocationKind !== 'task' ||
          !approvalIdentifier(event.spawnKey) ||
          launches.size >= 4096 ||
          !options.config.profiles.some((profile) => profile.definition.nativeName === event.agent)
        )
          return { block: true, reason: 'Phi native task launch scope is unavailable' }
        try {
          const session = actual(ctx)
          resources(session)
          const parent = settlementParents.get(run.signal)
          if (
            !parent ||
            parent.session !== session ||
            parent.run.runId !== run.runId ||
            parent.run.controlSequence !== run.controlSequence
          )
            return { block: true, reason: 'Phi native task launch has no captured parent' }
          // Permanent for this parent: any allowed sibling rules out a no-spawn receipt.
          parent.spawnAllowed = true
          launches.set(event.spawnKey, { session, run })
          return undefined
        } catch {
          return { block: true, reason: 'Phi native task launch scope is unavailable' }
        }
      })
    },
    assertInstalled: (ctx) => {
      const session = actual(ctx)
      resources(session)
      if (session.agent.beforeToolCall !== installations.get(session)?.wrapper)
        throw new Error('Native task admission is not installed')
    },
    preflight: (event, ctx) => {
      const session = actual(ctx)
      const entry = prepared.get(event.toolCallId)
      if (
        event.toolName !== 'task' ||
        session.agent.beforeToolCall !== installations.get(session)?.wrapper ||
        !entry ||
        entry.session !== session ||
        entry.input !== JSON.stringify(validateRpcForegroundTaskInput(event.input, options.config))
      )
        throw new Error('Native task has no exact prepared root admission')
      captureSettlement(event, ctx, session)
    },
    sealParent: (run, ctx) => {
      try {
        actualRoot(ctx)
        const current = options.parentRun?.()
        if (
          !current ||
          current.runId !== run.runId ||
          current.controlSequence !== run.controlSequence ||
          current.signal !== run.signal ||
          !Number.isSafeInteger(run.controlSequence) ||
          run.controlSequence < 1
        )
          return false
        blocked = Object.freeze({ ...current })
        return true
      } catch {
        return false
      }
    },
    isStreamActive: () => {
      if (disposed || options.signal.aborted) return false
      if (!blocked) return true
      const current = options.parentRun?.()
      return (
        !!current &&
        (current.runId !== blocked.runId ||
          current.controlSequence !== blocked.controlSequence ||
          current.signal !== blocked.signal)
      )
    },
    dispose: () => {
      // Retired roots keep a closed wrapper; async abort issuance does not prove quiescence.
      disposed = true
      installations.clear()
      prepared.clear()
      accepted.clear()
      launches.clear()
      children.clear()
      settlementParents.clear()
      settlementCalls.clear()
      pendingSettlements.clear()
      settledToolIds.clear()
      for (const off of detach) off()
      detach.clear()
    }
  }
}
