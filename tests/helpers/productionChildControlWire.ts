import { randomUUID } from 'node:crypto'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import { RpcExecutionAuthority } from '../../src/main/agent/engine/rpc/execution-authority'
import { createProductionChildConfig } from '../../src/main/agent/engine/rpc/subagents/production-child-config'
import {
  CHILD_ATTEST_COMMAND,
  CHILD_ATTEST_DESCRIPTION,
  makeRpcChildAttestation
} from '../../src/main/agent/engine/phi-extension/lib/rpc-child-config'
import {
  RPC_EXECUTION_COMMAND,
  RPC_EXECUTION_DESCRIPTION,
  executionRoster,
  parseExecutionMessage,
  signExecutionMessage,
  type RpcExecutionControl,
  type RpcExecutionOrigin
} from '../../src/main/agent/engine/phi-extension/lib/rpc-execution-protocol'
import {
  createRpcChildCall,
  rpcChildPromptDigest,
  type RpcChildRequest,
  type RpcChildRootScope,
  type RpcChildScope
} from '../../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
import { createInitializationWire } from './rpc-initialization-wire'
import { productionChildOptions, ledgerRun } from './productionChildNodeFixture'

export interface ProductionChildControlWire {
  prepared: Awaited<ReturnType<typeof createProductionChildConfig>>
  root: RpcChildRootScope
  wire: ReturnType<typeof createInitializationWire>
  connection: RpcConnection
  execution: RpcExecutionAuthority
  parent: ReturnType<typeof ledgerRun>
  origin(patch?: Partial<RpcExecutionOrigin>, invalidSignature?: boolean): void
  request(operation: 'register' | 'activate' | 'approve', sequence: number): RpcChildRequest
  lifecycle(status: string): unknown
  cancelled: string[]
  close(): Promise<void>
}
/** Synthetic wire only. RpcConnection/Node authority/runtime are production; this is not SDK evidence. */
export async function productionChildControlWire(
  options: {
    badAttestation?: boolean
    allowNativeTask?: boolean
    actualRootAgentId?: string
    attestationPatch?: Record<string, unknown>
    attestationIdentityPatch?: Partial<RpcChildRootScope>
    stateChangeAfterAttest?: 'session' | 'journal'
  } = {}
): Promise<ProductionChildControlWire> {
  const prepared = await createProductionChildConfig(productionChildOptions())
  const config = prepared.config
  const capability = 'b'.repeat(64)
  const identity = {
    nonce: config.nonce,
    phiSessionId: config.phiSessionId,
    projectId: config.projectId,
    cwd: config.projectRoot,
    generation: 1
  }
  const root = {
    ...identity,
    rootAgentId: options.actualRootAgentId ?? 'Main',
    rootOmpSessionId: 'root-sdk',
    rootSessionFile: '/srv/history/root.jsonl'
  }
  const { nonce: _nonce, ...rootIdentity } = root
  void _nonce
  const roster = [
    { name: 'read', site: 'native' as const },
    { name: 'write', site: 'native' as const },
    ...(options.allowNativeTask === false ? [] : [{ name: 'task', site: 'native' as const }])
  ]
  let latest: RpcExecutionControl | undefined
  let attested = false
  const cancelled: string[] = []
  const scope: RpcChildScope = {
    ...rootIdentity,
    nativeAgentId: 'native-child',
    childOmpSessionId: 'child-sdk',
    childSessionFile: '/srv/history/root/child.jsonl',
    parentSession: '/srv/history/root.jsonl',
    nativeName: config.profiles[0].definition.nativeName,
    definitionHash: config.profiles[0].definition.definitionHash
  }
  const lifecycle = (status: string): unknown => ({
    type: 'subagent_lifecycle',
    payload: {
      id: scope.nativeAgentId,
      agent: scope.nativeName,
      agentSource: 'user',
      status,
      sessionFile: scope.childSessionFile,
      parentToolCallId: 'outer-task',
      index: 0
    }
  })
  const wire = createInitializationWire((command, respond, emit) => {
    if (command.type === 'get_state') {
      respond({
        sessionId:
          attested && options.stateChangeAfterAttest === 'session' ? 'replaced-sdk' : 'root-sdk',
        sessionFile:
          attested && options.stateChangeAfterAttest === 'journal'
            ? '/srv/history/replaced.jsonl'
            : rootIdentity.rootSessionFile
      })
      return true
    }
    if (command.type === 'get_available_commands') {
      respond({
        commands: [
          {
            name: RPC_EXECUTION_COMMAND,
            description: RPC_EXECUTION_DESCRIPTION,
            source: 'extension'
          },
          { name: CHILD_ATTEST_COMMAND, description: CHILD_ATTEST_DESCRIPTION, source: 'extension' }
        ]
      })
      return true
    }
    if (command.type === 'cancel_subagent') {
      cancelled.push(String(command.subagentId))
      emit(lifecycle('aborted'))
      respond({ cancelled: true })
      return true
    }
    if (command.type !== 'prompt') return false
    const text = String(command.message)
    if (text.startsWith(`/${RPC_EXECUTION_COMMAND} `)) {
      const request = parseExecutionMessage(
        text.slice(RPC_EXECUTION_COMMAND.length + 2),
        capability
      )
      if (!request || request.type !== 'phi_rpc_execution_control')
        throw new Error('Invalid synthetic peer control')
      const { proof, ...control } = request
      if (!proof) throw new Error('Synthetic peer lacks its signed control')
      latest = request
      emit({
        type: 'extension_ui_request',
        method: 'notify',
        notifyType: 'info',
        message: JSON.stringify(
          signExecutionMessage({ ...control, type: 'phi_rpc_execution_ack' }, capability)
        )
      })
    } else if (text.startsWith(`/${CHILD_ATTEST_COMMAND} `)) {
      const proof = makeRpcChildAttestation(config, rootIdentity)
      attested = true
      emit({
        type: 'extension_ui_request',
        method: 'notify',
        notifyType: 'info',
        message: JSON.stringify({
          ...proof,
          ...options.attestationPatch,
          ...(options.attestationIdentityPatch
            ? { identity: { ...proof.identity, ...options.attestationIdentityPatch } }
            : {}),
          ...(options.badAttestation ? { hmac: 'f'.repeat(64) } : {})
        })
      })
    } else throw new Error('Synthetic Node test must not claim a model prompt')
    respond({ agentInvoked: false })
    emit({
      type: 'prompt_result',
      id: command.id,
      agentInvoked: false,
      status: 'completed',
      sessionSettled: true
    })
    return true
  })
  const connection = new RpcConnection(() => wire.transport, {
    startupTimeoutMs: 2000,
    requestTimeoutMs: 2000
  })
  await connection.start()
  const execution = await RpcExecutionAuthority.create({
    connection,
    identity,
    capability,
    roster,
    allowNativeTask: options.allowNativeTask !== false
  })
  const parent = ledgerRun()
  const origin = (patch: Partial<RpcExecutionOrigin> = {}, invalidSignature = false): void => {
    if (!latest) throw new Error('Missing synthetic begin control')
    const message: RpcExecutionOrigin = {
      ...identity,
      ompSessionId: 'root-sdk',
      runId: parent.run.runId,
      protocolVersion: 1,
      type: 'phi_rpc_execution_origin',
      rosterHash: executionRoster(roster, { allowNativeTask: options.allowNativeTask !== false })
        .hash,
      sequence: latest.sequence,
      originSequence: 1,
      toolCallId: 'outer-task',
      toolName: 'task',
      inputDigest: 'e'.repeat(64),
      ...patch
    }
    const signed = signExecutionMessage(message, capability)
    wire.emit({
      type: 'extension_ui_request',
      method: 'notify',
      message: JSON.stringify({ ...signed, ...(invalidSignature ? { proof: 'f'.repeat(64) } : {}) })
    })
  }
  const request = (
    operation: 'register' | 'activate' | 'approve',
    sequence: number
  ): RpcChildRequest => {
    const base = {
      schema: 1 as const,
      id: randomUUID(),
      capability: config.capability,
      sequence,
      scope
    }
    if (operation === 'register') return { ...base, operation }
    if (operation === 'activate')
      return {
        ...base,
        operation,
        actual: {
          tools: config.profiles[0].definition.tools.map((tool) => tool.name),
          model: config.profiles[0].model,
          route: config.profiles[0].route,
          thinkingLevel: 'off',
          systemPromptDigest: rpcChildPromptDigest(config.profiles[0].systemPrompt)
        }
      }
    return {
      ...base,
      operation,
      call: createRpcChildCall(scope, 'native-write', 'write', {
        path: '/srv/project/out.txt',
        content: 'APPROVED'
      })
    }
  }
  return {
    prepared,
    root: rootIdentity,
    wire,
    connection,
    execution,
    parent,
    origin,
    request,
    lifecycle,
    cancelled,
    close: () => execution.dispose()
  }
}

export async function controlUntil(check: () => boolean): Promise<void> {
  for (let count = 0; count < 500; count++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('Node production control condition did not arrive')
}
export async function controlExchange(
  f: Awaited<ReturnType<typeof productionChildControlWire>>,
  request: RpcChildRequest
): Promise<boolean> {
  const write = randomUUID(),
    read = randomUUID()
  f.wire.emit({
    type: 'host_uri_request',
    id: write,
    operation: 'write',
    url: `phi-child://request/${request.id}`,
    content: JSON.stringify(request)
  })
  await controlUntil(() =>
    f.wire.commands.some((command) => command.type === 'host_uri_result' && command.id === write)
  )
  f.wire.emit({
    type: 'host_uri_request',
    id: read,
    operation: 'read',
    url: `phi-child://reply/${request.id}`
  })
  await controlUntil(() =>
    f.wire.commands.some((command) => command.type === 'host_uri_result' && command.id === read)
  )
  const reply = f.wire.commands.find(
    (command) => command.type === 'host_uri_result' && command.id === read
  )
  return !!reply && typeof reply.content === 'string' && JSON.parse(reply.content).allowed === true
}
