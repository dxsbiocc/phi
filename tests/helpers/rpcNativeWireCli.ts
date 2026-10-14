import { readFileSync, appendFileSync } from 'node:fs'
import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import { NATIVE_TOOL_WIRE_KEYS } from '../../src/main/agent/engine/phi-extension/lib/rpc-native-wire'

const scopePath = process.env.PHI_WIRE_SCOPE
const auditPath = process.env.PHI_WIRE_LOCAL_AUDIT
const modulePath = process.env.PHI_WIRE_ADAPTER
if (!scopePath || !auditPath || !modulePath) throw new Error('Private wire fixture paths required')
const { createNativeStreamIntegrityAdapter } = (await import(
  modulePath
)) as typeof import('../../src/main/agent/engine/phi-extension/lib/rpc-native-stream-adapter')
const scope = JSON.parse(readFileSync(scopePath, 'utf8')) as {
  generation: number
  endpoint: string
  models: Array<{ provider: string; id: string }>
}
const hostNames = Array.from({ length: 20 }, (_, index) => `wire_cli_host_${index}`)
export default ((pi) => {
  for (const [index, name] of hostNames.entries())
    pi.registerTool({
      name,
      label: name,
      description: 'Curated synthetic CLI host schema ' + index,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 40 }, (_, field) => [
            `field_${field}`,
            { type: 'string', description: `Keep ordinary schema field ${field} on tool ${index}` }
          ])
        )
      },
      async execute() {
        return { content: [{ type: 'text' as const, text: 'private fixture tool' }] }
      }
    })
  pi.on('session_start', async (_event, ctx) => {
    await pi.setActiveTools(['read', 'write', 'edit', 'bash', ...hostNames])
    const ref = pi.pi.AgentRegistry.global().get(ctx.agent.id)
    if (!ref?.session || ref.session.sessionManager !== ctx.sessionManager)
      throw new Error('Real session binding failed')
    const original = ref.session.agent.streamFn
    const observed: typeof original = (model, context, options) => {
      const local = options as unknown as Record<string, unknown>
      const speculative = local.speculativeToolExecution as Record<string, unknown> | undefined
      if (!speculative || speculative.enabled !== true || !speculative.host)
        throw new Error('Actual local speculative configuration was lost')
      if (!Reflect.set(speculative, '__wireLocalState', 'synthetic-wire-speculative-host-marker'))
        throw new Error('Private speculative marker could not be installed')
      for (const tool of context.tools ?? [])
        if (
          !Reflect.set(tool, '__wireLocalState', {
            capability: 'synthetic-wire-tool-capability-marker',
            settings: 'synthetic-wire-settings-marker'
          })
        )
          throw new Error('Private actual tool marker could not be installed')
      const tools = (context.tools ?? []).map((tool) =>
        Object.fromEntries(
          NATIVE_TOOL_WIRE_KEYS.filter((key) => Reflect.has(tool, key)).map((key) => [
            key,
            Reflect.get(tool, key)
          ])
        )
      )
      appendFileSync(
        auditPath,
        JSON.stringify({
          speculativeEnabled: speculative.enabled,
          speculativeHostPresent: Boolean(speculative.host),
          toolExecutorsPresent: ref.session!.agent.state.tools.every(
            (tool) => typeof tool.execute === 'function'
          ),
          originalContextLocalStatePresent: (context.tools ?? []).every((tool) =>
            Boolean(Reflect.get(tool, '__wireLocalState'))
          ),
          tools,
          messages: context.messages
        }) + '\n',
        { mode: 0o600 }
      )
      return original(model, context, options)
    }
    ref.session.agent.streamFn = createNativeStreamIntegrityAdapter(observed, {
      ...scope,
      isActive: () => true
    })
  })
}) satisfies ExtensionFactory
