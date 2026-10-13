import { randomUUID } from 'node:crypto'
import {
  createRpcChildCall,
  rpcChildPromptDigest,
  type RpcChildActualProfile,
  type RpcChildRequest,
  type RpcChildScope,
  type RpcChildTrustedProfile
} from '../../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
import {
  RpcChildAuthority,
  type RpcChildAuthorityOptions
} from '../../src/main/agent/engine/rpc/subagents/child-authority'
import type { SafeModelDescriptor } from '../../src/main/agent/engine/model-gateway-types'
import type { RpcFrame } from '../../src/main/agent/engine/rpc/types'

export const childModel: SafeModelDescriptor = {
  provider: 'fixture',
  id: 'model',
  name: 'model',
  reasoning: false,
  input: ['text'],
  contextWindow: 32768,
  maxTokens: 1024
}
export const childCapability = 'f'.repeat(64)
export const childScope: RpcChildScope = Object.freeze({
  phiSessionId: 'phi-session',
  projectId: 'project',
  cwd: '/srv/project',
  generation: 1,
  rootAgentId: 'Main',
  rootOmpSessionId: 'root-sdk',
  rootSessionFile: '/srv/history/root.jsonl',
  nativeAgentId: 'child',
  childOmpSessionId: 'child-sdk',
  childSessionFile: '/srv/history/root/child.jsonl',
  parentSession: '/srv/history/root.jsonl',
  nativeName: 'phi_native_fg',
  definitionHash: 'a'.repeat(64)
})
export const childProfile: RpcChildTrustedProfile = {
  definition: {
    definitionHash: childScope.definitionHash,
    phiName: 'Native',
    nativeName: childScope.nativeName,
    blocking: true,
    tools: [{ name: 'write', site: 'native' }],
    skills: [],
    model: { provider: 'fixture', id: 'model' },
    thinkingLevel: 'off'
  },
  model: {
    provider: 'fixture',
    id: 'model',
    reasoning: false,
    input: ['text'],
    contextWindow: 32768,
    maxTokens: 1024
  },
  route: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:34567', transport: 'sse' },
  systemPrompt: ['trusted-child'],
  expectedAgentSource: 'user'
}
export const childActual: RpcChildActualProfile = {
  tools: ['write'],
  model: childProfile.model,
  route: childProfile.route,
  systemPromptDigest: rpcChildPromptDigest(childProfile.systemPrompt),
  thinkingLevel: 'off'
}
export function childStarted(scope = childScope): RpcFrame {
  return {
    type: 'subagent_lifecycle',
    payload: {
      id: scope.nativeAgentId,
      agent: scope.nativeName,
      agentSource: 'user',
      status: 'started',
      sessionFile: scope.childSessionFile,
      parentToolCallId: 'parent-task',
      index: 0
    }
  }
}
export function childRequest(
  operation: 'register' | 'activate' | 'approve',
  sequence: number,
  scope = childScope
): RpcChildRequest {
  const base = {
    schema: 1 as const,
    id: randomUUID(),
    capability: childCapability,
    sequence,
    scope
  }
  if (operation === 'register') return { ...base, operation }
  if (operation === 'activate') return { ...base, operation, actual: childActual }
  return {
    ...base,
    operation,
    call: createRpcChildCall(scope, 'native-write', 'write', {
      path: '/srv/project/file',
      content: 'exact'
    })
  }
}
export function childAuthority(options: Partial<RpcChildAuthorityOptions> = {}): {
  authority: RpcChildAuthority
  controller: AbortController
} {
  const controller = new AbortController()
  const identity = {
    phiSessionId: childScope.phiSessionId,
    projectId: childScope.projectId,
    cwd: childScope.cwd,
    generation: childScope.generation,
    rootAgentId: childScope.rootAgentId,
    rootOmpSessionId: childScope.rootOmpSessionId,
    rootSessionFile: childScope.rootSessionFile
  }
  const authority = new RpcChildAuthority({
    identity,
    manifestBinding: {
      serverId: 'private-server',
      serverIdentitySha256: 'b'.repeat(64),
      projectId: childScope.projectId,
      projectRoot: childScope.cwd
    },
    capability: childCapability,
    profiles: [childProfile],
    captureParent: () => ({ runId: 'parent-run' }),
    signal: controller.signal,
    cancelNativeChild: (nativeAgentId) => {
      const scope = {
        ...childScope,
        nativeAgentId,
        childSessionFile: `/srv/history/root/${nativeAgentId}.jsonl`
      }
      const frame = childStarted(scope)
      ;(frame.payload as Record<string, unknown>).status = 'aborted'
      authority.observe(frame)
      return true
    },
    approval: { shouldGate: () => true, requestToolApproval: () => 'approved' },
    ...options
  })
  return { controller, authority }
}
export async function activateChild(
  authority: RpcChildAuthority,
  scope = childScope
): Promise<void> {
  authority.observe(childStarted(scope))
  const signal = new AbortController().signal
  const registered = await authority.accept(childRequest('register', 1, scope), signal)
  if (!registered?.allowed) throw new Error('Fixture registration failed')
  const active = await authority.accept(childRequest('activate', 2, scope), signal)
  if (!active?.allowed) throw new Error('Fixture activation failed')
}
