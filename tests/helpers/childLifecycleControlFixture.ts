import { randomUUID } from 'node:crypto'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import { RpcChildAuthority } from '../../src/main/agent/engine/rpc/subagents/child-authority'
import { RpcChildRunControls } from '../../src/main/agent/engine/rpc/subagents/child-run-controls'
import { createProductionChildConfig } from '../../src/main/agent/engine/rpc/subagents/production-child-config'
import { productionChildOptions } from './productionChildNodeFixture'
import { createInitializationWire } from './rpc-initialization-wire'
import {
  rpcChildPromptDigest,
  type RpcChildScope
} from '../../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
import {
  createRpcChildControlAck,
  parseRpcChildControlRequest,
  type RpcChildControlRequest,
  RPC_CHILD_CONTROL_COMMAND,
  RPC_CHILD_CONTROL_DESCRIPTION
} from '../../src/main/agent/engine/phi-extension/lib/rpc-child-control'
import type { RpcFrame } from '../../src/main/agent/engine/rpc/types'
import type { RpcChildRuntimeConfig } from '../../src/main/agent/engine/phi-extension/lib/rpc-child-config'

interface ChildLifecycleFixture {
  authority: RpcChildAuthority
  controls: RpcChildRunControls
  config: Readonly<RpcChildRuntimeConfig>
  controller: AbortController
  wire: ReturnType<typeof createInitializationWire>
  cancelled: string[]
  steered: Array<{ id: string; message: string }>
  controlRequests: RpcChildControlRequest[]
  lifecycle(scope: RpcChildScope, status: string): RpcFrame
  activate(id?: string): Promise<RpcChildScope>
  close(): Promise<void>
}

/** Synthetic protocol peer, never claimed as an SDK child/process acceptance. */
export async function childLifecycleControlFixture(
  options: {
    cancelGate?: Promise<void>
    refuseFirstCancel?: boolean
    steerBusyOnce?: boolean
    refuseQueuedCancel?: boolean
    firstLookupGate?: Promise<void>
  } = {}
): Promise<ChildLifecycleFixture> {
  const prepared = await createProductionChildConfig(productionChildOptions())
  const config = prepared.config
  const controller = new AbortController()
  const scopes = new Map<string, RpcChildScope>()
  const cancelled: string[] = []
  const steered: Array<{ id: string; message: string }> = []
  const controlRequests: RpcChildControlRequest[] = []
  let lookups = 0
  const wire = createInitializationWire((command, respond, emit) => {
    if (command.type === 'get_available_commands') {
      const available = {
        commands: [
          {
            name: RPC_CHILD_CONTROL_COMMAND,
            source: 'extension',
            description: RPC_CHILD_CONTROL_DESCRIPTION
          }
        ]
      }
      if (++lookups === 1 && options.firstLookupGate)
        void options.firstLookupGate.then(() => respond(available))
      else respond(available)
      return true
    }
    if (command.type === 'prompt') {
      const prefix = `/${RPC_CHILD_CONTROL_COMMAND} `
      if (typeof command.message !== 'string' || !command.message.startsWith(prefix))
        throw new Error('Control fixture refuses a model prompt')
      const request = parseRpcChildControlRequest(command.message.slice(prefix.length), config)
      controlRequests.push(request)
      const accepted =
        request.action === 'cancel_queued'
          ? options.refuseQueuedCancel !== true
          : !options.steerBusyOnce || steered.length > 0
      if (request.action === 'steer')
        steered.push({ id: request.scope.nativeAgentId, message: request.message })
      emit({
        type: 'extension_ui_request',
        method: 'notify',
        notifyType: 'info',
        message: JSON.stringify(createRpcChildControlAck(request, config, accepted))
      })
      respond({ agentInvoked: false })
      emit({
        type: 'prompt_result',
        id: command.id,
        agentInvoked: false,
        status: 'completed',
        sessionSettled: false
      })
      return true
    }
    return false
  })
  const connection = new RpcConnection(() => wire.transport)
  await connection.start()
  const lifecycle = (scope: RpcChildScope, status: string): RpcFrame => ({
    type: 'subagent_lifecycle',
    payload: {
      id: scope.nativeAgentId,
      agent: scope.nativeName,
      agentSource: 'user',
      parentToolCallId: 'outer-task',
      sessionFile: scope.childSessionFile,
      status,
      index: 0
    }
  })
  const authority = new RpcChildAuthority({
    identity: {
      phiSessionId: config.phiSessionId,
      projectId: config.projectId,
      cwd: config.projectRoot,
      generation: config.generation,
      rootAgentId: 'Main',
      rootOmpSessionId: 'root-sdk',
      rootSessionFile: '/srv/history/root.jsonl'
    },
    manifestBinding: config.manifestBinding,
    profiles: config.profiles,
    capability: config.capability,
    captureParent: () => ({ runId: 'parent-run' }),
    signal: controller.signal,
    approval: { shouldGate: () => true, requestToolApproval: () => 'approved' },
    cancelNativeChild: async (id) => {
      cancelled.push(id)
      if (options.refuseFirstCancel && cancelled.length === 1) return false
      await options.cancelGate
      authority.observe(lifecycle(scopes.get(id)!, 'aborted'))
      return true
    }
  })
  const controls = new RpcChildRunControls({
    connection,
    authority,
    config,
    signal: controller.signal,
    onUnconfirmed: () => authority.dispose()
  })
  return {
    authority,
    controls,
    config,
    controller,
    wire,
    cancelled,
    steered,
    controlRequests,
    lifecycle,
    async activate(id = 'child-one'): Promise<RpcChildScope> {
      const profile = config.profiles[0]
      const scope: RpcChildScope = {
        ...authority.registry.identity,
        nativeAgentId: id,
        childOmpSessionId: `sdk-${id}`,
        childSessionFile: `/srv/history/root/${id}.jsonl`,
        parentSession: '/srv/history/root.jsonl',
        nativeName: profile.definition.nativeName,
        definitionHash: profile.definition.definitionHash
      }
      scopes.set(id, scope)
      authority.observe(lifecycle(scope, 'started'))
      const base = { schema: 1 as const, capability: config.capability, scope }
      const registered = await authority.accept(
        { ...base, id: randomUUID(), sequence: 1, operation: 'register' },
        controller.signal
      )
      const activated = await authority.accept(
        {
          ...base,
          id: randomUUID(),
          sequence: 2,
          operation: 'activate',
          actual: {
            tools: profile.definition.tools.map((tool) => tool.name),
            model: profile.model,
            route: profile.route,
            systemPromptDigest:
              profile.effectivePromptDigest ?? rpcChildPromptDigest(profile.systemPrompt),
            ...(profile.definition.resourcesDigest
              ? { resourcesDigest: profile.definition.resourcesDigest }
              : {}),
            ...(profile.definition.thinkingLevel
              ? { thinkingLevel: profile.definition.thinkingLevel }
              : {})
          }
        },
        controller.signal
      )
      if (!registered?.allowed || !activated?.allowed)
        throw new Error('Synthetic child did not activate')
      return scope
    },
    async close(): Promise<void> {
      authority.dispose()
      controller.abort()
      await connection.close()
    }
  }
}
