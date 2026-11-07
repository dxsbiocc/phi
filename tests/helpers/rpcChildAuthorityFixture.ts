import type {
  RpcChildScope,
  RpcChildTrustedProfile
} from '../../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
import type { RpcChildRuntimeConfig } from '../../src/main/agent/engine/phi-extension/lib/rpc-child-config'

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

export const childConfig = Object.freeze({
  schema: 1,
  nonce: '12345678-1234-4234-8234-123456789012',
  phiSessionId: childScope.phiSessionId,
  projectId: childScope.projectId,
  projectRoot: childScope.cwd,
  generation: childScope.generation,
  manifestHash: 'b'.repeat(64),
  manifestBinding: {
    serverId: 'private-server',
    serverIdentitySha256: 'c'.repeat(64),
    projectId: childScope.projectId,
    projectRoot: childScope.cwd
  },
  capability: childCapability,
  profiles: [childProfile],
  files: [],
  policy: { mode: 'foreground-native', taskShape: 'single' }
} satisfies RpcChildRuntimeConfig)
