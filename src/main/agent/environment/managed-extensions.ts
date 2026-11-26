import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type {
  ManagedEnvironmentConsumer,
  ManagedEnvironmentEntry
} from '../../../shared/environmentTypes'
import { describeEnvironment, type EnvironmentDescriptor } from '../content/environment-refs'
import { validateSkill, type ValidatedSkill } from '../content/skill'
import { type PhiPlatform } from '../envs/contract'
import { listActiveMcpPackages } from '../packages/mcp-store'
import { readPackageManifest } from '../packages/manifest'
import { listActiveSkillPackages } from '../packages/store'
import { listInstalledPlugins, type LoadedPlugin } from '../plugins/loader'
import { listSkills } from '../resources'
import { getPhiAgentDir } from '../runtime-paths'

export interface ExtensionEnvironmentTarget {
  key: string
  ref: string
  source: Extract<ManagedEnvironmentEntry['source'], 'plugin' | 'skill' | 'mcp'>
  ownerId: string
  ownerLabel: string
  pluginId?: string
  skill?: ValidatedSkill
  mcpPackage?: { id: string; dir: string }
  consumers: ManagedEnvironmentConsumer[]
}

function stablePath(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return resolve(dir)
  }
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 6)
}

function skillEnvironmentRef(name: string, dirKey: string, usedRefs: Set<string>): string {
  const preferred = `skill:${name}`
  if (!usedRefs.has(preferred)) return preferred
  return `skill:${name}@${shortHash(dirKey)}`
}

function addSkillTarget(
  targets: Map<string, ExtensionEnvironmentTarget>,
  usedRefs: Set<string>,
  skill: ValidatedSkill,
  consumerLabel: string
): void {
  if (skill.phi?.environment !== './environment.yml') return
  const key = `skill:${stablePath(skill.dir)}`
  const existing = targets.get(key)
  if (existing) {
    if (
      !existing.consumers.some((item) => item.name === skill.name && item.label === consumerLabel)
    ) {
      existing.consumers.push({ kind: 'skill', name: skill.name, label: consumerLabel })
    }
    return
  }
  const ref = skillEnvironmentRef(skill.name, key, usedRefs)
  usedRefs.add(ref)
  targets.set(key, {
    key,
    ref,
    source: 'skill',
    ownerId: skill.name,
    ownerLabel: skill.name,
    skill,
    consumers: [{ kind: 'skill', name: skill.name, label: consumerLabel }]
  })
}

function collectPluginTargets(
  targets: Map<string, ExtensionEnvironmentTarget>,
  usedRefs: Set<string>,
  plugins: readonly LoadedPlugin[]
): void {
  for (const plugin of plugins) {
    const pluginLabel = plugin.manifest.title || plugin.id
    for (const envName of Object.keys(plugin.manifest.environments ?? {})) {
      const ref = `plugin:${envName}`
      const key = `plugin:${plugin.id}:${envName}`
      if (targets.has(key)) continue
      usedRefs.add(ref)
      targets.set(key, {
        key,
        ref,
        source: 'plugin',
        ownerId: plugin.id,
        ownerLabel: pluginLabel,
        pluginId: plugin.id,
        consumers: [{ kind: 'plugin', name: plugin.id, label: pluginLabel }]
      })
    }
    for (const pluginSkill of plugin.skills) {
      addSkillTarget(targets, usedRefs, pluginSkill, `${pluginSkill.name} (${pluginLabel})`)
    }
  }
}

function collectInstalledSkillPackageTargets(
  targets: Map<string, ExtensionEnvironmentTarget>,
  usedRefs: Set<string>,
  agentDir: string
): void {
  for (const pkg of listActiveSkillPackages(agentDir)) {
    const result = validateSkill(pkg.dir, { expectedName: pkg.id })
    if (!result.ok || !result.skill) continue
    addSkillTarget(targets, usedRefs, result.skill, result.skill.name)
  }
}

function collectInstalledMcpTargets(
  targets: Map<string, ExtensionEnvironmentTarget>,
  usedRefs: Set<string>,
  agentDir: string
): void {
  for (const pkg of listActiveMcpPackages(agentDir)) {
    try {
      const manifest = readPackageManifest(pkg.dir)
      if (manifest.type !== 'mcp' || manifest.connector.transport !== 'stdio') continue
      if (manifest.connector.environment !== './environment.yml') continue
      const key = `mcp:${manifest.id}:${stablePath(pkg.dir)}`
      if (targets.has(key)) continue
      const ref = `mcp:${manifest.id}`
      usedRefs.add(ref)
      const label = manifest.title || manifest.id
      targets.set(key, {
        key,
        ref,
        source: 'mcp',
        ownerId: manifest.id,
        ownerLabel: label,
        mcpPackage: { id: manifest.id, dir: pkg.dir },
        consumers: [{ kind: 'mcp', name: manifest.id, label }]
      })
    } catch {
      // Skip malformed installed MCP packages when enumerating environments.
    }
  }
}

/**
 * Collect private environments declared by installed plugins, installed/discovered skills
 * (`./environment.yml`), and installed stdio MCP packages (`./environment.yml`).
 */
export function collectExtensionEnvironments(options: {
  agentDir: string
  plugins: readonly LoadedPlugin[]
  skills?: readonly ValidatedSkill[]
}): ExtensionEnvironmentTarget[] {
  const targets = new Map<string, ExtensionEnvironmentTarget>()
  const usedRefs = new Set<string>()
  collectPluginTargets(targets, usedRefs, options.plugins)
  collectInstalledSkillPackageTargets(targets, usedRefs, options.agentDir)
  for (const skill of options.skills ?? []) {
    addSkillTarget(targets, usedRefs, skill, skill.name)
  }
  collectInstalledMcpTargets(targets, usedRefs, options.agentDir)
  return [...targets.values()]
}

export function resolveExtensionEnvironmentDescriptor(
  target: ExtensionEnvironmentTarget,
  options: {
    environmentsDir: string
    agentDir: string
    platform: PhiPlatform
  }
): EnvironmentDescriptor {
  if (target.skill) {
    return describeEnvironment('./environment.yml', {
      skill: target.skill,
      environmentsDir: options.environmentsDir,
      agentDir: options.agentDir,
      platform: options.platform
    })
  }
  if (target.mcpPackage) {
    return describeEnvironment('./environment.yml', {
      mcpPackage: target.mcpPackage,
      environmentsDir: options.environmentsDir,
      agentDir: options.agentDir,
      platform: options.platform
    })
  }
  return describeEnvironment(target.ref, {
    environmentsDir: options.environmentsDir,
    agentDir: options.agentDir,
    ...(target.pluginId ? { pluginId: target.pluginId } : {}),
    platform: options.platform
  })
}

export async function findExtensionEnvironmentTargetByRef(
  ref: string,
  options: { agentDir?: string; projectCwd?: string } = {}
): Promise<ExtensionEnvironmentTarget | undefined> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const plugins = listInstalledPlugins({ agentDir })
  const immediate = collectExtensionEnvironments({ agentDir, plugins }).find(
    (target) => target.ref === ref
  )
  if (immediate || !ref.startsWith('skill:')) return immediate

  const discovered = await listSkills(options.projectCwd ?? process.cwd()).catch(() => [])
  const skills: ValidatedSkill[] = []
  for (const item of discovered) {
    const validated = validateSkill(dirname(item.filePath))
    if (validated.ok && validated.skill) skills.push(validated.skill)
  }
  return collectExtensionEnvironments({ agentDir, plugins, skills }).find(
    (target) => target.ref === ref
  )
}
