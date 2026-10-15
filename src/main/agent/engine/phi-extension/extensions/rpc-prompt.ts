import { realpathSync } from 'node:fs'
import type { ExtensionFactory, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import {
  buildPhiRemoteProjectSystemPrompt,
  filterPersonaContextFile
} from '../lib/phi-main-system-prompt'
import { loadRpcPromptPolicy } from '../lib/rpc-prompt-policy-reader'
import type { RpcRuntimeConfig } from '../lib/rpc-runtime-config'

/** The one trusted main-prompt transform. Persona/context never enables a tool or child. */
export function createRpcPromptExtension(
  runtime: RpcRuntimeConfig,
  signal: AbortSignal
): {
  extension: ExtensionFactory
  assertInstalled(ctx: ExtensionContext): void
} {
  const policy = loadRpcPromptPolicy(runtime)
  let installed = false
  let api: Parameters<ExtensionFactory>[0] | undefined
  const current = (ctx: ExtensionContext): void => {
    signal.throwIfAborted()
    const ref = api?.pi.AgentRegistry.global().get(ctx.agent.id)
    if (
      !installed ||
      ctx.agent.kind !== 'main' ||
      ref?.kind !== 'main' ||
      ref.session?.sessionManager !== ctx.sessionManager ||
      realpathSync(ctx.cwd) !== runtime.projectRoot ||
      loadRpcPromptPolicy(runtime) === undefined
    )
      throw new Error('Phi prompt authority is unavailable')
  }
  return {
    assertInstalled: (ctx) => {
      if (policy) current(ctx)
    },
    extension: (pi) => {
      if (!policy) return
      api = pi
      pi.on('before_agent_start', async (_event, ctx) => {
        if (ctx.agent.kind !== 'main') return
        current(ctx)
        const session = pi.pi.AgentRegistry.global().get(ctx.agent.id)!.session!
        const files = policy.personaPath
          ? filterPersonaContextFile({ agentsFiles: [...policy.contextFiles] }, policy.personaPath)
              .agentsFiles
          : [...policy.contextFiles]
        const tools = pi.getActiveTools().map((name) => session.getToolByName(name))
        if (tools.some((tool) => !tool)) throw new Error('Phi prompt tool metadata is unavailable')
        // Explicit empty skills/custom/append sources prevent foreign disk discovery;
        // trusted skills remain described by the already-installed Phi host tools.
        const built = await pi.pi.buildSystemPrompt({
          cwd: runtime.projectRoot,
          tools: tools.filter((tool) => tool !== undefined),
          skills: [],
          contextFiles: files,
          customPrompt: '',
          appendPrompt: '',
          includeWorkspaceTree: false
        })
        current(ctx)
        if (pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session !== session)
          throw new Error('Phi prompt session changed during preparation')
        return {
          systemPrompt: buildPhiRemoteProjectSystemPrompt(
            built.systemPrompt,
            runtime.projectRoot,
            runtime.projectRoot,
            {
              personaMarkdown: policy.personaMarkdown,
              runtime: policy.runtime,
              memoryBlock: policy.memoryBlock,
              recoverySummary: policy.recoverySummary
            }
          )
        }
      })
      installed = true
    }
  }
}
