import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import semver from 'semver'

import type { PhiAgentDefinition } from '../agents/definition'
import type { EnvironmentDescriptor } from '../content/environment-refs'
import type { ValidatedSkill } from '../content/skill'
import {
  addReferrer,
  collectGarbage,
  computeEnvId,
  currentPlatform,
  getRuntimeRoot,
  loadEnvironment,
  lockSha256,
  readEnvironmentIndex,
  removeReferrer,
  updateEnvironmentEntry,
  type PhiPlatform
} from '../envs'
import { getPhiAgentDir } from '../runtime-paths'
import { isEnabled, setEnabled } from '../enablement'
import type { PhiPluginManifest } from './phi-package'
import {
  copyPluginPackage,
  pluginVersionDir,
  readPluginRegistry,
  removeAllPluginVersions,
  removePluginVersion,
  writePluginRegistry,
  type PluginRegistry,
  type PluginRegistryEntry,
  type PluginSource
} from './store'
import {
  validatePlugin,
  type PluginProblem,
  type ValidatedPlugin,
  type ValidatedPluginEnvironment
} from './validate'

export interface PluginNamespace {
  agentNames?: Iterable<string>
  skillNames?: Iterable<string>
  toolPrefixes?: Iterable<string>
}

export interface PluginLoaderOptions {
  /** Defaults to `PI_CODING_AGENT_DIR`, then `~/.phi`. */
  agentDir?: string
  /** Project whose enablement override should be applied for session assembly. */
  projectDir?: string
  /** Defaults to `<agentDir>/runtime`. */
  runtimeRoot?: string
  platform?: PhiPlatform
  /** Standalone resources already loaded by the caller. Plugin resources are checked automatically. */
  names?: PluginNamespace
  now?: () => Date
}

export interface PluginInstallOptions extends PluginLoaderOptions {
  source?: PluginSource
  /** Installer-owned metadata written into the atomic package copy. */
  sourceMetadata?: string
}

export interface PluginBuildOptions {
  ref: string
  requestedBy: { plugin: string }
}

export type PluginEnvironmentBuilder = (
  descriptor: EnvironmentDescriptor,
  options: PluginBuildOptions
) => Promise<unknown>

export interface PluginUpgradeOptions extends PluginInstallOptions {
  /** Required when an upgrade changes or adds an environment. Production passes `environmentBuilds.start`. */
  build?: PluginEnvironmentBuilder
  garbageCollect?: typeof collectGarbage
}

export interface PluginUninstallOptions extends PluginLoaderOptions {
  garbageCollect?: typeof collectGarbage
}

export interface LoadedPlugin {
  id: string
  version: string
  enabled: boolean
  source: PluginSource
  installedAt: string
  dir: string
  manifest: PhiPluginManifest
  agents: PhiAgentDefinition[]
  skills: ValidatedSkill[]
  environments: ValidatedPlugin['environments']
  toolPrefix: string
  /** Resolved component paths for consumers that scan directories or files. */
  components: { agents: string[]; skills: string[] }
}

export interface PluginLifecycleResult {
  ok: boolean
  errors: PluginProblem[]
  warnings: PluginProblem[]
  plugin?: LoadedPlugin
}

interface EnvironmentRecord {
  descriptor: EnvironmentDescriptor
  envId: string
}

function problem(path: string, message: string): PluginProblem {
  return { level: 'error', path, message }
}

function failed(errors: PluginProblem[], warnings: PluginProblem[] = []): PluginLifecycleResult {
  return { ok: false, errors, warnings }
}

function succeeded(plugin: LoadedPlugin, warnings: PluginProblem[]): PluginLifecycleResult {
  return { ok: true, errors: [], warnings, plugin }
}

function resolvedAgentDir(options: PluginLoaderOptions): string {
  return options.agentDir ?? getPhiAgentDir()
}

function resolvedRuntimeRoot(options: PluginLoaderOptions): string {
  return options.runtimeRoot ?? getRuntimeRoot(resolvedAgentDir(options))
}

function resolvedPlatform(options: PluginLoaderOptions): PhiPlatform {
  return options.platform ?? currentPlatform()
}

function toLoadedPlugin(
  plugin: ValidatedPlugin,
  entry: PluginRegistryEntry,
  options: PluginLoaderOptions
): LoadedPlugin {
  const agentDir = resolvedAgentDir(options)
  return {
    id: plugin.manifest.id,
    version: plugin.manifest.version,
    enabled: isEnabled(
      { key: `plugin:${plugin.manifest.id}`, source: 'plugin' },
      { agentDir, ...(options.projectDir ? { projectDir: options.projectDir } : {}) }
    ),
    source: entry.source,
    installedAt: entry.installedAt,
    dir: plugin.dir,
    manifest: plugin.manifest,
    agents: plugin.agents,
    skills: plugin.skills,
    environments: plugin.environments,
    toolPrefix: plugin.manifest.toolPrefix,
    components: {
      agents: (plugin.manifest.components.agents ?? []).map((path) => join(plugin.dir, path)),
      skills: (plugin.manifest.components.skills ?? []).map((path) => join(plugin.dir, path))
    }
  }
}

function installedPlugin(
  id: string,
  entry: PluginRegistryEntry,
  options: PluginLoaderOptions
): LoadedPlugin | undefined {
  const agentDir = resolvedAgentDir(options)
  if (entry.uninstalledBundled) return undefined
  const dir = pluginVersionDir(id, entry.version, agentDir)
  if (!existsSync(dir)) return undefined
  const result = validatePlugin(dir)
  if (!result.ok || !result.plugin) return undefined
  if (result.plugin.manifest.id !== id || result.plugin.manifest.version !== entry.version) {
    return undefined
  }
  return toLoadedPlugin(result.plugin, entry, options)
}

/** Installed packages, including disabled ones; bundled-uninstall tombstones are hidden. */
export function listInstalledPlugins(options: PluginLoaderOptions = {}): LoadedPlugin[] {
  const agentDir = resolvedAgentDir(options)
  const registry = readPluginRegistry(agentDir)
  return Object.entries(registry.plugins)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([id, entry]) => {
      const plugin = installedPlugin(id, entry, options)
      return plugin ? [plugin] : []
    })
}

/** Active plugin components. Invalid/missing packages and disabled entries fail closed. */
export function loadedPlugins(options: PluginLoaderOptions = {}): LoadedPlugin[] {
  return listInstalledPlugins(options).filter((plugin) => plugin.enabled)
}

function namespaceProblems(
  candidate: ValidatedPlugin,
  options: PluginLoaderOptions,
  ignorePluginId?: string
): PluginProblem[] {
  const existing = loadedPlugins(options).filter((plugin) => plugin.id !== ignorePluginId)
  const agents = new Map<string, string>()
  const skills = new Map<string, string>()
  const prefixes = new Map<string, string>()

  for (const plugin of existing) {
    for (const agent of plugin.agents) agents.set(agent.name, `plugin '${plugin.id}'`)
    for (const skill of plugin.skills) skills.set(skill.name, `plugin '${plugin.id}'`)
    prefixes.set(plugin.toolPrefix, `plugin '${plugin.id}'`)
  }
  for (const name of options.names?.agentNames ?? []) agents.set(name, 'a standalone agent')
  for (const name of options.names?.skillNames ?? []) skills.set(name, 'a standalone skill')
  for (const prefix of options.names?.toolPrefixes ?? []) {
    prefixes.set(prefix, 'a standalone skill')
  }

  const errors: PluginProblem[] = []
  for (const agent of candidate.agents) {
    const owner = agents.get(agent.name)
    if (owner)
      errors.push(
        problem(`agents.${agent.name}`, `agent name '${agent.name}' conflicts with ${owner}`)
      )
  }
  for (const skill of candidate.skills) {
    const owner = skills.get(skill.name)
    if (owner)
      errors.push(
        problem(`skills.${skill.name}`, `skill name '${skill.name}' conflicts with ${owner}`)
      )
  }
  const prefixOwner = prefixes.get(candidate.manifest.toolPrefix)
  if (prefixOwner) {
    errors.push(
      problem(
        'toolPrefix',
        `toolPrefix '${candidate.manifest.toolPrefix}' conflicts with ${prefixOwner}`
      )
    )
  }
  return errors
}

function validateCandidate(
  fromDir: string
): PluginLifecycleResult & { candidate?: ValidatedPlugin } {
  const validation = validatePlugin(fromDir)
  if (!validation.ok || !validation.plugin) {
    return { ok: false, errors: validation.errors, warnings: validation.warnings }
  }
  return {
    ok: true,
    errors: [],
    warnings: validation.warnings,
    candidate: validation.plugin
  }
}

function isEnvironmentReady(runtimeRoot: string, envId: string): boolean {
  try {
    loadEnvironment(runtimeRoot, envId)
    return true
  } catch {
    return false
  }
}

function environmentsOf(
  plugin: ValidatedPlugin,
  platform: PhiPlatform
): Map<string, EnvironmentRecord> {
  const records = new Map<string, EnvironmentRecord>()
  for (const [name, environment] of Object.entries(plugin.environments)) {
    const descriptor = descriptorOf(plugin, environment, platform)
    records.set(name, { descriptor, envId: environmentId(descriptor) })
  }
  return records
}

function descriptorOf(
  plugin: ValidatedPlugin,
  environment: ValidatedPluginEnvironment,
  platform: PhiPlatform
): EnvironmentDescriptor {
  const lockPath = environment.locks[platform]
  if (!lockPath) throw new Error(`plugin environment '${environment.name}' has no ${platform} lock`)
  return {
    ref: `plugin:${environment.name}`,
    scope: 'plugin',
    owner: plugin.manifest.id,
    kind: 'package',
    spec: environment.environment,
    lockText: readFileSync(lockPath, 'utf8'),
    platform
  }
}

function environmentId(descriptor: EnvironmentDescriptor): string {
  return computeEnvId({
    scope: descriptor.scope,
    owner: descriptor.owner,
    name: descriptor.spec.name,
    platform: descriptor.platform,
    lockText: descriptor.lockText,
    sourcePackages: descriptor.spec.sourcePackages
  })
}

function addPluginReference(root: string, pluginId: string, record: EnvironmentRecord): void {
  const index = readEnvironmentIndex(root)
  if (!index.environments[record.envId]) {
    updateEnvironmentEntry(root, record.envId, {
      name: record.descriptor.spec.name,
      kind: 'package',
      platform: record.descriptor.platform,
      prefix: join(root, 'envs', record.envId),
      status: 'absent',
      lockSha256: lockSha256(record.descriptor.lockText),
      referrers: []
    })
  }
  addReferrer(root, record.envId, `plugin:${pluginId}`)
}

function removePluginReference(root: string, pluginId: string, envId: string): void {
  removeReferrer(root, envId, `plugin:${pluginId}`)
}

function registryWith(
  registry: PluginRegistry,
  id: string,
  entry: PluginRegistryEntry | undefined
): PluginRegistry {
  const plugins = { ...registry.plugins }
  if (entry) plugins[id] = entry
  else delete plugins[id]
  return { version: 1, plugins }
}

export function installPlugin(
  fromDir: string,
  options: PluginInstallOptions = {}
): PluginLifecycleResult {
  const validation = validateCandidate(fromDir)
  if (!validation.ok || !validation.candidate) return validation
  const candidate = validation.candidate
  const agentDir = resolvedAgentDir(options)
  const registry = readPluginRegistry(agentDir)
  const current = registry.plugins[candidate.manifest.id]
  if (current && !current.uninstalledBundled) {
    return failed(
      [problem('id', `plugin '${candidate.manifest.id}' is already installed; use upgrade`)],
      validation.warnings
    )
  }
  const conflicts = namespaceProblems(candidate, options)
  if (conflicts.length > 0) return failed(conflicts, validation.warnings)

  const platform = resolvedPlatform(options)
  const runtimeRoot = resolvedRuntimeRoot(options)
  const copiedDir = copyPluginPackage(fromDir, candidate.manifest, agentDir, options.sourceMetadata)
  const copiedValidation = validatePlugin(copiedDir)
  if (!copiedValidation.ok || !copiedValidation.plugin) {
    removePluginVersion(candidate.manifest.id, candidate.manifest.version, agentDir)
    return failed(copiedValidation.errors, [...validation.warnings, ...copiedValidation.warnings])
  }
  const records = [...environmentsOf(copiedValidation.plugin, platform).values()]
  const referenced: string[] = []
  try {
    for (const record of records) {
      addPluginReference(runtimeRoot, candidate.manifest.id, record)
      referenced.push(record.envId)
    }
    const entry: PluginRegistryEntry = {
      version: candidate.manifest.version,
      source: options.source ?? 'local',
      installedAt: (options.now?.() ?? new Date()).toISOString()
    }
    writePluginRegistry(registryWith(registry, candidate.manifest.id, entry), agentDir)
    const installed = toLoadedPlugin(copiedValidation.plugin, entry, options)
    return succeeded(installed, validation.warnings)
  } catch (error) {
    for (const envId of referenced) removePluginReference(runtimeRoot, candidate.manifest.id, envId)
    removePluginVersion(candidate.manifest.id, candidate.manifest.version, agentDir)
    throw error
  }
}

export async function upgradePlugin(
  fromDir: string,
  options: PluginUpgradeOptions = {}
): Promise<PluginLifecycleResult> {
  const validation = validateCandidate(fromDir)
  if (!validation.ok || !validation.candidate) return validation
  const candidate = validation.candidate
  const agentDir = resolvedAgentDir(options)
  const runtimeRoot = resolvedRuntimeRoot(options)
  const platform = resolvedPlatform(options)
  const registry = readPluginRegistry(agentDir)
  const currentEntry = registry.plugins[candidate.manifest.id]
  if (!currentEntry || currentEntry.uninstalledBundled) {
    return failed(
      [problem('id', `plugin '${candidate.manifest.id}' is not installed`)],
      validation.warnings
    )
  }
  const current = installedPlugin(candidate.manifest.id, currentEntry, options)
  if (!current) {
    return failed(
      [problem('id', `installed plugin '${candidate.manifest.id}' is missing or invalid`)],
      validation.warnings
    )
  }
  if (!semver.gt(candidate.manifest.version, current.version)) {
    return failed(
      [
        problem(
          'version',
          `plugin upgrade must be newer than ${current.version}; got ${candidate.manifest.version}`
        )
      ],
      validation.warnings
    )
  }
  if (current.enabled) {
    const conflicts = namespaceProblems(candidate, options, candidate.manifest.id)
    if (conflicts.length > 0) return failed(conflicts, validation.warnings)
  }

  const oldValidation = validatePlugin(current.dir)
  if (!oldValidation.ok || !oldValidation.plugin) {
    return failed(oldValidation.errors, [...validation.warnings, ...oldValidation.warnings])
  }
  const oldEnvironments = environmentsOf(oldValidation.plugin, platform)
  const oldIds = new Set([...oldEnvironments.values()].map((record) => record.envId))
  const builder = options.build
  const gc = options.garbageCollect ?? collectGarbage

  const copiedDir = copyPluginPackage(fromDir, candidate.manifest, agentDir, options.sourceMetadata)
  const copiedValidation = validatePlugin(copiedDir)
  if (!copiedValidation.ok || !copiedValidation.plugin) {
    removePluginVersion(candidate.manifest.id, candidate.manifest.version, agentDir)
    return failed(copiedValidation.errors, [...validation.warnings, ...copiedValidation.warnings])
  }
  const nextEnvironments = environmentsOf(copiedValidation.plugin, platform)
  const nextIds = new Set([...nextEnvironments.values()].map((record) => record.envId))
  // Build before switching only what the user already had built: an environment whose old
  // version is ready must not disappear under a working plugin. One that was never built is
  // built on first use, as after a fresh install (no download the user did not ask for).
  const changed = [...nextEnvironments.entries()]
    .filter(([name, record]) => {
      if (oldIds.has(record.envId)) return false
      const previous = oldEnvironments.get(name)
      return previous !== undefined && isEnvironmentReady(runtimeRoot, previous.envId)
    })
    .map(([, record]) => record)
  const newlyReferenced: string[] = []
  const entry: PluginRegistryEntry = {
    version: candidate.manifest.version,
    source: options.source ?? currentEntry.source,
    installedAt: (options.now?.() ?? new Date()).toISOString()
  }
  try {
    for (const record of changed) {
      if (!builder) {
        throw new Error(
          `plugin '${candidate.manifest.id}' upgrade changes environments but no build dependency was provided`
        )
      }
      await builder(record.descriptor, {
        ref: record.descriptor.ref,
        requestedBy: { plugin: candidate.manifest.id }
      })
    }
    for (const record of nextEnvironments.values()) {
      addPluginReference(runtimeRoot, candidate.manifest.id, record)
      if (!oldIds.has(record.envId)) newlyReferenced.push(record.envId)
    }

    writePluginRegistry(registryWith(registry, candidate.manifest.id, entry), agentDir)
  } catch (error) {
    for (const envId of newlyReferenced) {
      removePluginReference(runtimeRoot, candidate.manifest.id, envId)
    }
    removePluginVersion(candidate.manifest.id, candidate.manifest.version, agentDir)
    gc(runtimeRoot)
    throw error
  }
  for (const envId of oldIds) {
    if (!nextIds.has(envId)) removePluginReference(runtimeRoot, candidate.manifest.id, envId)
  }
  removePluginVersion(candidate.manifest.id, current.version, agentDir)
  gc(runtimeRoot)
  return succeeded(toLoadedPlugin(copiedValidation.plugin, entry, options), validation.warnings)
}

export function setPluginEnabled(
  id: string,
  enabled: boolean,
  options: PluginLoaderOptions = {}
): PluginLifecycleResult {
  const agentDir = resolvedAgentDir(options)
  const registry = readPluginRegistry(agentDir)
  const entry = registry.plugins[id]
  if (!entry || entry.uninstalledBundled)
    return failed([problem('id', `plugin '${id}' is not installed`)])
  const plugin = installedPlugin(id, entry, options)
  if (!plugin) return failed([problem('id', `installed plugin '${id}' is missing or invalid`)])

  if (enabled && plugin.enabled !== enabled) {
    const validation = validatePlugin(plugin.dir)
    if (!validation.ok || !validation.plugin) return failed(validation.errors, validation.warnings)
    const conflicts = namespaceProblems(validation.plugin, options, id)
    if (conflicts.length > 0) return failed(conflicts, validation.warnings)
  }
  setEnabled(`plugin:${id}`, enabled, {
    agentDir,
    ...(options.projectDir ? { projectDir: options.projectDir } : {})
  })
  const updated = installedPlugin(id, entry, options)
  if (!updated) throw new Error(`updated plugin '${id}' failed validation`)
  return succeeded(updated, [])
}

export function uninstallPlugin(
  id: string,
  options: PluginUninstallOptions = {}
): PluginLifecycleResult {
  const agentDir = resolvedAgentDir(options)
  const runtimeRoot = resolvedRuntimeRoot(options)
  const platform = resolvedPlatform(options)
  const registry = readPluginRegistry(agentDir)
  const entry = registry.plugins[id]
  if (!entry || entry.uninstalledBundled)
    return failed([problem('id', `plugin '${id}' is not installed`)])
  const plugin = installedPlugin(id, entry, options)
  if (!plugin) return failed([problem('id', `installed plugin '${id}' is missing or invalid`)])
  const validation = validatePlugin(plugin.dir)
  if (!validation.ok || !validation.plugin) return failed(validation.errors, validation.warnings)

  const records = environmentsOf(validation.plugin, platform)
  const nextEntry: PluginRegistryEntry | undefined =
    entry.source === 'bundled'
      ? { ...entry, enabled: undefined, uninstalledBundled: true }
      : undefined
  writePluginRegistry(registryWith(registry, id, nextEntry), agentDir)
  for (const record of records.values()) removePluginReference(runtimeRoot, id, record.envId)
  removeAllPluginVersions(id, agentDir)
  ;(options.garbageCollect ?? collectGarbage)(runtimeRoot)
  return succeeded(plugin, validation.warnings)
}
