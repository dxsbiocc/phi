import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import { setTimeout as delay } from 'node:timers/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRpcTaskAdmissionExtension } from '../../src/main/agent/engine/phi-extension/extensions/rpc-task-admission'
import { rpcTaskDefinitionConflictReason } from '../../src/main/agent/engine/phi-extension/extensions/rpc-task-definition-verifier'
import {
  loadRpcChildRuntimeConfig,
  validateRpcChildRuntimeConfig
} from '../../src/main/agent/engine/phi-extension/lib/rpc-child-config'
import { validateRpcChildRoot } from '../../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
import {
  parseRpcChildHostStartRequest,
  RPC_CHILD_HOST_CANCEL_COMMAND,
  RPC_CHILD_HOST_CANCEL_DESCRIPTION,
  RPC_CHILD_HOST_START_COMMAND,
  RPC_CHILD_HOST_START_DESCRIPTION
} from '../../src/main/agent/engine/phi-extension/lib/rpc-child-host-start'
const startupObservations: Record<string, unknown>[] = []

/** Observes the real public pre-dispatch hook; no replacement task/session/tool. */
const extension: ExtensionFactory = async (pi) => {
  pi.on('session_start', (_event, ctx) => {
    const session = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session
    if (!session || session.sessionManager !== ctx.sessionManager)
      throw new Error('Task admission oracle needs a real registry session')
    const observation = {
      type: 'phi_task_startup_probe',
      kind: ctx.agent.kind,
      id: ctx.agent.id,
      sessionId: session.sessionId,
      parentSession: session.sessionManager.getHeader()?.parentSession ?? null,
      envMarker: process.env.PHI_CHILD_SENTINEL_ENV ?? null,
      tools: session.getEnabledToolNames(),
      extensionPaths: session.extensionPaths,
      preparedCount: session.preparedExtensions?.length ?? null,
      roots: session.effectiveExtensionRoots
    }
    startupObservations.push(observation)
    ctx.ui.notify(JSON.stringify(observation), 'info')
    if (ctx.agent.kind !== 'main') return
    const previous = session.agent.beforeToolCall
    if (!previous) throw new Error('SDK beforeToolCall callback missing')
    session.agent.beforeToolCall = async (call, signal) => {
      if (call.tool.name === 'task')
        ctx.ui.notify(
          JSON.stringify({
            type: 'phi_task_raw_probe',
            raw: call.toolCall.arguments,
            effective: call.args,
            sameReference: call.toolCall.arguments === call.args
          }),
          'info'
        )
      return previous.call(session.agent, call, signal)
    }
  })
  pi.registerCommand('phi-task-startup-observe', {
    handler: async (_args, ctx) => {
      if (ctx.agent.kind !== 'main') throw new Error('Startup inspection requires root')
      ctx.ui.notify(
        JSON.stringify({ type: 'phi_task_startup_snapshot', observations: startupObservations }),
        'info'
      )
    }
  })
  const path = process.env.PHI_TASK_ADMISSION_CONFIG
  if (path) {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    const config = validateRpcChildRuntimeConfig(value, value)
    const admission = createRpcTaskAdmissionExtension({
      config,
      signal: new AbortController().signal,
      ...(config.policy.allowBackground ? { parentRun: () => undefined } : {}),
      verifyResolvedDefinition: rpcTaskDefinitionConflictReason,
      root: () => {
        const ref = pi.pi.AgentRegistry.global().get('Main')
        const session = ref?.session
        return ref && session?.sessionFile
          ? validateRpcChildRoot({
              phiSessionId: config.phiSessionId,
              projectId: config.projectId,
              cwd: config.projectRoot,
              generation: config.generation,
              rootAgentId: ref.id,
              rootOmpSessionId: session.sessionId,
              rootSessionFile: session.sessionFile
            })
          : undefined
      },
      assertPublication: () => {
        if (
          !loadRpcChildRuntimeConfig(join(dirname(path), 'bootstrap.json'), config, {
            required: true
          })
        )
          throw new Error('Private task publication unavailable')
      }
    })
    await admission.extension(pi)
    if (config.policy.allowBackground)
      pi.registerCommand(RPC_CHILD_HOST_START_COMMAND, {
        description: RPC_CHILD_HOST_START_DESCRIPTION,
        handler: async (args, ctx) => {
          const ref = pi.pi.AgentRegistry.global().get('Main')
          const session = ref?.session
          if (!ref || !session?.sessionFile || !ctx.isIdle())
            throw new Error('Host start requires idle Main')
          const root = validateRpcChildRoot({
            phiSessionId: config.phiSessionId,
            projectId: config.projectId,
            cwd: config.projectRoot,
            generation: config.generation,
            rootAgentId: ref.id,
            rootOmpSessionId: session.sessionId,
            rootSessionFile: session.sessionFile
          })
          const request = parseRpcChildHostStartRequest(args, config, root)
          admission.assertInstalled(ctx)
          const delayMs = Number(process.env.PHI_TASK_HOST_START_DELAY_MS ?? 0)
          if (delayMs > 0 && delayMs < 5000) await delay(delayMs)
          await admission.startHostChild(request, ctx)
        }
      })
    if (config.policy.allowBackground)
      pi.registerCommand(RPC_CHILD_HOST_CANCEL_COMMAND, {
        description: RPC_CHILD_HOST_CANCEL_DESCRIPTION,
        handler: async (args, ctx) => {
          const ref = pi.pi.AgentRegistry.global().get('Main')
          const session = ref?.session
          if (!ref || !session?.sessionFile || !ctx.isIdle())
            throw new Error('Host cancellation requires idle Main')
          const root = validateRpcChildRoot({
            phiSessionId: config.phiSessionId,
            projectId: config.projectId,
            cwd: config.projectRoot,
            generation: config.generation,
            rootAgentId: ref.id,
            rootOmpSessionId: session.sessionId,
            rootSessionFile: session.sessionFile
          })
          const request = parseRpcChildHostStartRequest(args, config, root)
          await admission.cancelHostChild(request, ctx)
        }
      })
  }
}
export default extension
