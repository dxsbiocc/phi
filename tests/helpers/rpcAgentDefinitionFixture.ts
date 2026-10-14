import type { PhiAgentDefinition } from '../../src/main/agent/agents/definition'
import type { SafeModelDescriptor } from '../../src/main/agent/engine/model-gateway-types'
import type { CompileRpcAgentDefinitionsOptions } from '../../src/main/agent/engine/rpc/subagents/types'

export function definition(overrides: Partial<PhiAgentDefinition> = {}): PhiAgentDefinition {
  return {
    name: 'Research',
    description: 'Research: "quoted" # 文献\n---\nblocking: false',
    tools: ['read', 'web_search'],
    skills: ['paper-lookup'],
    systemPrompt: '保留完整提示 Ω 🧬\n---\nname: attacker\nUse evidence.',
    visibility: 'entry',
    warnings: [],
    source: 'phi',
    filePath: '/Users/desktop/private/Research.md',
    ...overrides
  }
}

export function safeModel(provider = 'fixture', id = 'model'): SafeModelDescriptor {
  return {
    provider,
    id,
    name: id,
    reasoning: true,
    input: ['text'],
    contextWindow: null,
    maxTokens: null
  }
}

export function compileOptions(
  overrides: Partial<CompileRpcAgentDefinitionsOptions> = {}
): CompileRpcAgentDefinitionsOptions {
  return {
    definitions: [definition()],
    binding: {
      serverId: 'server-1',
      serverIdentitySha256: 'a'.repeat(64),
      projectId: 'project-1',
      projectRoot: '/srv/project'
    },
    availableModels: [safeModel()],
    parentModel: { provider: 'fixture', id: 'model' },
    availableTools: [
      { name: 'read', site: 'native' },
      { name: 'web_search', site: 'host' }
    ],
    availableSkills: ['paper-lookup'],
    ...overrides
  }
}
