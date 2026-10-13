import { posix } from 'node:path'
import { isValidPhiAgentName, type PhiAgentDefinition } from '../../../agents/definition'
import { parseEnvironmentRef } from '../../../envs/contract'
import type { ModelGatewayModelRef } from '../../model-gateway-types'
import type {
  RpcAgentEnvironmentDescriptor,
  RpcAgentServerBinding,
  RpcAgentToolDescriptor
} from './types'

export const RPC_AGENT_MAX_DEFINITIONS = 64
export const RPC_AGENT_MAX_FILE_BYTES = 1024 * 1024
export const RPC_AGENT_MAX_BUNDLE_BYTES = 8 * 1024 * 1024
export const RPC_AGENT_MANIFEST_PATH = 'phi-agent-definitions.json'
const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
const hashPattern = /^[a-f0-9]{64}$/
const namePattern = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/
const skillPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

// OMP 18.10.3 discovery normalizes builtin/hidden case and the legacy search
// alias. Reject those spellings instead of changing Phi's exact whitelist.
// On SDK upgrades, recheck tools/builtin-names.ts and the actual discovery oracle.
const nativeCaseNormalizedNames = new Set([
  'read',
  'bash',
  'edit',
  'ast_grep',
  'ast_edit',
  'ask',
  'debug',
  'ida',
  'eval',
  'github',
  'glob',
  'grep',
  'find',
  'lsp',
  'checkpoint',
  'rewind',
  'context_notes',
  'new_context',
  'security_scan',
  'task',
  'wait',
  'todo',
  'web_search',
  'write',
  'memory_edit',
  'retain',
  'recall',
  'reflect',
  'learn',
  'manage_skill',
  'yield',
  'goal',
  'think'
])

export function text(value: unknown, label: string, bytes: number, multiline = false): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value, 'utf8') > bytes ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13)
    }) ||
    (!multiline && /[\t\r\n]/.test(value)) ||
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)
  )
    throw new Error(`Invalid RPC agent ${label}`)
  return value
}

function own(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor && !('value' in descriptor)) throw new Error('RPC agent snapshot has an accessor')
  return descriptor?.value
}

export function list(value: unknown, label: string, max: number, pattern?: RegExp): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid RPC agent ${label}`)
  const result: string[] = []
  for (let index = 0; index < value.length; index++) {
    const item = text(own(value, String(index)), label, 4096)
    if (pattern && !pattern.test(item)) throw new Error(`Invalid RPC agent ${label}`)
    if (result.includes(item)) throw new Error(`Duplicate RPC agent ${label}`)
    result.push(item)
  }
  return result
}

export type AgentSnapshot = Pick<
  PhiAgentDefinition,
  | 'name'
  | 'description'
  | 'tools'
  | 'skills'
  | 'systemPrompt'
  | 'model'
  | 'thinkingLevel'
  | 'environment'
  | 'pluginId'
>

/** Read only the contract fields; filePath, diagnostics and plugin objects never enter serialization. */
export function snapshotDefinition(definition: PhiAgentDefinition): AgentSnapshot {
  if (!definition || typeof definition !== 'object') throw new Error('Invalid RPC agent definition')
  const name = text(own(definition, 'name'), 'name', 128)
  if (!isValidPhiAgentName(name)) throw new Error('Invalid RPC agent Phi name')
  if (own(definition, 'visibility') !== 'entry') throw new Error('Invalid RPC agent visibility')
  if (own(definition, 'source') !== 'phi' && own(definition, 'source') !== 'compat')
    throw new Error('Invalid RPC agent source')
  const description = text(own(definition, 'description'), 'description', 4096, true)
  const systemPrompt = text(
    own(definition, 'systemPrompt'),
    'system prompt',
    RPC_AGENT_MAX_FILE_BYTES,
    true
  )
  const tools = list(own(definition, 'tools'), 'tools', 256, namePattern)
  if (
    (own(definition, 'source') === 'phi' && !tools.length) ||
    tools.some((name) => name.toLowerCase() === 'task')
  )
    throw new Error('RPC agent needs explicit non-recursive tools')
  for (const name of tools) {
    const lower = name.toLowerCase()
    if (lower === 'search' || (nativeCaseNormalizedNames.has(lower) && name !== lower))
      throw new Error('RPC agent native parser would rewrite the declared tool identity')
  }
  const skills = list(own(definition, 'skills'), 'skills', 128, skillPattern)
  const rawModels = own(definition, 'model')
  const model = rawModels === undefined ? undefined : list(rawModels, 'model selectors', 64)
  const rawLevel = thinkingLevel(own(definition, 'thinkingLevel'))
  const rawEnvironment = own(definition, 'environment')
  const environment = rawEnvironment === undefined ? undefined : environmentRef(rawEnvironment)
  const rawPluginId = own(definition, 'pluginId')
  const pluginId = rawPluginId === undefined ? undefined : identifier(rawPluginId, 'plugin ID')
  if (environment?.startsWith('plugin:') && !pluginId)
    throw new Error('RPC agent plugin environment needs its owner')
  return {
    name,
    description,
    systemPrompt,
    tools,
    skills,
    ...(model === undefined ? {} : { model }),
    ...(rawLevel === undefined
      ? {}
      : { thinkingLevel: rawLevel as PhiAgentDefinition['thinkingLevel'] }),
    ...(environment === undefined ? {} : { environment }),
    ...(pluginId === undefined ? {} : { pluginId })
  }
}

export function thinkingLevel(value: unknown): PhiAgentDefinition['thinkingLevel'] {
  if (value !== undefined && (typeof value !== 'string' || !levels.has(value)))
    throw new Error('Invalid RPC agent thinking level')
  return value as PhiAgentDefinition['thinkingLevel']
}

function environmentRef(value: unknown): string {
  const ref = text(value, 'environment reference', 256)
  if (parseEnvironmentRef(ref).kind === 'path')
    throw new Error('RPC agent environment cannot be a desktop path')
  return ref
}

function identifier(value: unknown, label: string): string {
  const id = text(value, label, 256)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id)) throw new Error(`Invalid RPC agent ${label}`)
  return id
}

export function snapshotBinding(binding: RpcAgentServerBinding): RpcAgentServerBinding {
  if (!binding || typeof binding !== 'object') throw new Error('Invalid RPC agent server binding')
  const projectRoot = text(own(binding, 'projectRoot'), 'project root', 4096)
  if (
    !posix.isAbsolute(projectRoot) ||
    posix.normalize(projectRoot) !== projectRoot ||
    projectRoot.includes('\\')
  )
    throw new Error('RPC agent project root must be a canonical server path')
  const serverIdentitySha256 = text(own(binding, 'serverIdentitySha256'), 'server identity', 64)
  if (!hashPattern.test(serverIdentitySha256)) throw new Error('Invalid RPC agent server identity')
  return {
    serverId: identifier(own(binding, 'serverId'), 'server ID'),
    serverIdentitySha256,
    projectId: identifier(own(binding, 'projectId'), 'project ID'),
    projectRoot
  }
}

export function snapshotEnvironment(
  value: RpcAgentEnvironmentDescriptor,
  agent: AgentSnapshot,
  binding: RpcAgentServerBinding
): RpcAgentEnvironmentDescriptor {
  if (!value || typeof value !== 'object' || own(value, 'status') !== 'ready')
    throw new Error('RPC agent environment must already be ready')
  const ref = environmentRef(own(value, 'ref'))
  const resolvedBinding = snapshotBinding(own(value, 'binding') as RpcAgentServerBinding)
  if (ref !== agent.environment || JSON.stringify(resolvedBinding) !== JSON.stringify(binding))
    throw new Error('RPC agent environment does not match the selected server and project')
  const rawPluginId = own(value, 'pluginId')
  const pluginId = rawPluginId === undefined ? undefined : identifier(rawPluginId, 'plugin ID')
  if (pluginId !== agent.pluginId) throw new Error('RPC agent environment owner does not match')
  const lockSha256 = text(own(value, 'lockSha256'), 'environment lock', 64)
  if (!hashPattern.test(lockSha256)) throw new Error('Invalid RPC agent environment lock')
  return {
    ref,
    ...(pluginId === undefined ? {} : { pluginId }),
    environmentId: identifier(own(value, 'environmentId'), 'environment ID'),
    lockSha256,
    status: 'ready',
    binding: resolvedBinding
  }
}

export function modelRef(model: ModelGatewayModelRef): ModelGatewayModelRef {
  if (!model || typeof model !== 'object') throw new Error('Invalid RPC agent model')
  const provider = text(own(model, 'provider'), 'model provider', 256)
  const id = text(own(model, 'id'), 'model ID', 4096)
  if (provider.includes('/') || provider.trim() !== provider || id.trim() !== id)
    throw new Error('Invalid RPC agent model reference')
  return { provider, id }
}

export function toolRoster(
  roster: readonly RpcAgentToolDescriptor[]
): Map<string, RpcAgentToolDescriptor> {
  if (!Array.isArray(roster) || roster.length > 1024)
    throw new Error('Invalid RPC agent tool roster')
  const result = new Map<string, RpcAgentToolDescriptor>()
  for (const tool of roster) {
    if (!tool || typeof tool !== 'object') throw new Error('Invalid RPC agent tool descriptor')
    const name = text(own(tool, 'name'), 'tool name', 128)
    const site = own(tool, 'site')
    if (!namePattern.test(name) || (site !== 'native' && site !== 'host') || result.has(name))
      throw new Error('Invalid or duplicate RPC agent tool descriptor')
    result.set(name, { name, site })
  }
  return result
}

export function skillRoster(roster: readonly string[]): Set<string> {
  return new Set(list(roster, 'skill roster', 1024, skillPattern))
}
