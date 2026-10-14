import { appendFileSync, readFileSync } from 'node:fs'
import type { AgentSession, ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { InternalUrlRouter } from '@oh-my-pi/pi-coding-agent/internal-urls'

interface FixtureConfig {
  trace: string
  denySpawn: boolean
  requireRead: boolean
  mode: 'allow' | 'throw-only' | 'deny-stream'
  clamp: boolean
  proxy: boolean
  suppressDelivery: boolean
  trustedPrompt: string
}
const config = JSON.parse(
  readFileSync(process.env.PHI_NATIVE_TASK_CONFIG!, 'utf8')
) as FixtureConfig
let ordinal = 0
function trace(type: string, ctx: ExtensionContext, data: Record<string, unknown> = {}): void {
  appendFileSync(
    config.trace,
    JSON.stringify({
      ordinal: ++ordinal,
      type,
      agent: ctx.agent,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd,
      ...data
    }) + '\n'
  )
}

/** Private oracle only. Real native sessions and injected public SDK objects. */
export default function nativeTaskFixture(pi: ExtensionAPI): void {
  let permitted = false
  let registered = false
  const session = (ctx: ExtensionContext): AgentSession => {
    const ref = pi.pi.AgentRegistry.global().get(ctx.agent.id)
    if (!ref?.session || ref.session.sessionManager !== ctx.sessionManager)
      throw new Error('Actual registry session/manager identity mismatch')
    return ref.session
  }
  const request = async (
    operation: string,
    ctx: ExtensionContext,
    extra: Record<string, unknown> = {},
    signal?: AbortSignal
  ): Promise<{ allowed: boolean }> => {
    const content = JSON.stringify({
      operation,
      agent: ctx.agent,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      parentSession: ctx.sessionManager.getHeader()?.parentSession,
      cwd: ctx.cwd,
      ...extra
    })
    const url = `phitask://${operation}/${encodeURIComponent(ctx.agent.id)}`
    if (operation === 'register') {
      await InternalUrlRouter.instance().write(url, content, { cwd: ctx.cwd, signal })
      return { allowed: true }
    }
    const result = await InternalUrlRouter.instance().resolve(
      url + '?data=' + encodeURIComponent(content),
      {
        cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile(),
        sessionId: ctx.sessionManager.getSessionId(),
        signal
      }
    )
    const decision: unknown = JSON.parse(String(result.content))
    if (
      !decision ||
      typeof decision !== 'object' ||
      Array.isArray(decision) ||
      typeof (decision as { allowed?: unknown }).allowed !== 'boolean'
    )
      throw new Error('Private URI decision must contain a boolean allowed field')
    return { allowed: (decision as { allowed: boolean }).allowed }
  }
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.agent.kind === 'sub') {
      permitted = false
      registered = false
    }
    const real = session(ctx)
    trace('session_start', ctx, {
      header: ctx.sessionManager.getHeader(),
      agentFrozen: Object.isFrozen(ctx.agent),
      tools: real.getEnabledToolNames(),
      allTools: pi.getAllTools().map((tool) => tool.name),
      model: real.model?.id,
      systemPrompt: real.agent.state.systemPrompt,
      managerPresent: !!real.asyncJobManager,
      routerInRootNamespace: 'InternalUrlRouter' in pi.pi
    })
    if (ctx.agent.kind !== 'sub') return
    // Throw-only deliberately demonstrates that lifecycle errors are observational.
    if (config.mode === 'throw-only') {
      trace('missing_permit_throw', ctx)
      throw new Error('Private missing permit (throw-only)')
    }
    const original = real.agent.streamFn
    real.agent.streamFn = (...args) => {
      trace('stream_gate', ctx, { permitted })
      if (!permitted) throw new Error('Private child permit is absent')
      return original(...args)
    }
    if (config.mode === 'deny-stream') return
    try {
      await request('register', ctx)
    } catch (error) {
      trace('registration_failed', ctx, { error: String(error) })
      throw error
    }
    registered = true
    trace('registered_ack', ctx)
    const Type = pi.typebox.Type
    pi.registerTool({
      name: 'write',
      label: 'Private native write wrapper',
      description: 'Write a private fixture file after host approval',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      approval: 'read',
      loadMode: 'essential',
      execute: async (outerToolCallId, params, signal, onUpdate, toolCtx) => {
        trace('wrapper_wait', toolCtx, { outerToolCallId, params })
        const decision = await request('approval', toolCtx, { outerToolCallId, params }, signal)
        if (!decision.allowed || signal?.aborted || !permitted)
          throw new Error('Private native call denied')
        if (!toolCtx.invokeTool) throw new Error('Public same-name native delegate unavailable')
        trace('wrapper_invoke', toolCtx, { outerToolCallId })
        const result = await toolCtx.invokeTool(params, { signal, onUpdate })
        trace('wrapper_result', toolCtx, { outerToolCallId, result })
        return result
      }
    })
    if (config.proxy)
      pi.registerTool({
        name: 'ChildHost',
        label: 'Private child host proxy',
        description: 'Private child host URI probe',
        parameters: Type.Object({ value: Type.String() }),
        approval: 'read',
        loadMode: 'essential',
        execute: async (outerToolCallId, params, signal, _onUpdate, toolCtx) => {
          const result = await request('host', toolCtx, { outerToolCallId, params }, signal)
          trace('host_result', toolCtx, { outerToolCallId, result })
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: { outerToolCallId }
          }
        }
      })
  })
  pi.on('before_subagent_spawn', (event, ctx) => {
    const real = session(ctx)
    const manager = real.asyncJobManager
    const job = event.spawnKey ? manager?.getJob(event.spawnKey) : undefined
    trace('spawn_hook', ctx, {
      event,
      job: job && { id: job.id, ownerId: job.ownerId, agentId: job.agentId, type: job.type }
    })
    if (config.denySpawn) return { block: true, reason: 'Private spawn permit denied' }
    if (config.suppressDelivery && event.spawnKey && manager) {
      if (
        !job ||
        job.ownerId !== ctx.agent.id ||
        job.agentId !== event.spawnKey ||
        job.type !== 'task'
      )
        throw new Error('Private async ACK scope was not verified')
      const wrongOwnerCancelled = manager.cancel(job.id, { ownerId: 'OTHER_PRIVATE_ROOT' })
      trace('wrong_owner_cancel', ctx, { jobId: job.id, wrongOwnerCancelled, status: job.status })
      manager.acknowledgeDeliveries([job.id])
      trace('delivery_ack', ctx, {
        jobId: job.id,
        ownerId: job.ownerId,
        suppressed: manager.isDeliverySuppressed(job.id)
      })
    }
    return undefined
  })
  pi.on('before_agent_start', async (_event, ctx) => {
    if (ctx.agent.kind === 'sub') permitted = false
    trace('before_agent_start', ctx)
    if (ctx.agent.kind !== 'sub' || config.mode !== 'allow') return
    // A lifecycle exception is swallowed by the SDK; permission stays closed until the final validated transition.
    try {
      if (!registered) throw new Error('Private child tentative registration is absent')
      const real = session(ctx)
      const decision = await request('activate', ctx)
      if (decision.allowed !== true) {
        trace('activation_refused', ctx)
        return undefined
      }
      if (!config.clamp) throw new Error('Private child profile clamp is not configured')
      const desiredTools = [
        'write',
        ...(config.requireRead ? ['read'] : []),
        ...(config.proxy ? ['ChildHost'] : [])
      ]
      await pi.setActiveTools(desiredTools)
      const actualTools = real.getEnabledToolNames()
      const missingTools = desiredTools.filter((name) => !actualTools.includes(name))
      if (missingTools.length || actualTools.some((name) => !desiredTools.includes(name))) {
        trace('clamp_rejected', ctx, {
          missingTools,
          actualTools,
          nativeReadPresent: !!real.getToolByName('read')
        })
        throw new Error('Private actual child tool roster does not match the profile')
      }
      const model = ctx.models.resolve('fixture/model')
      if (!model) throw new Error('Trusted fixture model unavailable')
      if (
        !(await pi.setModel(model)) ||
        real.model?.provider !== model.provider ||
        real.model?.id !== model.id
      )
        throw new Error('Private actual child model does not match the profile')
      real.agent.setSystemPrompt([config.trustedPrompt])
      if (JSON.stringify(real.agent.state.systemPrompt) !== JSON.stringify([config.trustedPrompt]))
        throw new Error('Private actual child prompt does not match the profile')
      permitted = true
      trace('clamped', ctx, {
        tools: actualTools,
        model: real.model?.id,
        systemPrompt: real.agent.state.systemPrompt
      })
      return { systemPrompt: [config.trustedPrompt] }
    } catch (error) {
      permitted = false
      trace('activation_failed', ctx, { error: String(error) })
      throw error
    }
  })
  pi.on('tool_call', (event, ctx) => {
    trace('tool_call', ctx, { event })
  })
  pi.on('agent_end', (_event, ctx) => {
    trace('agent_end', ctx, { pendingAsync: session(ctx).hasPendingAsyncWork() })
  })
  pi.registerCommand('phi-native-task-status', {
    handler: async (args, ctx) => {
      const real = session(ctx)
      ctx.ui.notify(
        JSON.stringify({
          type: 'native_task_status',
          nonce: args,
          agent: ctx.agent,
          pendingAsync: real.hasPendingAsyncWork(),
          snapshot: real.getAsyncJobSnapshot(),
          streaming: real.isStreaming,
          sessionId: real.sessionId
        }),
        'info'
      )
    }
  })
  pi.registerCommand('phi-native-task-stop', {
    handler: async (args, ctx) => {
      const real = session(ctx)
      real.asyncJobManager?.cancelAll({ ownerId: ctx.agent.id }, new Error('Private owner stop'))
      ctx.ui.notify(
        JSON.stringify({ type: 'native_task_stopped', nonce: args, agent: ctx.agent }),
        'info'
      )
    }
  })
}
