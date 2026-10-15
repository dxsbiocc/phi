import { appendFileSync } from 'node:fs'
import type { createRpcSubagentsExtension } from '../../src/main/agent/engine/phi-extension/extensions/rpc-subagents'

type Factory = ReturnType<typeof createRpcSubagentsExtension>['extension']
type Gate = { release(): void; actor: string }
const gates = new Map<string, Gate>()
let admit!: () => void
const admitted = new Promise<void>((resolve) => {
  admit = resolve
})
const tracePath = process.env.PHI_CHILD_CONTROL_TRACE!
const record = (value: Record<string, unknown>): void => {
  appendFileSync(tracePath, JSON.stringify(value) + '\n', { mode: 0o600 })
}

/** Test-only public API consumer; real task and agent sessions remain untouched. */
const extension: Factory = (pi) => {
  pi.on('session_start', async (_event, ctx) => {
    await pi.setActiveTools(ctx.agent.kind === 'main' ? ['task'] : ['control_gate'])
    record({
      type: 'start',
      id: ctx.agent.id,
      kind: ctx.agent.kind,
      file: ctx.sessionManager.getSessionFile()
    })
  })
  pi.on('before_subagent_spawn', async (event, ctx) => {
    if (!event.spawnKey) return undefined
    const session = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session
    const manager = session?.asyncJobManager
    const before = manager?.getJob(event.spawnKey)
    record({
      type: 'spawn_preflight',
      key: event.spawnKey,
      caller: ctx.agent.id,
      job: before && {
        id: before.id,
        ownerId: before.ownerId,
        agentId: before.agentId,
        type: before.type
      }
    })
    await admitted
    // The first batch item may speculate before TaskTool registers/adopts its
    // async job. Read the actual job after admission instead of caching absence.
    const job = manager?.getJob(event.spawnKey)
    if (
      !manager ||
      !job ||
      pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session !== session ||
      job.ownerId !== ctx.agent.id ||
      job.agentId !== event.spawnKey ||
      job.type !== 'task'
    )
      return { block: true, reason: 'Private task job owner mismatch' }
    manager.acknowledgeDeliveries([job.id])
    record({
      type: 'delivery_suppressed',
      id: job.id,
      owner: job.ownerId,
      suppressed: manager.isDeliverySuppressed(job.id)
    })
    return undefined
  })
  pi.registerCommand('child-control-admit', {
    handler: async (_args, ctx) => {
      if (ctx.agent.kind !== 'main') throw new Error('Private admission requires root')
      record({ type: 'admission_released', owner: ctx.agent.id })
      admit()
    }
  })
  pi.registerTool({
    name: 'control_gate',
    label: 'Private controllable child gate',
    description: 'Wait at a real child tool boundary until this fixture releases it.',
    parameters: pi.typebox.Type.Object({ tag: pi.typebox.Type.String() }),
    approval: 'read',
    loadMode: 'essential',
    async execute(_call, params, signal, _update, ctx) {
      const id = ctx.agent.id
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const gate: Gate = { release, actor: params.tag }
      gates.set(id, gate)
      record({ type: 'gate', id, tag: params.tag })
      let aborted!: () => void
      try {
        await Promise.race([
          held,
          new Promise<never>((_resolve, reject) => {
            aborted = () => reject(signal?.reason ?? new Error('Child gate aborted'))
            signal?.addEventListener('abort', aborted, { once: true })
            if (signal?.aborted) aborted()
          })
        ])
        signal?.throwIfAborted()
        return { content: [{ type: 'text', text: 'Released only ' + id }] }
      } finally {
        signal?.removeEventListener('abort', aborted)
        if (gates.get(id) === gate) gates.delete(id)
      }
    }
  })
  pi.registerCommand('child-control-release', {
    handler: async (args, ctx) => {
      if (ctx.agent.kind !== 'main') throw new Error('Private control requires the root')
      const id = args.trim()
      const gate = gates.get(id)
      if (!gate) throw new Error('Private child gate unavailable')
      gate.release()
    }
  })
  pi.registerCommand('child-control-wait', {
    handler: async (args, ctx) => {
      const [id, token] = args.trim().split(' ')
      const session = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session
      const job = session?.asyncJobManager?.getJob(id)
      if (!job || job.ownerId !== ctx.agent.id) throw new Error('Private owned job unavailable')
      await job.promise
      ctx.ui.notify(
        JSON.stringify({ type: 'child_control_wait', token, id, status: job.status }),
        'info'
      )
    }
  })
}
export default extension
