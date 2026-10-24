import { setTimeout as yieldForRegistration } from 'node:timers/promises'
import type { AgentSession, ExtensionContext, ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import { assertRpcChildTaskCapacity } from '../lib/rpc-task-capacity'
import { sameRpcChildRoot, type RpcChildRootScope } from '../lib/rpc-child-protocol'
import type { RpcChildRuntimeConfig } from '../lib/rpc-child-config'
import {
  makeRpcChildHostCancelReceipt,
  makeRpcChildHostStartReceipt,
  type RpcChildHostStartRequest
} from '../lib/rpc-child-host-start'

type Registry = ReturnType<Parameters<ExtensionFactory>[0]['pi']['AgentRegistry']['global']>
export interface RpcHostDispatchCall {
  readonly toolCallId: string
  dispatchSealed: boolean
  hostStart?: boolean
  readonly admitted: Map<string, string>
  readonly registeredJobs: Map<string, boolean>
}
interface HostRun {
  readonly runId: string
  readonly controlSequence: number
  readonly signal: AbortSignal
}
interface HostInput {
  readonly agent: string
  readonly task: string
  readonly solutionSpace: string
}
export interface RpcHostChildDispatchOptions<T extends RpcHostDispatchCall> {
  readonly config: Readonly<RpcChildRuntimeConfig>
  readonly signal: AbortSignal
  readonly currentParentRun?: () => HostRun | undefined
  readonly actual: (ctx: ExtensionContext) => AgentSession
  readonly resources: (session: AgentSession) => void
  readonly assertInstalled: (session: AgentSession) => void
  readonly assertDefinition: (session: AgentSession, input: HostInput) => Promise<void>
  readonly root: () => Readonly<RpcChildRootScope> | undefined
  readonly registry: () => Registry
  readonly reservations: Map<string, { count: number; call?: T }>
  readonly capture: (
    request: RpcChildHostStartRequest,
    ctx: ExtensionContext,
    session: AgentSession,
    run: HostRun,
    input: HostInput
  ) => T
  readonly cleanup: (request: RpcChildHostStartRequest, call: T) => void
}

/** One generation's host-dispatch ledger; no Main model-turn authority is borrowed. */
export class RpcHostChildDispatch<T extends RpcHostDispatchCall> {
  private readonly calls = new Map<
    string,
    { request: Readonly<RpcChildHostStartRequest>; call: T; cancelled: boolean }
  >()
  private readonly tombstones = new Set<string>()
  constructor(private readonly options: RpcHostChildDispatchOptions<T>) {}

  isCancelled(id: string): boolean {
    return this.calls.get(id)?.cancelled === true || this.tombstones.has(id)
  }

  async start(request: Readonly<RpcChildHostStartRequest>, ctx: ExtensionContext): Promise<void> {
    const { options } = this
    const session = options.actual(ctx)
    this.assertIdleStart(request, ctx, session)
    options.resources(session)
    options.assertInstalled(session)
    const profile = options.config.profiles.find(
      (entry) => entry.definition.nativeName === request.agent && !entry.definition.blocking
    )
    if (!profile) throw new Error('Phi host child agent is unavailable')
    const input = { agent: request.agent, task: request.task, solutionSpace: request.task }
    await options.assertDefinition(session, input)
    const root = options.root()
    if (!root || !sameRpcChildRoot(root, request.root) || this.tombstones.has(request.id))
      throw new Error('Phi host child root changed')
    this.assertCapacity(session, root)
    const run: HostRun = {
      runId: request.id,
      controlSequence: 1,
      signal: AbortSignal.any([options.signal, new AbortController().signal])
    }
    const call = options.capture(request, ctx, session, run, input)
    call.hostStart = true
    this.calls.set(request.id, { request, call, cancelled: false })
    options.reservations.set(request.id, { count: 1, call })
    let delivered = false
    try {
      await this.launchAndConfirm(request, { ctx, session, root, input, call })
      delivered = true
    } finally {
      if (!delivered)
        for (const nativeId of call.registeredJobs.keys())
          session.asyncJobManager?.cancel(nativeId, { ownerId: root.rootAgentId })
      options.cleanup(request, call)
      options.reservations.delete(request.id)
    }
  }

  private assertIdleStart(
    request: Readonly<RpcChildHostStartRequest>,
    ctx: ExtensionContext,
    session: AgentSession
  ): void {
    const { options } = this
    if (
      this.tombstones.has(request.id) ||
      this.calls.has(request.id) ||
      this.calls.size >= 4096 ||
      options.config.policy.allowBackground !== true ||
      !ctx.isIdle() ||
      options.currentParentRun?.() ||
      request.root.rootOmpSessionId !== session.sessionId ||
      request.root.rootSessionFile !== session.sessionFile
    )
      throw new Error('Phi host child start requires the exact idle root')
  }

  private assertCapacity(session: AgentSession, root: Readonly<RpcChildRootScope>): void {
    const { options } = this
    const ids = new Set(
      (session.asyncJobManager?.getRunningJobs({ ownerId: root.rootAgentId }) ?? [])
        .filter((job) => job.type === 'task')
        .map((job) => job.agentId ?? job.id)
    )
    for (const child of options.registry().list())
      if (child.kind === 'sub' && child.parentId === root.rootAgentId && child.status === 'running')
        ids.add(child.id)
    let reserved = 0
    for (const reservation of options.reservations.values()) {
      reserved += reservation.count
      for (const id of [
        ...(reservation.call?.admitted.keys() ?? []),
        ...(reservation.call?.registeredJobs.keys() ?? [])
      ])
        ids.delete(id)
    }
    assertRpcChildTaskCapacity(ids, reserved, 1)
  }

  private async launchAndConfirm(
    request: Readonly<RpcChildHostStartRequest>,
    launch: {
      ctx: ExtensionContext
      session: AgentSession
      root: Readonly<RpcChildRootScope>
      input: HostInput
      call: T
    }
  ): Promise<void> {
    const { options } = this
    const { ctx, session, root, input, call } = launch
    const task = session.getToolByName('task')
    if (!task) throw new Error('Native task tool is unavailable')
    const result = await task.execute(request.id, input, options.signal)
    if (result.isError || call.registeredJobs.size !== 1)
      throw new Error('Phi host child launch was not confirmed')
    if (this.tombstones.has(request.id)) throw new Error('Phi host child was cancelled')
    const nativeId = [...call.registeredJobs.keys()][0]!
    const registry = options.registry()
    const joined = AbortSignal.any([options.signal, AbortSignal.timeout(10000)])
    let ref = registry.get(nativeId)
    while (!ref?.sessionFile) {
      await yieldForRegistration(5, undefined, { signal: joined })
      ref = registry.get(nativeId)
    }
    if (
      !call.registeredJobs.get(nativeId) ||
      ref.kind !== 'sub' ||
      ref.parentId !== root.rootAgentId ||
      ref.displayName !== request.agent
    )
      throw new Error('Phi host child identity was not confirmed')
    ctx.ui.notify(
      JSON.stringify(
        makeRpcChildHostStartReceipt(request, options.config, {
          nativeId,
          parentToolCallId: request.id,
          childSessionFile: ref.sessionFile
        })
      ),
      'info'
    )
  }

  async cancel(request: Readonly<RpcChildHostStartRequest>, ctx: ExtensionContext): Promise<void> {
    const { options } = this
    const session = options.actual(ctx)
    const root = options.root()
    if (
      !root ||
      !sameRpcChildRoot(root, request.root) ||
      !ctx.isIdle() ||
      request.root.rootOmpSessionId !== session.sessionId ||
      request.root.rootSessionFile !== session.sessionFile
    )
      throw new Error('Phi host child cancellation lacks its idle root')
    const known = this.calls.get(request.id)
    if (known && JSON.stringify(known.request) !== JSON.stringify(request))
      throw new Error('Phi host child cancellation request differs')
    this.tombstones.add(request.id)
    if (known) known.cancelled = true
    const nativeIds = new Set(known?.call.registeredJobs.keys() ?? [])
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10000)])
    let state: 'quiescent' | 'unknown' = 'unknown'
    try {
      await this.waitForCancellation(session, root, known?.call, nativeIds, signal)
      state = 'quiescent'
    } catch {
      state = 'unknown'
    }
    ctx.ui.notify(
      JSON.stringify(makeRpcChildHostCancelReceipt(request, options.config, state, [...nativeIds])),
      'info'
    )
  }

  private async waitForCancellation(
    session: AgentSession,
    root: Readonly<RpcChildRootScope>,
    call: T | undefined,
    nativeIds: Set<string>,
    signal: AbortSignal
  ): Promise<void> {
    const registry = this.options.registry()
    for (;;) {
      let active = false
      for (const nativeId of call?.registeredJobs.keys() ?? []) nativeIds.add(nativeId)
      for (const nativeId of nativeIds)
        if (this.cancelAndCheckNative(session, root, registry, nativeId)) active = true
      if ((!call || call.dispatchSealed) && !active) return
      await yieldForRegistration(5, undefined, { signal })
    }
  }

  private cancelAndCheckNative(
    session: AgentSession,
    root: Readonly<RpcChildRootScope>,
    registry: Registry,
    nativeId: string
  ): boolean {
    const manager = session.asyncJobManager
    const job = manager?.getJob(nativeId)
    const ref = registry.get(nativeId)
    if (job?.ownerId !== undefined && job.ownerId !== root.rootAgentId)
      throw new Error('Phi host child cancellation owner changed')
    if (ref && (ref.kind !== 'sub' || ref.parentId !== root.rootAgentId))
      throw new Error('Phi host child registry owner changed')
    if (job?.status === 'running') manager?.cancel(nativeId, { ownerId: root.rootAgentId })
    return (job ? job.endTime === undefined : !ref) || ref?.status === 'running'
  }
}
