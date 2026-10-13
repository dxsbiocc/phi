import { readFileSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentSession, ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import {
  createRpcSubagentsExtension,
  type RpcChildReadiness
} from '../../src/main/agent/engine/phi-extension/extensions/rpc-subagents'
import {
  validateRpcChildRoot,
  projectRpcChildModel,
  type RpcChildTrustedProfile
} from '../../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'

interface FixtureConfig {
  phiSessionId: string
  projectId: string
  cwd: string
  generation: number
  capability: string
  profiles: RpcChildTrustedProfile[]
  rootSessionFile?: string
  rootSessionDirectory: string
}
const path = process.env.PHI_CHILD_SERVER_CONFIG
if (!path) throw new Error('Private child server fixture configuration missing')
const config = JSON.parse(readFileSync(path, 'utf8')) as FixtureConfig
const generation = new AbortController()
const controllers = new Set<ReturnType<typeof createRpcSubagentsExtension>>()
const observedStreams = new Map<AgentSession, Parameters<AgentSession['agent']['streamFn']>>()
type NativeTool = NonNullable<ReturnType<AgentSession['getToolByName']>>
const originalTools = new Map<AgentSession, Map<string, NativeTool>>()

/** Test-only injection of trusted private state; child sessions still come from actual native task. */
const extension: ExtensionFactory = async (pi) => {
  const readiness = (): RpcChildReadiness | undefined => {
    const ref = pi.pi.AgentRegistry.global().get('Main')
    const session = ref?.session
    if (
      !session ||
      ref?.kind !== 'main' ||
      !session.sessionFile ||
      (config.rootSessionFile !== undefined && session.sessionFile !== config.rootSessionFile) ||
      dirname(session.sessionFile) !== config.rootSessionDirectory ||
      realpathSync(session.sessionManager.getCwd()) !== config.cwd ||
      generation.signal.aborted
    )
      return undefined
    return {
      identity: validateRpcChildRoot({
        phiSessionId: config.phiSessionId,
        projectId: config.projectId,
        cwd: config.cwd,
        generation: config.generation,
        rootAgentId: ref.id,
        rootOmpSessionId: session.sessionId,
        rootSessionFile: session.sessionFile
      }),
      capability: config.capability,
      profiles: config.profiles,
      signal: generation.signal
    }
  }
  const controller = createRpcSubagentsExtension({ readiness })
  controllers.add(controller)
  pi.on('session_start', (_event, ctx) => {
    if (ctx.agent.kind !== 'sub') return
    const session = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session
    if (!session || session.sessionManager !== ctx.sessionManager)
      throw new Error('Private child observer identity differs')
    originalTools.set(
      session,
      new Map(
        ['read', 'write', 'bash', 'powershell'].flatMap((name) => {
          const tool = session.getToolByName(name)
          return tool ? [[name, tool] as const] : []
        })
      )
    )
    const original = session.agent.streamFn
    session.agent.streamFn = (...args) => {
      observedStreams.set(session, args)
      return original(...args)
    }
  })
  await controller.extension(pi)
  pi.registerCommand('phi-child-server-concurrency-probe', {
    handler: async (args, ctx) => {
      if (ctx.agent.kind !== 'main') throw new Error('Private scheduling probe needs main')
      const child = pi.pi.AgentRegistry.global().get(args.trim())?.session
      const originals = child && originalTools.get(child)
      if (!child || !originals) throw new Error('Private scheduling probe needs a real child')
      const policy = (
        tool: NativeTool | undefined
      ): {
        kind: string
        ordinary: 'shared' | 'exclusive' | null
        pty: 'shared' | 'exclusive' | null
      } => {
        const mode = tool?.concurrency
        const resolve = (pty: boolean): 'shared' | 'exclusive' | null =>
          typeof mode === 'function' ? mode.call(Object.freeze({}), { pty }) : (mode ?? null)
        return { kind: typeof mode, ordinary: resolve(false), pty: resolve(true) }
      }
      ctx.ui.notify(
        JSON.stringify({
          type: 'phi_child_concurrency_probe',
          childId: args.trim(),
          tools: Object.fromEntries(
            [...originals].map(([name, original]) => {
              const installed = child.getToolByName(name)
              return [
                name,
                {
                  native: policy(original),
                  installed: policy(installed),
                  activeReference: !!installed && child.agent.state.tools.includes(installed)
                }
              ]
            })
          )
        }),
        'info'
      )
    }
  })
  pi.registerCommand('phi-child-server-thinking-probe', {
    handler: async (args, ctx) => {
      if (ctx.agent.kind !== 'main') throw new Error('Private thinking probe needs main')
      const child = pi.pi.AgentRegistry.global().get(args.trim())?.session
      const observed = child && observedStreams.get(child)
      if (!child || !observed)
        throw new Error('Private thinking probe needs a real observed child call')
      ctx.ui.notify(
        JSON.stringify({
          type: 'phi_child_thinking_probe',
          childId: args.trim(),
          levels: child.getAvailableThinkingLevels().map(String),
          thinkingLevel: child.thinkingLevel,
          reasoning: observed[2]?.reasoning ?? null,
          disableReasoning: observed[2]?.disableReasoning ?? null,
          model: projectRpcChildModel(child.agent.state.model)
        }),
        'info'
      )
    }
  })
  pi.registerCommand('phi-child-server-model-change', {
    handler: async (args, ctx) => {
      if (ctx.agent.kind !== 'main') throw new Error('Private model mutation probe needs main')
      const [childId, mutation = 'model'] = args.trim().split(' ')
      const child = pi.pi.AgentRegistry.global().get(childId)?.session
      const target = ctx.models
        .list()
        .find((model) => model.provider === 'fixture' && model.id === 'shadow')
      if (!child || !target) throw new Error('Private actual model mutation target unavailable')
      if (mutation !== 'model') {
        let gateRejected = false
        if (mutation === 'limits')
          child.agent.setModel({
            ...child.agent.state.model,
            maxTokens: (child.agent.state.model.maxTokens ?? 0) + 1
          })
        else if (mutation === 'route')
          child.agent.setModel({ ...child.agent.state.model, baseUrl: 'http://127.0.0.1:9' })
        else if (mutation === 'forward-model') {
          const observed = observedStreams.get(child)
          if (!observed)
            throw new Error('Private forwarded-model probe needs actual observed arguments')
          try {
            const stream = await child.agent.streamFn(target, observed[1], {
              ...observed[2],
              signal: new AbortController().signal
            })
            for await (const event of stream) void event
          } catch {
            gateRejected = true
          }
        } else throw new Error('Unknown private model mutation probe')
        ctx.ui.notify(
          JSON.stringify({
            type: 'phi_child_model_mutation_probe',
            childId,
            mutation,
            gateRejected
          }),
          'info'
        )
        return
      }
      const before = child.agent.state.model?.id
      child.agent.setModel(target)
      ctx.ui.notify(
        JSON.stringify({
          type: 'phi_child_model_changed_probe',
          childId: args.trim(),
          before,
          after: child.agent.state.model?.id
        }),
        'info'
      )
    }
  })
  pi.registerCommand('phi-child-server-dispose', {
    handler: async (args, ctx) => {
      if (ctx.agent.kind !== 'main') throw new Error('Private retirement probe needs main')
      const child = pi.pi.AgentRegistry.global().get(args.trim())?.session
      const observed = child && observedStreams.get(child)
      for (const installed of controllers) installed.dispose()
      let gateRejected = false
      if (child && observed) {
        try {
          const stream = await child.agent.streamFn(observed[0], observed[1], {
            ...observed[2],
            signal: new AbortController().signal
          })
          for await (const event of stream) {
            void event
            /* Drain a real public stream if the retired gate incorrectly forwards. */
          }
        } catch {
          gateRejected = true
        }
      }
      ctx.ui.notify(
        JSON.stringify({
          type: 'phi_child_disposed_probe',
          childId: args.trim(),
          hadSession: !!child,
          observedArgs: !!observed,
          gateRejected
        }),
        'info'
      )
    }
  })
  pi.on('session_start', (_event, ctx) => {
    if (ctx.agent.kind !== 'main') return
    const ready = readiness()
    if (!ready || ctx.sessionManager.getSessionId() !== ready.identity.rootOmpSessionId)
      throw new Error('Private child root fixture identity differs')
    ctx.ui.notify(
      JSON.stringify({ type: 'phi_child_root_ready', identity: ready.identity }),
      'info'
    )
  })
  pi.on('session_shutdown', (_event, ctx) => {
    controller.dispose()
    controllers.delete(controller)
    if (ctx.agent.kind === 'main') generation.abort()
  })
}
export default extension
