import type {
  PhiPluginAgentDetail,
  PhiPluginListItem,
  PhiPluginScriptToolDetail,
  PhiPluginSkillDetail,
  PhiPluginUsedEnvironment
} from '../../../shared/phiPluginTypes'
import type { PhiAgentDefinition } from '../agents/definition'
import { resolveSkillEnvironment } from '../content/environment-refs'
import { scriptToolName, type ValidatedSkill } from '../content/skill'
import { parseEnvironmentRef } from '../envs'
import type { LoadedPlugin } from './loader'

export const PLUGIN_DETAIL_IPC_STRING_LIMITS = {
  identifier: 128,
  title: 80,
  summary: 300,
  description: 1024,
  warning: 1024,
  path: 4096,
  timestamp: 64,
  environmentRef: 256
} as const

interface DetailOptions {
  isSkillEnabled?: (name: string) => boolean
}

interface MutableEnvironment {
  ref: string
  name: string
  description?: string
  scope: PhiPluginUsedEnvironment['scope']
  skillNames: Set<string>
  agentNames: Set<string>
  warnings: Set<string>
}

function bounded(value: string, limit: number): string {
  return value.slice(0, limit)
}

function identifier(value: string): string {
  return bounded(value, PLUGIN_DETAIL_IPC_STRING_LIMITS.identifier)
}

function description(value: string): string {
  return bounded(value, PLUGIN_DETAIL_IPC_STRING_LIMITS.description)
}

function environmentRef(value: string): string {
  return bounded(value, PLUGIN_DETAIL_IPC_STRING_LIMITS.environmentRef)
}

function byName<T extends { name: string }>(left: T, right: T): number {
  return left.name.localeCompare(right.name)
}

function agentDetails(agents: readonly PhiAgentDefinition[]): PhiPluginAgentDetail[] {
  return agents
    .map((agent) => ({ name: identifier(agent.name), description: description(agent.description) }))
    .sort(byName)
}

function skillDetails(plugin: LoadedPlugin, options: DetailOptions): PhiPluginSkillDetail[] {
  return plugin.skills
    .map((skill) => {
      const environment = resolveSkillEnvironment(skill)
      return {
        name: identifier(skill.name),
        description: description(skill.description),
        enabled: plugin.enabled && (options.isSkillEnabled?.(skill.name) ?? true),
        environmentRef: environmentRef(environment.ref),
        ...(environment.warnings[0]
          ? {
              environmentWarning: bounded(
                environment.warnings[0],
                PLUGIN_DETAIL_IPC_STRING_LIMITS.warning
              )
            }
          : {})
      }
    })
    .sort(byName)
}

function scriptToolDetails(plugin: LoadedPlugin): PhiPluginScriptToolDetail[] {
  return plugin.skills
    .flatMap((skill) =>
      (skill.phi?.scripts ?? []).map((script) => ({
        name: identifier(scriptToolName(plugin.toolPrefix, script.name)),
        description: description(script.description),
        approval: script.approval,
        skillName: identifier(skill.name)
      }))
    )
    .sort(byName)
}

function environmentKey(ref: string, skill?: ValidatedSkill): string {
  return ref === './environment.yml' && skill ? `skill:${skill.name}\0${ref}` : ref
}

function environmentIdentity(
  plugin: LoadedPlugin,
  ref: string,
  skill?: ValidatedSkill
): Pick<MutableEnvironment, 'ref' | 'name' | 'description' | 'scope'> {
  const parsed = parseEnvironmentRef(ref)
  if (parsed.kind === 'phi') {
    return { ref: environmentRef(ref), name: identifier(`phi-${parsed.name}`), scope: 'builtin' }
  }
  if (parsed.kind === 'plugin') {
    const spec = plugin.environments[parsed.name]?.environment
    return {
      ref: environmentRef(ref),
      name: identifier(spec?.name ?? parsed.name),
      ...(spec?.description ? { description: description(spec.description) } : {}),
      scope: 'private'
    }
  }
  if (parsed.kind === 'project') {
    return { ref: environmentRef(ref), name: identifier(parsed.name), scope: 'project' }
  }
  return {
    ref: environmentRef(ref),
    name: identifier(skill?.name ?? 'skill-environment'),
    scope: 'skill'
  }
}

function environmentEntry(
  environments: Map<string, MutableEnvironment>,
  plugin: LoadedPlugin,
  ref: string,
  skill?: ValidatedSkill
): MutableEnvironment {
  const key = environmentKey(ref, skill)
  const current = environments.get(key)
  if (current) return current
  const created: MutableEnvironment = {
    ...environmentIdentity(plugin, ref, skill),
    skillNames: new Set(),
    agentNames: new Set(),
    warnings: new Set()
  }
  environments.set(key, created)
  return created
}

function addPrivateEnvironments(
  environments: Map<string, MutableEnvironment>,
  plugin: LoadedPlugin
): void {
  for (const name of Object.keys(plugin.environments).sort()) {
    environmentEntry(environments, plugin, `plugin:${name}`)
  }
}

function addSkillEnvironments(
  environments: Map<string, MutableEnvironment>,
  plugin: LoadedPlugin
): void {
  for (const skill of plugin.skills) {
    const resolved = resolveSkillEnvironment(skill)
    const entry = environmentEntry(environments, plugin, resolved.ref, skill)
    entry.skillNames.add(identifier(skill.name))
    for (const warning of resolved.warnings) {
      entry.warnings.add(bounded(warning, PLUGIN_DETAIL_IPC_STRING_LIMITS.warning))
    }
  }
}

function addAgentEnvironments(
  environments: Map<string, MutableEnvironment>,
  plugin: LoadedPlugin
): void {
  for (const agent of plugin.agents) {
    if (!agent.environment) continue
    environmentEntry(environments, plugin, agent.environment).agentNames.add(identifier(agent.name))
  }
}

function usedEnvironments(plugin: LoadedPlugin): PhiPluginUsedEnvironment[] {
  const environments = new Map<string, MutableEnvironment>()
  addPrivateEnvironments(environments, plugin)
  addSkillEnvironments(environments, plugin)
  addAgentEnvironments(environments, plugin)
  return [...environments.values()]
    .map((entry) => ({
      ref: entry.ref,
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      scope: entry.scope,
      skillNames: [...entry.skillNames].sort(),
      agentNames: [...entry.agentNames].sort(),
      ...(entry.warnings.size > 0 ? { warnings: [...entry.warnings].sort() } : {})
    }))
    .sort((left, right) => left.ref.localeCompare(right.ref) || left.name.localeCompare(right.name))
}

/** Build the renderer-facing plugin payload from metadata already loaded and validated by the loader. */
export function buildPhiPluginListItem(
  plugin: LoadedPlugin,
  options: DetailOptions = {}
): PhiPluginListItem {
  const agents = agentDetails(plugin.agents)
  const skills = skillDetails(plugin, options)
  const tools = scriptToolDetails(plugin)
  return {
    id: identifier(plugin.id),
    version: identifier(plugin.version),
    title: bounded(plugin.manifest.title, PLUGIN_DETAIL_IPC_STRING_LIMITS.title),
    summary: bounded(plugin.manifest.summary, PLUGIN_DETAIL_IPC_STRING_LIMITS.summary),
    enabled: plugin.enabled,
    source: plugin.source,
    installedAt: bounded(plugin.installedAt, PLUGIN_DETAIL_IPC_STRING_LIMITS.timestamp),
    directory: bounded(plugin.dir, PLUGIN_DETAIL_IPC_STRING_LIMITS.path),
    agents: agents.map((agent) => agent.name),
    skills: skills.map((skill) => skill.name),
    scriptTools: tools.map((tool) => tool.name),
    environments: Object.keys(plugin.environments)
      .sort()
      .map((name) => ({ name: identifier(name), ref: environmentRef(`plugin:${name}`) })),
    agentDetails: agents,
    skillDetails: skills,
    scriptToolDetails: tools,
    usedEnvironments: usedEnvironments(plugin)
  }
}
