import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { RpcChildSteerPermits } from './rpc-child-steer-permit'
import type { RpcChildControlScopes } from './rpc-child-control'
import {
  childProfileResourceDigest,
  childResourceHash,
  rpcChildEffectivePrompt,
  type RpcChildResourceCatalog,
  type RpcChildEnvironmentResource
} from '../lib/rpc-child-resources'
import { readRpcChildSkill } from '../lib/rpc-child-config'
import {
  registerRpcChildHostTools,
  rpcChildWrapperSourceMatches,
  type RpcChildHostExecution
} from './rpc-child-host-tools'
import { assertRpcChildEnvironment, rpcChildEnvironmentCommand } from './rpc-child-environment'
import type {
  AgentSession,
  ExtensionContext,
  ExtensionFactory,
  ToolInfo
} from '@oh-my-pi/pi-coding-agent'
import { InternalUrlRouter } from '@oh-my-pi/pi-coding-agent/internal-urls'
import {
  createRpcChildCall,
  encodeRpcChildRequest,
  hasReservedRpcChildUri,
  MAX_RPC_CHILD_CALLS,
  parseRpcChildReply,
  projectRpcChildModel,
  projectRpcChildRoute,
  sameRpcChildModel,
  sameRpcChildRoute,
  rpcChildPromptDigest,
  rpcChildUri,
  sameRpcChildRoot,
  snapshotRpcChildProfile,
  validateRpcChildActual,
  validateRpcChildRoot,
  validateRpcChildScope,
  type RpcChildActualProfile,
  type RpcChildCall,
  type RpcChildRequest,
  type RpcChildReply,
  type RpcChildRootScope,
  type RpcChildScope,
  type RpcChildTrustedProfile
} from '../lib/rpc-child-protocol'
import { approvalIdentifier } from '../lib/rpc-approval-protocol'
import { executionCapability } from '../lib/rpc-execution-protocol'
import { projectToolBoundaryDecision } from '../lib/project-boundary'
import { remoteUrlGuardDecision } from '../lib/remote-url'
import {
  canonicalRpcChildNativeInput,
  registerRpcChildNativeTools,
  type RpcChildNativeExecution
} from './rpc-child-native-tools'

export interface RpcChildReadiness {
  readonly identity: RpcChildRootScope
  readonly capability: string
  readonly profiles: readonly RpcChildTrustedProfile[]
  readonly signal: AbortSignal
}
export interface RpcSubagentsOptions {
  readonly resources?: RpcChildResourceCatalog
  readonly agentDir?: string
  readonly hostResult?: {
    readonly generationDirectory: string
    readonly directory: string
    readonly capability: string
    readonly leaseId: string
  }
  readonly steerPermits?: RpcChildSteerPermits
  readonly controlScopes?: RpcChildControlScopes
  /** Trusted generation state only, never a value supplied by a model or child URI. */
  readiness(): RpcChildReadiness | undefined
}
interface ChildState extends RpcChildNativeExecution, RpcChildHostExecution {
  readonly streamGate: AgentSession['agent']['streamFn']
  readonly nativeStream: AgentSession['agent']['streamFn']
  readonly effectivePrompt: readonly string[]
  readonly environment?: RpcChildEnvironmentResource
  readonly profile: RpcChildTrustedProfile
  readonly session: AgentSession
  readonly ready: RpcChildReadiness
  readonly controller: AbortController
  readonly api: Parameters<ExtensionFactory>[0]
  wrappers: ReadonlyMap<string, string>
  sequence: number
  registered: boolean
  permitted: boolean
  activated: boolean
  providerBegun: boolean
  initialPrompt?: string
  actualTools: ReadonlyMap<string, AgentSession['agent']['state']['tools'][number]>
  calls: Map<string, RpcChildCall>
  seen: Set<string>
  revokeControlScope?: () => void
}
const refused = { block: true as const, reason: 'Phi child execution authority is unavailable' }

/** Native foreground authority module. Without root's explicit R5 dispatch wiring, child tools remain denied. */
export function createRpcSubagentsExtension(options: RpcSubagentsOptions): {
  extension: ExtensionFactory
  preflight(
    toolCallId: string,
    toolName: string,
    input: unknown,
    ctx: ExtensionContext
  ): { block: true; reason: string } | { input: Record<string, unknown> }
  modelScope(
    ctx: ExtensionContext,
    nativeStream?: AgentSession['agent']['streamFn']
  ): Readonly<RpcChildScope> | undefined
  dispose(): void
} {
  const states = new Map<ExtensionContext['sessionManager'], ChildState>()
  let disposed = false
  let api: Parameters<ExtensionFactory>[0] | undefined
  const actualSession = (ctx: ExtensionContext): AgentSession => {
    const ref = api?.pi.AgentRegistry.global().get(ctx.agent.id)
    if (
      !ref?.session ||
      ref.session.sessionManager !== ctx.sessionManager ||
      ref.kind !== ctx.agent.kind
    )
      throw new Error('RPC child registry identity mismatch')
    return ref.session
  }
  const readiness = (): RpcChildReadiness => {
    const ready = options.readiness()
    if (disposed || !ready || ready.signal.aborted || !executionCapability(ready.capability))
      throw new Error('RPC child root is not ready')
    validateRpcChildRoot(ready.identity)
    if (JSON.stringify(ready.identity).includes(ready.capability))
      throw new Error('RPC child key overlaps public identity')
    const root = api?.pi.AgentRegistry.global().get(ready.identity.rootAgentId)
    if (
      !root?.session ||
      root.kind !== 'main' ||
      root.session.sessionId !== ready.identity.rootOmpSessionId ||
      root.session.sessionFile !== ready.identity.rootSessionFile ||
      realpathSync(root.session.sessionManager.getCwd()) !== ready.identity.cwd
    )
      throw new Error('RPC child root registry binding mismatch')
    return ready
  }
  const active = (child: ChildState, ctx: ExtensionContext): boolean => {
    try {
      const current = readiness()
      const profile = current.profiles.find(
        (item) => item.definition.nativeName === child.profile.definition.nativeName
      )
      if (
        !profile ||
        JSON.stringify(snapshotRpcChildProfile(profile)) !== JSON.stringify(child.profile)
      )
        return false
      if (
        child.profile.definition.resourcesDigest &&
        (!options.resources ||
          childProfileResourceDigest(child.profile.definition, options.resources) !==
            child.profile.definition.resourcesDigest)
      )
        return false
      if (child.environment) assertRpcChildEnvironment(child.environment)
      for (const model of [child.session.model, child.session.agent.state.model]) {
        if (
          !sameRpcChildModel(projectRpcChildModel(model), child.profile.model) ||
          !sameRpcChildRoute(projectRpcChildRoute(model), child.profile.route)
        )
          return false
      }
      const level = child.profile.definition.thinkingLevel
      const agent = child.session.agent.state
      if (
        child.session.thinkingLevel !== level ||
        (level === 'off'
          ? agent.thinkingLevel !== undefined || agent.disableReasoning !== true
          : String(agent.thinkingLevel) !== level || agent.disableReasoning === true) ||
        rpcChildPromptDigest(agent.systemPrompt) !== rpcChildPromptDigest(child.effectivePrompt)
      )
        return false
      if (
        JSON.stringify(child.session.getEnabledToolNames().sort()) !==
          JSON.stringify(child.profile.definition.tools.map((tool) => tool.name).sort()) ||
        agent.tools.length !== child.actualTools.size ||
        agent.tools.some((tool) => child.actualTools.get(tool.name) !== tool)
      )
        return false
      const infos = child.api.getAllTools()
      if (
        child.profile.definition.tools.some((tool) => {
          const info = infos.find((item) => item.name === tool.name)
          return (
            !info ||
            !rpcChildWrapperSourceMatches(tool, info.sourceInfo.source) ||
            info.description !== child.wrappers.get(tool.name) ||
            (tool.site === 'host' &&
              childResourceHash(info.parameters) !==
                options.resources?.hostTools.find((item) => item.name === tool.name)?.schemaSha256)
          )
        })
      )
        return false
      return (
        child.session.agent.streamFn === child.streamGate &&
        states.get(ctx.sessionManager) === child &&
        child.permitted &&
        !child.controller.signal.aborted &&
        child.ready.capability === current.capability &&
        child.ready.signal === current.signal &&
        sameRpcChildRoot(child.scope, current.identity) &&
        ctx.agent.kind === 'sub' &&
        ctx.agent.id === child.scope.nativeAgentId &&
        ctx.agent.parentId === child.scope.rootAgentId &&
        ctx.sessionManager.getSessionId() === child.scope.childOmpSessionId &&
        ctx.sessionManager.getSessionFile() === child.scope.childSessionFile &&
        actualSession(ctx) === child.session &&
        realpathSync(ctx.cwd) === child.scope.cwd
      )
    } catch {
      return false
    }
  }
  const revoke = (child: ChildState): void => {
    child.revokeControlScope?.()
    options.steerPermits?.revoke(child.session)
    child.permitted = false
    child.controller.abort()
    child.calls.clear()
    void child.session.abort().catch(() => undefined)
  }
  const exchange = async (
    child: ChildState,
    operation: 'register' | 'activate' | 'approve' | 'execute' | 'result_consumed',
    extra: { actual?: RpcChildActualProfile; call?: RpcChildCall; invocationId?: string },
    signal: AbortSignal
  ): Promise<RpcChildReply> => {
    if (operation === 'register' || operation === 'activate')
      signal = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    if (signal.aborted || child.controller.signal.aborted)
      throw new Error('RPC child channel interrupted')
    const request = {
      schema: 1,
      id: randomUUID(),
      operation,
      capability: child.ready.capability,
      sequence: ++child.sequence,
      scope: child.scope,
      ...extra
    } as RpcChildRequest
    const router = InternalUrlRouter.instance()
    let complete = false
    try {
      await router.write(rpcChildUri('request', request.id), encodeRpcChildRequest(request), {
        cwd: child.scope.cwd,
        signal
      })
      const result = await router.resolve(rpcChildUri('reply', request.id), {
        cwd: child.scope.cwd,
        sessionId: child.scope.childOmpSessionId,
        sessionFile: child.scope.childSessionFile,
        signal
      })
      const reply = parseRpcChildReply(
        result.content,
        request as Exclude<RpcChildRequest, { operation: 'cancel' }>
      )
      signal.throwIfAborted()
      complete = true
      return reply
    } catch {
      throw new Error('Phi child authority exchange was refused')
    } finally {
      if (!complete && !child.ready.signal.aborted) {
        const cancel: RpcChildRequest = {
          schema: 1,
          id: randomUUID(),
          operation: 'cancel',
          capability: child.ready.capability,
          sequence: ++child.sequence,
          scope: child.scope,
          targetId: request.id
        }
        // Cancellation has no human wait; connection teardown also revokes the Node registry.
        void router
          .write(rpcChildUri('cancel', cancel.id), encodeRpcChildRequest(cancel), {
            cwd: child.scope.cwd,
            signal: child.ready.signal
          })
          .catch(() => undefined)
      }
    }
  }
  const preflight = (
    toolCallId: string,
    toolName: string,
    input: unknown,
    ctx: ExtensionContext
  ): typeof refused | { input: Record<string, unknown> } => {
    try {
      const child = states.get(ctx.sessionManager)
      if (
        !child ||
        !active(child, ctx) ||
        !child.profile.definition.tools.some((tool) => tool.name === toolName) ||
        hasReservedRpcChildUri(input)
      )
        return refused
      const effective = child.canonical!(
        toolCallId,
        toolName,
        createRpcChildCall(child.scope, toolCallId, toolName, input).input
      )
      const call = createRpcChildCall(child.scope, toolCallId, toolName, effective)
      if (
        !projectToolBoundaryDecision(child.scope.cwd, toolName, call.input).allowed ||
        !remoteUrlGuardDecision(toolName, call.input).allowed
      )
        return refused
      const pending = child.calls.get(toolCallId)
      if (
        pending
          ? pending.inputDigest !== call.inputDigest
          : child.seen.has(toolCallId) || child.seen.size >= MAX_RPC_CHILD_CALLS
      )
        return refused
      child.seen.add(toolCallId)
      child.calls.set(toolCallId, call)
      return { input: JSON.parse(JSON.stringify(call.input)) as Record<string, unknown> }
    } catch {
      return refused
    }
  }
  const extension: ExtensionFactory = (pi) => {
    api = pi
    pi.on('before_subagent_spawn', (event, ctx) => {
      try {
        const ready = readiness()
        if (
          ctx.agent.kind !== 'main' ||
          ctx.agent.id !== ready.identity.rootAgentId ||
          actualSession(ctx).sessionId !== ready.identity.rootOmpSessionId
        )
          return refused
        const profile = ready.profiles.find((item) => item.definition.nativeName === event.agent)
        if (
          !profile ||
          event.invocationKind !== 'task' ||
          !approvalIdentifier(event.spawnKey) ||
          JSON.stringify(event.patterns) !==
            JSON.stringify([`${profile.definition.model.provider}/${profile.definition.model.id}`])
        )
          return refused
        snapshotRpcChildProfile(profile)
        return undefined
      } catch {
        return refused
      }
    })
    pi.on('session_start', async (_event, ctx) => {
      if (ctx.agent.kind !== 'sub') return
      const previous = states.get(ctx.sessionManager)
      if (previous) revoke(previous)
      const session = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session
      if (!session) {
        ctx.abort()
        throw new Error('Phi child actual session is unavailable')
      }
      const controller = new AbortController()
      // Install before any readiness/metadata work that can throw; SDK lifecycle errors are swallowed.
      const originalStream = session.agent.streamFn
      let child: ChildState | undefined
      const gate: typeof originalStream = (...args) => {
        if (!child) throw new Error('Phi child provider authority is unavailable')
        if (!active(child, ctx)) {
          revoke(child)
          throw new Error('Phi child provider authority is unavailable')
        }
        try {
          if (
            !sameRpcChildModel(projectRpcChildModel(args[0]), child.profile.model) ||
            !sameRpcChildRoute(projectRpcChildRoute(args[0]), child.profile.route) ||
            rpcChildPromptDigest(args[1].systemPrompt ?? []) !==
              rpcChildPromptDigest(child.effectivePrompt) ||
            JSON.stringify((args[1].tools ?? []).map((tool) => tool.name).sort()) !==
              JSON.stringify(child.profile.definition.tools.map((tool) => tool.name).sort())
          )
            throw new Error('Forwarded child profile mismatch')
          const level = child.profile.definition.thinkingLevel
          if (
            level === 'off'
              ? args[2]?.reasoning !== undefined || args[2]?.disableReasoning !== true
              : String(args[2]?.reasoning) !== level || args[2]?.disableReasoning === true
          )
            throw new Error('Forwarded child thinking mismatch')
        } catch {
          revoke(child)
          throw new Error('Phi child forwarded provider profile was refused')
        }
        child.providerBegun = true
        return originalStream(...args)
      }
      session.agent.streamFn = gate
      try {
        if (actualSession(ctx) !== session) throw new Error('RPC child actual manager differs')
        const current = readiness()
        const ready: RpcChildReadiness = Object.freeze({
          identity: validateRpcChildRoot(current.identity),
          capability: current.capability,
          profiles: current.profiles,
          signal: current.signal
        })
        const source = ready.profiles.find((item) => item.definition.nativeName === ctx.agent.name)
        if (!source) throw new Error('RPC child profile is absent')
        const profile = snapshotRpcChildProfile(source)
        const manager = ctx.sessionManager
        const scope = validateRpcChildScope({
          ...ready.identity,
          nativeAgentId: ctx.agent.id,
          childOmpSessionId: manager.getSessionId(),
          childSessionFile: manager.getSessionFile(),
          parentSession: manager.getHeader()?.parentSession,
          nativeName: ctx.agent.name,
          definitionHash: profile.definition.definitionHash
        })
        if (
          ctx.agent.parentId !== scope.rootAgentId ||
          realpathSync(ctx.cwd) !== scope.cwd ||
          realpathSync(scope.childSessionFile) !== scope.childSessionFile
        )
          throw new Error('RPC child actual scope differs')
        const resources = options.resources
        if (
          profile.definition.resourcesDigest &&
          (!resources ||
            childProfileResourceDigest(profile.definition, resources) !==
              profile.definition.resourcesDigest)
        )
          throw new Error('RPC child trusted resource snapshot differs')
        const skills = profile.definition.skills.map((name) => {
          const skill = resources?.skills.find((item) => item.name === name)
          if (!skill || !options.agentDir)
            throw new Error('RPC child trusted skill content is absent')
          return { name, markdown: readRpcChildSkill(options.agentDir, skill) }
        })
        const environment = profile.definition.environment
          ? resources?.environments.find(
              (item) =>
                item.ref === profile.definition.environment!.ref &&
                item.pluginId === profile.definition.environment!.pluginId
            )
          : undefined
        if (profile.definition.environment && !environment)
          throw new Error('RPC child managed environment is absent')
        if (environment) assertRpcChildEnvironment(environment)
        const effectivePrompt = rpcChildEffectivePrompt(profile.systemPrompt, skills, environment)
        if (
          profile.effectivePromptDigest &&
          profile.effectivePromptDigest !== rpcChildPromptDigest(effectivePrompt)
        )
          throw new Error('RPC child effective prompt differs')
        const nativeTools: ToolInfo[] = profile.definition.tools
          .filter((tool) => tool.site === 'native')
          .map((tool) => {
            const info = pi.getAllTools().find((item) => item.name === tool.name)
            if (!info || info.sourceInfo.source !== 'builtin' || !session.getToolByName(tool.name))
              throw new Error('RPC child native implementation is absent')
            return info
          })
        child = {
          scope,
          profile,
          effectivePrompt,
          streamGate: gate,
          nativeStream: originalStream,
          ...(environment ? { environment } : {}),
          session,
          ready,
          controller,
          api: pi,
          wrappers: new Map(),
          signal: controller.signal,
          sequence: 0,
          registered: false,
          permitted: false,
          activated: false,
          providerBegun: false,
          actualTools: new Map(),
          calls: new Map(),
          seen: new Set(),
          active: (current) => !!child && active(child, current),
          canonical: (id, name, input) => {
            if (!child) throw new Error('RPC child call has no owner')
            if (child.environment) assertRpcChildEnvironment(child.environment)
            const raw = createRpcChildCall(scope, id, name, input)
            if (child.calls.get(id)?.inputDigest === raw.inputDigest) return { ...raw.input }
            if (
              !projectToolBoundaryDecision(scope.cwd, name, raw.input).allowed ||
              !remoteUrlGuardDecision(name, raw.input).allowed
            )
              throw new Error('RPC child raw tool input is outside its project boundary')
            const site = profile.definition.tools.find((tool) => tool.name === name)?.site
            if (site === 'host') return { ...raw.input }
            const effective = canonicalRpcChildNativeInput(scope.cwd, name, raw.input)
            if (child.environment && name === 'powershell')
              throw new Error('Managed child environments require bash')
            return child.environment && name === 'bash'
              ? {
                  ...effective,
                  command: rpcChildEnvironmentCommand(child.environment, effective.command)
                }
              : effective
          },
          consume: (id, name, input) => {
            if (!child || !active(child, ctx)) throw new Error('RPC child call has no authority')
            const expected = child.calls.get(id)
            child.calls.delete(id)
            const actual = createRpcChildCall(scope, id, name, input)
            if (!expected || expected.inputDigest !== actual.inputDigest)
              throw new Error('RPC child effective input differs')
            return expected
          },
          approve: async (call, signal) =>
            (await exchange(child!, 'approve', { call }, signal)).allowed,
          executeHost: async (call, signal) => {
            const reply = await exchange(child!, 'execute', { call }, signal)
            if (!reply.allowed || !reply.result) throw new Error('RPC child host execution refused')
            return reply.result
          },
          resultConsumed: async (call, invocationId, signal) => {
            if (
              !(await exchange(child!, 'result_consumed', { call, invocationId }, signal)).allowed
            )
              throw new Error('RPC child host consumption refused')
          },
          revoke: () => child && revoke(child)
        }
        states.set(ctx.sessionManager, child)
        const ownedChild = child
        child.revokeControlScope = options.controlScopes?.publish(session, () =>
          ownedChild.registered &&
          ownedChild.activated &&
          ownedChild.permitted &&
          active(ownedChild, ctx)
            ? ownedChild.scope
            : undefined
        )
        ready.signal.addEventListener('abort', () => revoke(child!), {
          once: true,
          signal: controller.signal
        })
        if (ready.signal.aborted) throw new Error('RPC child generation ended')
        if (!(await exchange(child, 'register', {}, controller.signal)).allowed)
          throw new Error('RPC child registration refused')
        child.registered = true
        const nativeWrappers = registerRpcChildNativeTools(
          pi,
          nativeTools,
          (name) => session.getToolByName(name),
          (current) => (child && active(child, current) ? child : undefined)
        )
        const hosts = profile.definition.tools
          .filter((tool) => tool.site === 'host')
          .map((tool) => {
            const resource = resources?.hostTools.find((item) => item.name === tool.name)
            if (!resource || !options.hostResult)
              throw new Error('RPC child host implementation is absent')
            return resource
          })
        const hostWrappers = hosts.length
          ? registerRpcChildHostTools(pi, hosts, options.hostResult!, (current) =>
              child && active(child, current) ? child : undefined
            )
          : new Map<string, string>()
        child.wrappers = new Map([...nativeWrappers, ...hostWrappers])
      } catch {
        child ? revoke(child) : controller.abort()
        throw new Error('Phi child registration was refused')
      }
    })
    pi.on('before_agent_start', async (event, ctx) => {
      if (ctx.agent.kind !== 'sub') return
      const child = states.get(ctx.sessionManager)
      if (child) child.permitted = false
      const activationSignal = child
        ? AbortSignal.any([child.controller.signal, AbortSignal.timeout(10_000)])
        : undefined
      try {
        if (!child || child.controller.signal.aborted || !child.registered)
          throw new Error('RPC child registration unavailable')
        const current = readiness()
        if (
          current.capability !== child.ready.capability ||
          current.signal !== child.ready.signal ||
          !sameRpcChildRoot(child.scope, current.identity) ||
          actualSession(ctx) !== child.session
        )
          throw new Error('RPC child generation changed')
        const steered =
          child.activated &&
          child.providerBegun &&
          options.steerPermits?.consume(child.session, child.scope, event.prompt, event.images)
        if (child.activated && child.providerBegun && !steered)
          throw new Error('RPC child later prompt/steer is not supported in R6a')
        const prompt = rpcChildPromptDigest([event.prompt, JSON.stringify(event.images ?? [])])
        if (child.initialPrompt !== undefined && child.initialPrompt !== prompt && !steered)
          throw new Error('RPC child initial submission changed')
        child.initialPrompt = prompt
        const infos = pi.getAllTools()
        if (
          child.profile.definition.tools.some((tool) => {
            const info = infos.find((item) => item.name === tool.name)
            return (
              !info ||
              !rpcChildWrapperSourceMatches(tool, info.sourceInfo.source) ||
              info.description !== child.wrappers.get(tool.name) ||
              (tool.site === 'host' &&
                childResourceHash(info.parameters) !==
                  options.resources?.hostTools.find((item) => item.name === tool.name)
                    ?.schemaSha256)
            )
          })
        )
          throw new Error('RPC child approval wrappers are not installed')
        const names = child.profile.definition.tools.map((tool) => tool.name)
        if (
          JSON.stringify(child.session.getEnabledToolNames().sort()) !==
          JSON.stringify([...names].sort())
        )
          await child.session.setActiveToolPresentation(names, [], true, activationSignal)
        const enabled = child.session.getEnabledToolNames().sort()
        if (JSON.stringify(enabled) !== JSON.stringify([...names].sort()))
          throw new Error('RPC child full actual roster differs')
        const model = ctx.models
          .list()
          .find(
            (item) =>
              item.provider === child.profile.definition.model.provider &&
              item.id === child.profile.definition.model.id
          )
        if (
          !model ||
          !sameRpcChildModel(projectRpcChildModel(model), child.profile.model) ||
          !sameRpcChildRoute(projectRpcChildRoute(model), child.profile.route)
        )
          throw new Error('RPC child trusted model/route unavailable')
        if (
          (child.session.model?.provider !== model.provider ||
            child.session.model?.id !== model.id) &&
          !(await pi.setModel(model))
        )
          throw new Error('RPC child model selection refused')
        const level = child.profile.definition.thinkingLevel
        if (level === undefined) throw new Error('RPC child effective thinking profile is absent')
        const effectiveLevel =
          level === 'off'
            ? 'off'
            : child.session.getAvailableThinkingLevels().find((item) => String(item) === level)
        if (effectiveLevel === undefined)
          throw new Error('RPC child thinking level is unsupported by the actual model')
        if (child.session.thinkingLevel !== effectiveLevel)
          child.session.setThinkingLevel(effectiveLevel)
        if (
          rpcChildPromptDigest(child.session.agent.state.systemPrompt) !==
          rpcChildPromptDigest(child.effectivePrompt)
        )
          child.session.agent.setSystemPrompt([...child.effectivePrompt])
        const actual = validateRpcChildActual({
          tools: enabled,
          model: projectRpcChildModel(child.session.model),
          route: projectRpcChildRoute(child.session.model),
          systemPromptDigest: rpcChildPromptDigest(child.session.agent.state.systemPrompt),
          thinkingLevel: child.session.thinkingLevel,
          ...(child.profile.definition.resourcesDigest
            ? { resourcesDigest: child.profile.definition.resourcesDigest }
            : {})
        })
        if (
          !sameRpcChildModel(actual.model, child.profile.model) ||
          !sameRpcChildRoute(actual.route, child.profile.route) ||
          actual.thinkingLevel !== level ||
          actual.systemPromptDigest !== rpcChildPromptDigest(child.effectivePrompt)
        )
          throw new Error('RPC child actual profile differs')
        child.actualTools = new Map(
          child.session.agent.state.tools.map((tool) => [tool.name, tool])
        )
        if (!child.activated) {
          if (!(await exchange(child, 'activate', { actual }, activationSignal!)).allowed)
            throw new Error('RPC child activation refused')
          child.activated = true
        }
        activationSignal!.throwIfAborted()
        if (child.controller.signal.aborted || readiness().capability !== child.ready.capability)
          throw new Error('RPC child activation expired')
        child.permitted = true
        return { systemPrompt: [...child.effectivePrompt] }
      } catch {
        child && revoke(child)
        throw new Error('Phi child activation was refused')
      }
    })
    pi.on('tool_call', (event, ctx) => {
      if (hasReservedRpcChildUri(event.input))
        return { block: true, reason: 'Private Phi child URIs are not model tools' }
      return ctx.agent.kind === 'sub'
        ? preflight(event.toolCallId, event.toolName, event.input, ctx)
        : undefined
    })
    pi.on('session_shutdown', (_event, ctx) => {
      const child = states.get(ctx.sessionManager)
      if (ctx.agent.kind === 'sub' && child) {
        revoke(child)
        states.delete(ctx.sessionManager)
      }
    })
  }
  return {
    extension,
    preflight,
    modelScope: (ctx, nativeStream) => {
      const child = states.get(ctx.sessionManager)
      return child &&
        (nativeStream === undefined || child.nativeStream === nativeStream) &&
        child.registered &&
        child.activated &&
        child.permitted &&
        active(child, ctx)
        ? child.scope
        : undefined
    },
    dispose: () => {
      disposed = true
      for (const child of states.values()) {
        revoke(child)
        // Retired children keep their closed provider gate; asynchronous abort is not proof of quiescence.
      }
      states.clear()
    }
  }
}
