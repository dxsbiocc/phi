import { assertRpcChildTaskCapacity } from '../lib/rpc-task-capacity'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { approvalIdentifier, createApprovalEnvelope } from '../lib/rpc-approval-protocol'
import type { AgentSession, ExtensionContext, ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import {
  validateRpcForegroundTaskInput,
  childConfigDigest,
  type RpcForegroundTaskInput,
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
import { createRpcTaskLaunchTracker } from './rpc-task-launch-tracker'
import { acknowledgeOwnedRpcChildDelivery } from './rpc-child-control'
import { makeRpcTaskLaunchReceipt } from '../lib/rpc-task-launch-protocol'
import { makeRpcTaskSettlement } from '../lib/rpc-task-settlement-protocol'
import type { RpcChildHostStartRequest } from '../lib/rpc-child-host-start'
import { RpcHostChildDispatch } from './rpc-host-child-dispatch'
import {
  abortedChildMatches,
  backgroundJobMatchesChild,
  launchMatchesChild,
  lifecycleMatchesTask,
  nativeRefMatchesChild,
  parentMatchesLaunch,
  rootSessionMatchesChild,
  validStreamCandidate,
  type AcceptedTask,
  type ChildLaunch,
  type TrackedChild
} from './rpc-child-stream-authority'

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
  declaredTaskCount: number
  admitted: Map<string, string>
  dispatchSealed: boolean
  hostStart?: boolean
  registeredJobs: Map<string, boolean>
  registeredChildren: Map<string, { ref: AgentReference; agent: string }>
}
export interface RpcTaskAdmissionOptions {
  readonly config: Readonly<RpcChildRuntimeConfig>
  readonly signal: AbortSignal
  readonly root: () => Readonly<RpcChildRootScope> | undefined
  /** Rechecks immutable compiler publication and static private config before every task. */
  readonly assertPublication: () => void
  readonly parentRun?: () => Readonly<RpcTaskParentRun> | undefined
  readonly onChildAborted?: (run: Readonly<RpcTaskParentRun>) => void
  /** Test-only synthetic sessions may disable filesystem resolution; production defaults on. */
  readonly verifyResolvedDefinitions?: boolean
  /** OMP-owned resolver/parser adapter supplied by the production extension entry. */
  readonly verifyResolvedDefinition?: (
    session: AgentSession,
    input: {
      readonly name: string
      readonly expectedPath: string
      readonly expectedHash: string
    }
  ) => Promise<string | undefined>
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
class RpcTaskDefinitionConflictError extends Error {}

function assertExistingSettlement(
  known: SettlementCall,
  run: Readonly<RpcTaskParentRun>,
  session: AgentSession,
  scope: RpcChildRootScope,
  inputDigest: string
): void {
  if (
    known.parent.run.signal !== run.signal ||
    known.parent.session !== session ||
    !sameRpcChildRoot(known.parent.root, scope) ||
    known.inputDigest !== inputDigest
  )
    throw new Error('Native task settlement binding differs')
}

function assertSettlementParent(
  parent: SettlementParent,
  run: Readonly<RpcTaskParentRun>,
  session: AgentSession,
  scope: RpcChildRootScope
): void {
  if (
    parent.run.runId !== run.runId ||
    parent.run.controlSequence !== run.controlSequence ||
    parent.session !== session ||
    !sameRpcChildRoot(parent.root, scope)
  )
    throw new Error('Native task parent settlement differs')
}

function requireSettlementBinding(
  run: Readonly<RpcTaskParentRun> | undefined,
  root: Readonly<RpcChildRootScope> | undefined
): { run: Readonly<RpcTaskParentRun>; scope: RpcChildRootScope } {
  if (
    !run ||
    run.signal.aborted ||
    !root ||
    !Number.isSafeInteger(run.controlSequence) ||
    run.controlSequence < 1
  )
    throw new Error('Native task parent is unavailable')
  return { run, scope: validateRpcChildRoot(root) }
}

function requestedAgents(
  input:
    | Readonly<RpcForegroundTaskInput>
    | Readonly<{ tasks: readonly Readonly<RpcForegroundTaskInput>[] }>
): readonly string[] {
  return 'tasks' in input ? input.tasks.map((task) => task.agent) : [input.agent]
}

async function assertRpcTaskDefinitionsResolved(
  session: AgentSession,
  input:
    | Readonly<RpcForegroundTaskInput>
    | Readonly<{ tasks: readonly Readonly<RpcForegroundTaskInput>[] }>,
  config: Readonly<RpcChildRuntimeConfig>,
  verify: RpcTaskAdmissionOptions['verifyResolvedDefinition']
): Promise<void> {
  const agentDir = process.env.PI_CODING_AGENT_DIR
  if (!agentDir) throw new Error('Native child publication location is unavailable')
  if (!verify) throw new Error('OMP child definition verifier is unavailable')
  for (const name of new Set(requestedAgents(input))) {
    const expectedPath = join(agentDir, 'agents', `${name}.md`)
    const expectedHash = config.files.find((file) => file.path === `agents/${name}.md`)?.sha256
    if (!expectedHash) {
      throw new RpcTaskDefinitionConflictError(
        `Phi child ${name} is shadowed by an unresolved agent definition`
      )
    }
    const reason = await verify(session, { name, expectedPath, expectedHash })
    if (reason) throw new RpcTaskDefinitionConflictError(reason)
  }
}
/** Keeps the actual native TaskTool/SDK handler and validates both public raw/effective inputs. */
export function createRpcTaskAdmissionExtension(options: RpcTaskAdmissionOptions): {
  extension: ExtensionFactory
  preflight(event: RpcTaskCall, ctx: ExtensionContext): void
  assertInstalled(ctx: ExtensionContext): void
  sealParent(run: Readonly<RpcTaskParentRun>, ctx: ExtensionContext): boolean
  isStreamActive(): boolean
  isChildStreamActive(nativeAgentId: string): boolean
  startHostChild(request: Readonly<RpcChildHostStartRequest>, ctx: ExtensionContext): Promise<void>
  cancelHostChild(request: Readonly<RpcChildHostStartRequest>, ctx: ExtensionContext): Promise<void>
  dispose(): void
} {
  const trackLaunches =
    options.config.policy.allowParallel === true || options.config.policy.allowBackground === true
  const trackDispatch = options.parentRun !== undefined
  const installations = new Map<AgentSession, Installation>()
  const reservations = new Map<string, { count: number; call?: SettlementCall }>()
  const prepared = new Map<string, { session: AgentSession; input: string }>()
  const accepted = new Map<string, AcceptedTask>()
  const launches = new Map<string, ChildLaunch>()
  const parentKey = (run: Readonly<RpcTaskParentRun>, id: string): string =>
    JSON.stringify([run.runId, run.controlSequence, id])
  const children = new Map<AgentReference, TrackedChild>()
  const detach = new Set<() => void>()
  const settlementParents = new Map<AbortSignal, SettlementParent>()
  const settlementCalls = new Map<string, SettlementCall>()
  const pendingSettlements = new Map<string, SettlementCall>()
  const settledToolIds = new Set<string>()
  // Normal Main completion also aborts its execution signal. Only a captured negative
  // decision retires already admitted children from that parent; never revive it later.
  const blockedParents = new WeakMap<AbortSignal, Set<string>>()
  const parentIdentity = (run: Readonly<RpcTaskParentRun>): string =>
    JSON.stringify([run.runId, run.controlSequence])
  const parentBlocked = (run: Readonly<RpcTaskParentRun>): boolean =>
    blockedParents.get(run.signal)?.has(parentIdentity(run)) === true
  const blockParent = (run: Readonly<RpcTaskParentRun>): void => {
    const entries = blockedParents.get(run.signal) ?? new Set<string>()
    entries.add(parentIdentity(run))
    blockedParents.set(run.signal, entries)
    blocked = Object.freeze({ ...run })
  }
  let blocked: Readonly<RpcTaskParentRun> | undefined
  const digest = childConfigDigest(options.config)
  let api: Parameters<ExtensionFactory>[0] | undefined
  let disposed = false
  const resources = (session: AgentSession): void => {
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
        !sameRpcChildModel(
          projectRpcChildModel(model),
          options.config.parentModel ?? expected.model
        ) ||
        !sameRpcChildRoute(
          projectRpcChildRoute(model),
          options.config.parentRoute ?? expected.route
        )
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
    session: AgentSession,
    hostRun?: Readonly<RpcTaskParentRun>
  ): void => {
    if (!options.parentRun && !hostRun) return
    const { run, scope } = requireSettlementBinding(
      hostRun ?? options.parentRun?.(),
      options.root()
    )
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
      assertExistingSettlement(known, run, session, scope, envelope.inputDigest)
      return
    }
    if (
      settledToolIds.has(event.toolCallId) ||
      pendingSettlements.has(event.toolCallId) ||
      settlementCalls.size >= 4096
    )
      throw new Error('Native task settlement is unavailable')
    let parent = settlementParents.get(run.signal)
    if (parent) assertSettlementParent(parent, run, session, scope)
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
      sent: false,
      declaredTaskCount:
        'tasks' in validateRpcForegroundTaskInput(event.input, options.config)
          ? (
              validateRpcForegroundTaskInput(event.input, options.config) as {
                tasks: readonly unknown[]
              }
            ).tasks.length
          : 1,
      admitted: new Map(),
      registeredJobs: new Map(),
      registeredChildren: new Map(),
      dispatchSealed: false
    }
    parent.calls.add(call)
    settlementCalls.set(key, call)
    pendingSettlements.set(event.toolCallId, call)
  }
  const publishLaunch = (call: SettlementCall, sealed: boolean): void => {
    if (call.hostStart) return
    if (!savedRootMatches(call, call.ctx)) throw new Error('Native task receipt ownership changed')
    const receipt = makeRpcTaskLaunchReceipt(options.config, call.parent.root, {
      parentRunId: call.parent.run.runId,
      controlSequence: call.parent.run.controlSequence,
      toolCallId: call.toolCallId,
      inputDigest: call.inputDigest,
      declaredTaskCount: call.declaredTaskCount,
      expectedTaskCount: sealed
        ? new Set([
            ...call.admitted.keys(),
            ...[...call.registeredJobs].filter(([, committed]) => committed).map(([id]) => id)
          ]).size
        : call.declaredTaskCount,
      dispatchSealed: sealed
    })
    call.ctx.ui.notify(JSON.stringify(receipt), 'info')
  }
  const tracker = createRpcTaskLaunchTracker<SettlementCall>({
    capture: (session, id, input) => {
      const call = pendingSettlements.get(id)
      const acceptedCall = call && accepted.get(parentKey(call.parent.run, id))
      if (
        !call ||
        !acceptedCall ||
        call.parent.session !== session ||
        call.dispatchSealed ||
        !savedRootMatches(call, call.ctx) ||
        JSON.stringify(validateRpcForegroundTaskInput(input, options.config)) !==
          preparedInputs.get(id)
      )
        throw new Error('Native task execute has no exact accepted admission')
      return call
    },
    active: (call) =>
      !call.parent.run.signal.aborted &&
      (!call.hostStart || !hostDispatch.isCancelled(call.toolCallId)) &&
      savedRootMatches(call, call.ctx),
    registering: (call, id) => {
      if (
        call.dispatchSealed ||
        call.registeredJobs.has(id) ||
        call.registeredJobs.size >= call.declaredTaskCount
      )
        throw new Error('Native task job registration exceeds its bounded dispatch')
      call.registeredJobs.set(id, false)
    },
    registered: (call, id) => {
      call.registeredJobs.set(id, true)
    },
    registrationFailed: (call, id) => {
      call.registeredJobs.delete(id)
    },
    seal: (call) => {
      reservations.delete(call.toolCallId)
      if (!call.dispatchSealed) {
        call.dispatchSealed = true
        if (trackLaunches && !call.hostStart) publishLaunch(call, true)
      }
    }
  })
  const preparedInputs = new Map<string, string>()
  const hostDispatch = new RpcHostChildDispatch<SettlementCall>({
    config: options.config,
    signal: options.signal,
    currentParentRun: options.parentRun,
    actual,
    resources,
    assertInstalled: (session) => tracker.assertInstalled(session),
    assertDefinition: (session, input) =>
      assertRpcTaskDefinitionsResolved(
        session,
        input,
        options.config,
        options.verifyResolvedDefinition
      ),
    root: options.root,
    registry: () => api!.pi.AgentRegistry.global(),
    reservations,
    capture: (request, ctx, session, run, input) => {
      captureSettlement({ toolCallId: request.id, toolName: 'task', input }, ctx, session, run)
      const key = parentKey(run, request.id)
      const call = settlementCalls.get(key)
      if (!call) throw new Error('Phi host child dispatch was not captured')
      accepted.set(key, { session, agents: [request.agent], root: request.root, run })
      preparedInputs.set(request.id, JSON.stringify(input))
      return call
    },
    cleanup: (request) => {
      preparedInputs.delete(request.id)
      pendingSettlements.delete(request.id)
    }
  })
  const reserveCapacity = (
    session: AgentSession,
    effective: ReturnType<typeof validateRpcForegroundTaskInput>,
    toolCallId: string
  ): void => {
    if (!trackLaunches) return
    const requested = 'tasks' in effective ? effective.tasks.length : 1
    const root = options.root()!
    const ids = new Set(
      (session.asyncJobManager?.getRunningJobs({ ownerId: root.rootAgentId }) ?? [])
        .filter((job) => job.type === 'task')
        .map((job) => job.agentId ?? job.id)
    )
    for (const child of api!.pi.AgentRegistry.global().list())
      if (child.kind === 'sub' && child.parentId === root.rootAgentId && child.status === 'running')
        ids.add(child.id)
    let reserved = 0
    for (const reservation of reservations.values()) {
      reserved += reservation.count
      for (const id of [
        ...(reservation.call?.admitted.keys() ?? []),
        ...(reservation.call?.registeredJobs.keys() ?? [])
      ])
        ids.delete(id)
    }
    assertRpcChildTaskCapacity(ids, reserved, requested)
    reservations.set(toolCallId, { count: requested })
  }
  const registeredChildMatches = (
    call: SettlementCall | undefined,
    ref: AgentReference,
    session: AgentSession,
    registry: Registry
  ): call is SettlementCall => {
    if (!call) return false
    const profile = options.config.profiles.find(
      (item) => item.definition.nativeName === ref.displayName
    )
    return (
      call.parent.session === session &&
      !call.ended &&
      !call.dispatchSealed &&
      !parentBlocked(call.parent.run) &&
      !!profile?.definition.blocking &&
      ref.kind === 'sub' &&
      ref.parentId === call.parent.root.rootAgentId &&
      registry.get(ref.id) === ref &&
      !!approvalIdentifier(ref.id)
    )
  }
  const registrationSlotAvailable = (call: SettlementCall, ref: AgentReference): boolean => {
    const agent = ref.displayName
    return (
      !launches.has(ref.id) &&
      launches.size < 4096 &&
      [...call.registeredChildren.values()].filter((child) => child.agent === agent).length <
        [...call.admitted.values()].filter((name) => name === agent).length
    )
  }
  const install = (ctx: ExtensionContext): void => {
    const session = actual(ctx)
    const previousInstallation = installations.get(session)
    if (previousInstallation) {
      if (session.agent.beforeToolCall !== previousInstallation.wrapper)
        throw new Error('Native task admission hook was replaced')
      if (trackDispatch) tracker.assertInstalled(session)
      return
    }
    if (trackDispatch) tracker.install(session)
    const previous = session.agent.beforeToolCall
    if (!previous) throw new Error('Native task SDK dispatch callback is unavailable')
    const wrapper: BeforeToolCall = async (call, signal) => {
      if (call.tool.name !== 'task') return previous.call(session.agent, call, signal)
      const refused = {
        block: true as const,
        reason: 'Phi native task admission refused this call'
      }
      let committed = false
      let acceptedKey: string | undefined
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
        if (options.verifyResolvedDefinitions !== false)
          await assertRpcTaskDefinitionsResolved(
            session,
            effective,
            options.config,
            options.verifyResolvedDefinition
          )
        reserveCapacity(session, effective, call.toolCall.id)
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
          acceptedKey = key
          accepted.set(key, {
            session,
            agents:
              'tasks' in effective ? effective.tasks.map((task) => task.agent) : [effective.agent],
            root,
            run: parent
          })
          preparedInputs.set(call.toolCall.id, JSON.stringify(effective))
          const captured = pendingSettlements.get(call.toolCall.id)
          if (!captured) return refused
          if (trackLaunches) {
            reservations.get(call.toolCall.id)!.call = captured
            publishLaunch(captured, false)
          }
        }
        committed = true
        return result
      } catch (error) {
        if (error instanceof RpcTaskDefinitionConflictError)
          return { block: true, reason: error.message }
        return refused
      } finally {
        prepared.delete(call.toolCall.id)
        if (!committed) {
          reservations.delete(call.toolCall.id)
          if (acceptedKey) accepted.delete(acceptedKey)
        }
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
          !launch ||
          !ref ||
          !lifecycleMatchesTask(event, launch, parent, ref, session)
        )
          return
        children.set(ref, { session, root: parent.root, run: parent.run, file: event.sessionFile })
      })
    )
    detach.add(
      registry.onChange((event) => {
        if (event.type === 'registered') {
          // Synchronous TaskTool spawns reserve their final ID after before_spawn.
          // Only its original execute context may finish that captured dispatch binding.
          const call = tracker.current()
          const ref = event.ref
          const agent = ref.displayName
          if (!registeredChildMatches(call, ref, session, registry)) return
          const bound = call.registeredChildren.get(ref.id)
          if (bound) return
          if (!registrationSlotAvailable(call, ref)) return
          call.registeredChildren.set(ref.id, { ref, agent })
          launches.set(ref.id, {
            session,
            run: call.parent.run,
            background: false,
            ref
          })
          return
        }
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
          !current ||
          !abortedChildMatches(child, event.ref, current, session, registry)
        )
          return
        blockParent(child.run)
        // This synchronous tombstone precedes TaskTool continuation and the delayed RPC ACK.
        try {
          options.onChildAborted?.(child.run)
        } catch {
          /* The provider gate is already closed. */
        }
      })
    )
  }
  const launchScopeAvailable = (
    run: Readonly<RpcTaskParentRun> | undefined,
    invocationKind: string,
    spawnKey: string | undefined,
    agent: string
  ): run is Readonly<RpcTaskParentRun> =>
    !!run &&
    !run.signal.aborted &&
    invocationKind === 'task' &&
    !!approvalIdentifier(spawnKey) &&
    launches.size < 4096 &&
    options.config.profiles.some((profile) => profile.definition.nativeName === agent)
  const exactDispatchOwner = (
    call: SettlementCall | undefined,
    parent: SettlementParent,
    acceptedCall: AcceptedTask | undefined,
    spawnKey: string,
    agent: string
  ): boolean =>
    !!call &&
    call.parent === parent &&
    !!acceptedCall &&
    (!call.dispatchSealed || call.registeredJobs.has(spawnKey)) &&
    !call.admitted.has(spawnKey) &&
    call.admitted.size < call.declaredTaskCount &&
    [...call.admitted.values()].filter((name) => name === agent).length <
      acceptedCall.agents.filter((name) => name === agent).length
  const capturedParentMatches = (
    parent: SettlementParent | undefined,
    session: AgentSession,
    run: Readonly<RpcTaskParentRun>
  ): parent is SettlementParent =>
    !!parent &&
    parent.session === session &&
    parent.run.runId === run.runId &&
    parent.run.controlSequence === run.controlSequence
  const spawnOwnerStillCurrent = (
    call: SettlementCall | undefined,
    ctx: ExtensionContext,
    session: AgentSession,
    run: Readonly<RpcTaskParentRun>,
    spawnKey: string
  ): boolean =>
    tracker.current() === call &&
    actual(ctx) === session &&
    (!call?.dispatchSealed || call.registeredJobs.get(spawnKey) === true) &&
    !run.signal.aborted
  const registerSpawnHandler = (pi: Parameters<ExtensionFactory>[0]): void => {
    pi.on('before_subagent_spawn', async (event, ctx) => {
      if (ctx.agent.kind !== 'main') return undefined
      try {
        resources(actual(ctx))
      } catch {
        return { block: true, reason: 'Project agent resources cannot be verified' }
      }
      if (!options.parentRun) return undefined
      const capturedCall = tracker.current()
      const run = capturedCall?.parent.run
      if (!launchScopeAvailable(run, event.invocationKind, event.spawnKey, event.agent))
        return { block: true, reason: 'Phi native task launch scope is unavailable' }
      if (!event.spawnKey)
        return { block: true, reason: 'Phi native task launch scope is unavailable' }
      try {
        const session = actual(ctx)
        resources(session)
        tracker.assertInstalled(session)
        const parent = settlementParents.get(run.signal)
        if (!capturedParentMatches(parent, session, run))
          return { block: true, reason: 'Phi native task launch has no captured parent' }
        const call = capturedCall
        const acceptedCall = call && accepted.get(parentKey(run, call.toolCallId))
        if (!exactDispatchOwner(call, parent, acceptedCall, event.spawnKey, event.agent))
          return { block: true, reason: 'Phi native task launch has no exact dispatch owner' }
        const profile = options.config.profiles.find(
          (item) => item.definition.nativeName === event.agent
        )!
        if (!profile.definition.blocking)
          await acknowledgeOwnedRpcChildDelivery(
            session,
            ctx,
            parent.root,
            event.spawnKey,
            AbortSignal.any([options.signal, run.signal])
          )
        if (!spawnOwnerStillCurrent(call, ctx, session, run, event.spawnKey))
          return { block: true, reason: 'Phi native task launch owner changed' }
        call?.admitted.set(event.spawnKey, event.agent)
        // Permanent for this parent: any allowed sibling rules out a no-spawn receipt.
        parent.spawnAllowed = true
        if (!profile.definition.blocking)
          launches.set(event.spawnKey, { session, run, background: true })
        return undefined
      } catch {
        return { block: true, reason: 'Phi native task launch scope is unavailable' }
      }
    })
  }
  return {
    startHostChild: (request, ctx) => hostDispatch.start(request, ctx),
    cancelHostChild: (request, ctx) => hostDispatch.cancel(request, ctx),
    extension: (pi) => {
      api = pi
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
      registerSpawnHandler(pi)
    },
    assertInstalled: (ctx) => {
      const session = actual(ctx)
      resources(session)
      // Recovery may initially bind the saved model before the controlled target is confirmed.
      // The private idle attestation can install only a missing, fully validated session hook.
      if (!installations.has(session)) install(ctx)
      if (session.agent.beforeToolCall !== installations.get(session)?.wrapper)
        throw new Error('Native task admission is not installed')
      if (trackDispatch) tracker.assertInstalled(session)
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
        blockParent(current)
        return true
      } catch {
        return false
      }
    },
    isStreamActive: () => {
      if (disposed || options.signal.aborted) return false
      const current = options.parentRun?.()
      if (current && parentBlocked(current)) return false
      if (!blocked) return true
      return (
        !!current &&
        (current.runId !== blocked.runId ||
          current.controlSequence !== blocked.controlSequence ||
          current.signal !== blocked.signal)
      )
    },
    isChildStreamActive: (nativeAgentId) => {
      try {
        if (!validStreamCandidate(disposed, options.signal, nativeAgentId)) return false
        const launch = launches.get(nativeAgentId)
        const registry = api?.pi.AgentRegistry.global()
        const ref = registry?.get(nativeAgentId)
        const child = ref && children.get(ref)
        if (!launch || !ref || !launchMatchesChild(launch, ref, child)) return false
        if (parentBlocked(launch.run)) return false
        const parent = settlementParents.get(launch.run.signal)
        if (!parent || !parentMatchesLaunch(parent, launch, child)) return false
        const root = parent.root
        if (!backgroundJobMatchesChild(launch, nativeAgentId, root)) return false
        // Intentionally ignore launch.run.signal.aborted: ordinary Main agent_end
        // retires that execution signal while its accepted background children remain owned.
        return (
          !!registry &&
          rootSessionMatchesChild(parent, registry) &&
          nativeRefMatchesChild(ref, nativeAgentId, root, child)
        )
      } catch {
        return false
      }
    },
    dispose: () => {
      // Retired roots keep a closed wrapper; async abort issuance does not prove quiescence.
      disposed = true
      installations.clear()
      prepared.clear()
      preparedInputs.clear()
      reservations.clear()
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
