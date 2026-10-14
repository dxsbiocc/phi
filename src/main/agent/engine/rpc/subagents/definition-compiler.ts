import { createHash } from 'node:crypto'
import { stringify as stringifyYaml } from 'yaml'
import { selectAgentModel } from '../../../agents/model-selection'
import { AGENT_REPORT_PROTOCOL } from '../../../agents/report'
import type { PhiExtensionFile } from '../extension-deployment/types'
import {
  modelRef,
  RPC_AGENT_MANIFEST_PATH,
  RPC_AGENT_MAX_BUNDLE_BYTES,
  RPC_AGENT_MAX_DEFINITIONS,
  RPC_AGENT_MAX_FILE_BYTES,
  skillRoster,
  snapshotBinding,
  snapshotDefinition,
  snapshotEnvironment,
  thinkingLevel,
  toolRoster
} from './definition-validation'
import type {
  CompileRpcAgentDefinitionsOptions,
  RpcAgentDefinitionCompilation,
  RpcAgentDefinitionManifest,
  RpcAgentEnvironmentDescriptor,
  RpcAgentDefinitionProfile
} from './types'

function hash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function sourceFile(path: string, content: string): PhiExtensionFile {
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.length > RPC_AGENT_MAX_FILE_BYTES)
    throw new Error('RPC agent file exceeds its byte limit')
  if (!/^(?:agents\/phi_[a-f0-9]{24}_[0-9]+_(?:fg|bg)\.md|phi-agent-definitions\.json)$/.test(path))
    throw new Error('Invalid RPC agent output path')
  return { path, sha256: hash(bytes), bytes }
}

/**
 * Compile an already trusted desktop snapshot into private generation inputs.
 * These files grant no authority: root must attest them, guard discovery shadowing,
 * and clamp the actual child profile before enabling execution.
 */
export async function compileRpcAgentDefinitions(
  options: CompileRpcAgentDefinitionsOptions
): Promise<RpcAgentDefinitionCompilation> {
  if (!Array.isArray(options.definitions) || options.definitions.length > RPC_AGENT_MAX_DEFINITIONS)
    throw new Error('RPC agent definition count exceeds its limit')
  // Snapshot all mutable inputs before the first asynchronous environment resolution.
  const binding = snapshotBinding(options.binding)
  const agents = options.definitions
    .map(snapshotDefinition)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (new Set(agents.map((agent) => agent.name)).size !== agents.length)
    throw new Error('Duplicate RPC agent Phi names')
  const tools = toolRoster(options.availableTools)
  const skills = skillRoster(options.availableSkills)
  if (!Array.isArray(options.availableModels) || options.availableModels.length > 4096)
    throw new Error('Invalid RPC agent available models')
  const models = options.availableModels.map(modelRef)
  const modelKey = (model: { provider: string; id: string }): string =>
    `${model.provider}/${model.id}`
  const byModel = new Map(models.map((model) => [modelKey(model), model]))
  if (byModel.size !== models.length) throw new Error('Duplicate RPC agent available model')
  const parent = modelRef(options.parentModel)
  const parentThinkingLevel = thinkingLevel(options.parentThinkingLevel)
  if (!byModel.has(modelKey(parent))) throw new Error('RPC agent parent model is unavailable')
  const resolveEnvironment = options.resolveEnvironment
  const resolved: Array<
    Omit<RpcAgentDefinitionProfile, 'nativeName' | 'blocking'> & {
      description: string
      systemPrompt: string
    }
  > = []
  const warnings: string[] = []
  for (const agent of agents) {
    const declaredTools = agent.tools.map((name) => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`RPC agent ${agent.name} declares an unavailable tool`)
      return { ...tool }
    })
    for (const name of agent.skills)
      if (!skills.has(name))
        throw new Error(`RPC agent ${agent.name} declares an unavailable skill`)
    const selection = await selectAgentModel(
      agent.name,
      agent.model,
      (selector) => byModel.get(selector),
      parent
    )
    if (selection.warning) warnings.push(selection.warning)
    let environment: RpcAgentEnvironmentDescriptor | undefined
    if (agent.environment) {
      if (!resolveEnvironment)
        throw new Error('RPC agent environment needs a trusted desktop resolver')
      environment = snapshotEnvironment(
        await resolveEnvironment(
          Object.freeze({
            name: agent.name,
            environment: agent.environment,
            ...(agent.pluginId ? { pluginId: agent.pluginId } : {})
          })
        ),
        agent,
        binding
      )
    }
    const effectiveThinkingLevel = agent.thinkingLevel ?? parentThinkingLevel
    const profile = {
      phiName: agent.name,
      tools: declaredTools,
      skills: [...agent.skills],
      model: { ...(selection.model ?? parent) },
      ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}),
      ...(environment ? { environment } : {})
    }
    resolved.push({
      ...profile,
      definitionHash: hash(
        JSON.stringify({ agent, profile, reportProtocol: AGENT_REPORT_PROTOCOL })
      ),
      description: agent.description,
      systemPrompt: agent.systemPrompt
    })
  }
  const namespace = hash(JSON.stringify({ binding, definitions: resolved })).slice(0, 24)
  const files: PhiExtensionFile[] = []
  const entries: RpcAgentDefinitionProfile[] = []
  for (const [index, item] of resolved.entries()) {
    const { description, systemPrompt, ...profile } = item
    for (const [suffix, blocking] of [
      ['fg', true],
      ['bg', false]
    ] as const) {
      const nativeName = `phi_${namespace}_${index}_${suffix}`
      const entry = { ...profile, nativeName, blocking }
      const frontmatter = stringifyYaml(
        {
          name: nativeName,
          description,
          tools: profile.tools.map((tool) => tool.name),
          spawns: [],
          model: [modelKey(profile.model)],
          ...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
          autoloadSkills: [...profile.skills],
          blocking
        },
        { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' }
      )
      files.push(
        sourceFile(
          `agents/${nativeName}.md`,
          `---\n${frontmatter}---\n${systemPrompt}\n\n${AGENT_REPORT_PROTOCOL}\n`
        )
      )
      entries.push(entry)
    }
  }
  const manifest: RpcAgentDefinitionManifest = { schema: 1, binding, entries }
  const manifestFile = sourceFile(RPC_AGENT_MANIFEST_PATH, `${JSON.stringify(manifest)}\n`)
  files.push(manifestFile)
  if (files.reduce((total, file) => total + file.bytes.length, 0) > RPC_AGENT_MAX_BUNDLE_BYTES)
    throw new Error('RPC agent bundle exceeds its byte limit')
  return { files, manifest, manifestHash: manifestFile.sha256, warnings }
}
