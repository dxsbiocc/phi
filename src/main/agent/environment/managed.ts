import { readFileSync, readdirSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { EnvironmentBuild } from '../../../shared/environmentBuildTypes'
import type {
  ManagedEnvironmentConsumer,
  ManagedEnvironmentEntry,
  ManagedEnvironmentPackage,
  ManagedEnvironmentState
} from '../../../shared/environmentTypes'
import { discoverPhiAgents } from '../agents/discovery'
import {
  describeEnvironment,
  bundledEnvironmentsDir,
  WINDOWS_WSL_PYTHON_REF
} from '../content/environment-refs'
import { parseSkillFile } from '../content/skill'
import {
  computeEnvId,
  currentPlatform,
  getRuntimeRoot,
  isPipDependency,
  parseEnvironmentRef,
  parseEnvironmentSpec,
  parseExplicitLock,
  readEnvironmentIndex,
  type EnvironmentIndexEntry,
  type EnvironmentSpec,
  type PhiPlatform
} from '../envs'
import { estimateBuild } from '../envs/estimate'
import { projectEnvironmentExists, readOverrides } from '../envs/project-environments'
import { readWslRuntime, wslEnvironmentPrefix } from '../envs/wsl'
import { listInstalledPlugins, type LoadedPlugin } from '../plugins/loader'
import { listSkills } from '../resources'
import { getPhiAgentDir } from '../runtime-paths'
import { getBundledAgentsDir } from '../runtime/runtime-adapter'
import { directorySize } from './size'

export interface ManagedEnvironmentConsumerDeclaration {
  ref: string
  pluginId?: string
  consumer: ManagedEnvironmentConsumer
}

export interface ListManagedEnvironmentsOptions {
  projectDir?: string
  root?: string
  environmentsDir?: string
  agentDir?: string
  platform?: PhiPlatform
  builds?: readonly EnvironmentBuild[]
  /** Tests and non-UI callers can supply the already-loaded consumer declarations. */
  consumers?: readonly ManagedEnvironmentConsumerDeclaration[]
  loadSkills?: typeof listSkills
  onSkillDiscoveryError?: (error: unknown) => void
  sizeOf?: (prefix: string) => Promise<number>
  /** False returns only file-backed catalog data; sizes, cache estimates and discovered consumers are deferred. */
  includeDynamic?: boolean
}

interface KnownEnvironment {
  ref: string
  source: ManagedEnvironmentEntry['source']
  pluginId?: string
  overrideFrom?: string[]
}

const FIXED_CONSUMERS: readonly ManagedEnvironmentConsumerDeclaration[] = [
  {
    ref: 'phi:nextflow@1',
    consumer: { kind: 'wrapper', name: 'nextflow', label: 'Nextflow wrappers' }
  },
  {
    ref: 'phi:jupyter@1',
    consumer: { kind: 'notebook', name: 'jupyter-server', label: 'Notebook server' }
  },
  {
    ref: 'phi:python@1',
    consumer: { kind: 'kernel', name: 'phi-python', label: 'Python kernel' }
  },
  {
    ref: WINDOWS_WSL_PYTHON_REF,
    consumer: { kind: 'kernel', name: 'phi-python-wsl', label: 'Python (WSL2)' }
  },
  {
    ref: 'phi:r@1',
    consumer: { kind: 'kernel', name: 'phi-r', label: 'R kernel' }
  }
]

function listDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function officialEnvironments(environmentsDir: string, platform: PhiPlatform): KnownEnvironment[] {
  const official = listDirectories(environmentsDir).flatMap((name) => {
    if (!name.startsWith('phi-') || !isFile(join(environmentsDir, name, 'environment.yml'))) {
      return []
    }
    return [{ ref: `phi:${name.slice('phi-'.length)}@1`, source: 'official' as const }]
  })
  const python = join(environmentsDir, 'phi-python')
  if (
    platform === 'win32-x64' &&
    isFile(join(python, 'environment.yml')) &&
    isFile(join(python, 'locks', 'win32-x64.txt')) &&
    isFile(join(python, 'locks', 'linux-x64.txt'))
  ) {
    official.push({ ref: WINDOWS_WSL_PYTHON_REF, source: 'official' })
  }
  return official
}

function pluginEnvironments(plugins: readonly LoadedPlugin[]): KnownEnvironment[] {
  return plugins.flatMap((plugin) =>
    Object.keys(plugin.manifest.environments ?? {}).map((name) => ({
      ref: `plugin:${name}`,
      source: 'plugin' as const,
      pluginId: plugin.id
    }))
  )
}

function projectEnvironments(projectDir: string | undefined): KnownEnvironment[] {
  if (!projectDir) return []
  const overrides = readOverrides(projectDir).overrides
  const byTarget = new Map<string, string[]>()
  for (const [from, target] of Object.entries(overrides)) {
    const list = byTarget.get(target) ?? []
    list.push(from)
    byTarget.set(target, list)
  }
  return listDirectories(join(projectDir, '.phi', 'environments')).flatMap((name) => {
    if (!projectEnvironmentExists(projectDir, name)) return []
    const ref = `project:${name}`
    return [
      {
        ref,
        source: 'project' as const,
        ...(byTarget.has(ref) ? { overrideFrom: byTarget.get(ref)!.sort() } : {})
      }
    ]
  })
}

function environmentId(descriptor: ReturnType<typeof describeEnvironment>): string {
  return computeEnvId({
    scope: descriptor.scope,
    owner: descriptor.owner,
    name: descriptor.spec.name,
    platform: descriptor.platform,
    lockText: descriptor.lockText,
    sourcePackages: descriptor.spec.sourcePackages,
    installation: descriptor.spec.installation
  })
}

function normalizedPackageName(name: string): string {
  return name.toLowerCase().replaceAll('_', '-')
}

function lockedPackageVersions(lockText: string): Map<string, string> {
  const parsed = parseExplicitLock(lockText)
  if (!parsed.ok) return new Map()
  const versions = new Map<string, string>()
  for (const entry of parsed.entries) {
    let filename: string
    try {
      filename = decodeURIComponent(basename(new URL(entry.url).pathname))
    } catch {
      continue
    }
    const stem = filename.endsWith('.tar.bz2')
      ? filename.slice(0, -'.tar.bz2'.length)
      : filename.endsWith('.conda')
        ? filename.slice(0, -'.conda'.length)
        : filename
    const buildSeparator = stem.lastIndexOf('-')
    const versionSeparator = stem.lastIndexOf('-', buildSeparator - 1)
    if (versionSeparator <= 0 || buildSeparator <= versionSeparator) continue
    const name = stem.slice(0, versionSeparator)
    const version = stem.slice(versionSeparator + 1, buildSeparator)
    if (name && version) versions.set(normalizedPackageName(name), version)
  }
  return versions
}

function requestedDependency(value: string): { name: string; version?: string } | undefined {
  const match = /^([a-zA-Z0-9_.-]+)\s*(.*)$/u.exec(value.trim())
  if (!match?.[1]) return undefined
  const requested = match[2]?.trim().replace(/^=(?!=)/u, '')
  return { name: match[1], ...(requested ? { version: requested } : {}) }
}

function environmentPackages(input: {
  spec: Pick<EnvironmentSpec, 'dependencies' | 'sourcePackages'>
  lockText?: string
  platform?: PhiPlatform
}): ManagedEnvironmentPackage[] {
  const locked = lockedPackageVersions(input.lockText ?? '')
  const packages = new Map<string, ManagedEnvironmentPackage>()
  const add = (
    dependency: { name: string; version?: string },
    manager: ManagedEnvironmentPackage['manager']
  ): void => {
    const key = `${manager}:${normalizedPackageName(dependency.name)}`
    packages.set(key, {
      name: dependency.name,
      manager,
      ...((locked.get(normalizedPackageName(dependency.name)) ?? dependency.version)
        ? { version: locked.get(normalizedPackageName(dependency.name)) ?? dependency.version }
        : {})
    })
  }
  for (const dependency of input.spec.dependencies) {
    if (typeof dependency === 'string') {
      const parsed = requestedDependency(dependency)
      if (parsed) add(parsed, 'conda')
      continue
    }
    if (isPipDependency(dependency)) {
      for (const pip of dependency.pip) {
        const parsed = requestedDependency(pip)
        if (parsed) add(parsed, 'pip')
      }
      continue
    }
    if (input.platform && !dependency.platforms.includes(input.platform)) continue
    const parsed = requestedDependency(dependency.conda)
    if (parsed) add(parsed, 'conda')
  }
  for (const source of input.spec.sourcePackages ?? []) {
    add({ name: source.name, version: source.ref.slice(0, 12) }, source.source)
  }
  return [...packages.values()]
}

function metadataState(prefix: string): ManagedEnvironmentState | undefined {
  try {
    const value = JSON.parse(readFileSync(join(prefix, '.phi', 'env.json'), 'utf8')) as {
      status?: unknown
    }
    if (
      value.status === 'absent' ||
      value.status === 'building' ||
      value.status === 'ready' ||
      value.status === 'failed' ||
      value.status === 'drifted'
    ) {
      return value.status
    }
  } catch {
    // The index/build registry still provides a useful state for incomplete or old prefixes.
  }
  return undefined
}

function buildState(build: EnvironmentBuild | undefined): ManagedEnvironmentState | undefined {
  if (!build) return undefined
  if (build.state === 'cancelled') return 'failed'
  return build.state
}

function resolvedState(
  entry: EnvironmentIndexEntry | undefined,
  build: EnvironmentBuild | undefined
): ManagedEnvironmentState {
  const active = buildState(build)
  if (active === 'building') return active
  if (!entry) return active ?? 'absent'
  return metadataState(entry.prefix) ?? entry.status ?? active
}

function errorFor(
  entry: EnvironmentIndexEntry | undefined,
  build: EnvironmentBuild | undefined,
  state: ManagedEnvironmentState
): string | undefined {
  if (state === 'failed' && (build?.state === 'failed' || build?.state === 'cancelled')) {
    return build.error ?? build.message
  }
  return entry?.error
}

function consumerKey(consumer: ManagedEnvironmentConsumer): string {
  return `${consumer.kind}\0${consumer.name}\0${consumer.label ?? ''}`
}

function addConsumer(
  map: Map<string, Map<string, ManagedEnvironmentConsumer>>,
  ref: string,
  consumer: ManagedEnvironmentConsumer
): void {
  const consumers = map.get(ref) ?? new Map<string, ManagedEnvironmentConsumer>()
  consumers.set(consumerKey(consumer), consumer)
  map.set(ref, consumers)
}

async function loadedConsumerDeclarations(
  projectDir: string | undefined,
  plugins: readonly LoadedPlugin[],
  agentDir: string,
  { loadSkills = listSkills, onSkillDiscoveryError }: ListManagedEnvironmentsOptions
): Promise<ManagedEnvironmentConsumerDeclaration[]> {
  const cwd = projectDir ?? process.cwd()
  const declarations: ManagedEnvironmentConsumerDeclaration[] = []
  const skills = await loadSkills(cwd).catch((error: unknown) => {
    // The OMP worker enriches this catalog with skills. Native environment builds
    // and their fixed consumers can still be shown when that worker is unavailable.
    onSkillDiscoveryError?.(error)
    return []
  })
  for (const skill of skills) {
    try {
      const parsed = parseSkillFile(readFileSync(skill.filePath, 'utf8'))
      if (!parsed.ok) continue
      const phi = parsed.frontmatter.phi
      if (!phi || typeof phi !== 'object' || Array.isArray(phi)) continue
      const ref = (phi as Record<string, unknown>).environment
      if (typeof ref === 'string' && ref && !ref.startsWith('./')) {
        const pluginId = plugins.find((plugin) =>
          plugin.components.skills.some((dir) => skill.filePath.startsWith(`${dir}/`))
        )?.id
        declarations.push({
          ref,
          ...(pluginId ? { pluginId } : {}),
          consumer: { kind: 'skill', name: skill.name }
        })
      }
    } catch {
      // A resource can disappear between loader discovery and this read; omit it from this snapshot.
    }
  }

  const agents = discoverPhiAgents({
    cwd,
    agentDir,
    bundledDir: getBundledAgentsDir()
  }).agents.filter((agent) => agent.invocation !== 'host')
  for (const agent of agents) {
    if (agent.environment) {
      declarations.push({
        ref: agent.environment,
        ...(agent.pluginId ? { pluginId: agent.pluginId } : {}),
        consumer: { kind: 'agent', name: agent.name }
      })
    }
  }
  return declarations
}

function consumersByRef(
  declarations: readonly ManagedEnvironmentConsumerDeclaration[],
  known: readonly KnownEnvironment[],
  projectDir: string | undefined
): Map<string, ManagedEnvironmentConsumer[]> {
  const map = new Map<string, Map<string, ManagedEnvironmentConsumer>>()
  const projectRefs = new Set(
    known.filter((item) => item.source === 'project').map((item) => item.ref)
  )
  const overrides = projectDir ? readOverrides(projectDir).overrides : {}
  const effectiveDeclarations = [
    ...declarations,
    ...known.flatMap((environment): ManagedEnvironmentConsumerDeclaration[] =>
      environment.source === 'plugin' && environment.pluginId
        ? [
            {
              ref: environment.ref,
              pluginId: environment.pluginId,
              consumer: { kind: 'plugin', name: environment.pluginId }
            }
          ]
        : []
    )
  ]
  for (const declaration of effectiveDeclarations) {
    const override = overrides[declaration.ref]
    const effectiveRef = override && projectRefs.has(override) ? override : declaration.ref
    addConsumer(
      map,
      consumerRefKey(effectiveRef, override ? undefined : declaration.pluginId),
      declaration.consumer
    )
  }
  return new Map(
    [...map].map(([ref, consumers]) => [
      ref,
      [...consumers.values()].sort((left, right) =>
        `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`)
      )
    ])
  )
}

function consumerRefKey(ref: string, pluginId?: string): string {
  return pluginId ? `${pluginId}\0${ref}` : ref
}

function knownEnvironmentDir(
  environment: KnownEnvironment,
  environmentsDir: string,
  plugins: readonly LoadedPlugin[],
  projectDir?: string
): string | undefined {
  const parsed = parseEnvironmentRef(environment.ref)
  if (parsed.kind === 'phi') return join(environmentsDir, `phi-${parsed.name}`)
  if (parsed.kind === 'plugin' && environment.pluginId) {
    const plugin = plugins.find((candidate) => candidate.id === environment.pluginId)
    const spec = plugin?.manifest.environments?.[parsed.name]?.spec
    return plugin && spec ? dirname(join(plugin.dir, spec)) : undefined
  }
  if (parsed.kind === 'project' && projectDir) {
    return join(projectDir, '.phi', 'environments', parsed.name)
  }
  return undefined
}

function readEnvironmentSpec(dir: string): EnvironmentSpec | undefined {
  try {
    const parsed = parseEnvironmentSpec(readFileSync(join(dir, 'environment.yml'), 'utf8'))
    return parsed.ok ? parsed.spec : undefined
  } catch {
    return undefined
  }
}

function unavailableCatalogEntry(
  environment: KnownEnvironment,
  spec: EnvironmentSpec,
  platform: PhiPlatform,
  consumers: Map<string, ManagedEnvironmentConsumer[]>
): ManagedEnvironmentEntry {
  return {
    ref: environment.ref,
    envId: `unavailable:${environment.ref}:${platform}`,
    state: 'unavailable',
    source: environment.source,
    ...(environment.pluginId ? { pluginId: environment.pluginId } : {}),
    label: spec.name,
    packages: environmentPackages({ spec, platform }),
    ...(spec.description ? { description: spec.description } : {}),
    referrers: [],
    consumers: consumers.get(consumerRefKey(environment.ref, environment.pluginId)) ?? [],
    ...(environment.overrideFrom ? { overrideFrom: environment.overrideFrom } : {}),
    unavailableReason: 'missing-lock'
  }
}

async function indexedEnvironmentSize(
  root: string,
  entry: ManagedEnvironmentEntry,
  indexEntry: EnvironmentIndexEntry,
  sizeOf: (prefix: string) => Promise<number>
): Promise<void> {
  if (entry.runtime !== 'wsl2') {
    entry.sizeBytes = await sizeOf(indexEntry.prefix)
    return
  }
  try {
    const wsl = readWslRuntime(root)
    if (!wsl) throw new Error('WSL runtime is not configured')
    const prefix = wslEnvironmentPrefix(wsl, entry.envId)
    if (!(await stat(join(prefix, 'conda-meta'))).isDirectory()) {
      throw new Error('WSL Conda metadata is missing')
    }
    entry.sizeBytes = await sizeOf(prefix)
  } catch {
    if (entry.state === 'ready') entry.state = 'drifted'
  }
}

/** Catalog all known managed environments without building or mutating the runtime. */
export async function listManagedEnvironments(
  options: ListManagedEnvironmentsOptions = {}
): Promise<ManagedEnvironmentEntry[]> {
  const root = options.root ?? getRuntimeRoot()
  const environmentsDir = options.environmentsDir ?? bundledEnvironmentsDir()
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const plugins = listInstalledPlugins({ agentDir })
  const platform = options.platform ?? currentPlatform()
  const builds = options.builds ?? []
  const sizeOf = options.sizeOf ?? directorySize
  const includeDynamic = options.includeDynamic !== false
  const known = [
    ...officialEnvironments(environmentsDir, platform),
    ...pluginEnvironments(plugins),
    ...projectEnvironments(options.projectDir)
  ]
  const consumerDeclarations = [
    ...(includeDynamic
      ? (options.consumers ??
        (await loadedConsumerDeclarations(options.projectDir, plugins, agentDir, options)))
      : []),
    ...FIXED_CONSUMERS
  ]
  const consumers = consumersByRef(consumerDeclarations, known, options.projectDir)
  const index = readEnvironmentIndex(root)
  const describedIds = new Set<string>()

  const entries = (
    await Promise.all(
      known.map(async (environment): Promise<ManagedEnvironmentEntry | undefined> => {
        let descriptor: ReturnType<typeof describeEnvironment>
        try {
          descriptor = describeEnvironment(environment.ref, {
            environmentsDir,
            agentDir,
            ...(environment.pluginId ? { pluginId: environment.pluginId } : {}),
            platform,
            ...(options.projectDir ? { projectDir: options.projectDir } : {})
          })
        } catch {
          const dir = knownEnvironmentDir(environment, environmentsDir, plugins, options.projectDir)
          const spec = dir ? readEnvironmentSpec(dir) : undefined
          if (!spec || !dir || isFile(join(dir, 'locks', `${platform}.txt`))) return undefined
          return unavailableCatalogEntry(environment, spec, platform, consumers)
        }
        const envId = environmentId(descriptor)
        describedIds.add(envId)
        const indexEntry = index.environments[envId]
        const build = builds.find((candidate) => candidate.envId === envId)
        const state = resolvedState(indexEntry, build)
        const entry: ManagedEnvironmentEntry = {
          ref: environment.ref,
          envId,
          state,
          source: environment.source,
          ...(environment.pluginId ? { pluginId: environment.pluginId } : {}),
          label:
            environment.ref === WINDOWS_WSL_PYTHON_REF ? 'phi-python (WSL2)' : descriptor.spec.name,
          packages: environmentPackages(descriptor),
          ...(descriptor.spec.description ? { description: descriptor.spec.description } : {}),
          referrers: [...(indexEntry?.referrers ?? [])].sort(),
          consumers: consumers.get(consumerRefKey(environment.ref, environment.pluginId)) ?? [],
          ...(environment.overrideFrom ? { overrideFrom: environment.overrideFrom } : {}),
          ...(descriptor.runtime === 'wsl2' ? { runtime: 'wsl2' as const } : {}),
          ...(errorFor(indexEntry, build, state)
            ? { error: errorFor(indexEntry, build, state) }
            : {})
        }
        if (includeDynamic && state === 'absent')
          entry.estimate = estimateBuild(root, descriptor.lockText, descriptor.runtime)
        else if (includeDynamic && indexEntry) {
          await indexedEnvironmentSize(root, entry, indexEntry, sizeOf)
        }
        return entry
      })
    )
  ).filter((entry): entry is ManagedEnvironmentEntry => entry !== undefined)

  for (const [envId, indexEntry] of Object.entries(index.environments)) {
    if (describedIds.has(envId)) continue
    const build = builds.find((candidate) => candidate.envId === envId)
    const state = resolvedState(indexEntry, build)
    const entry: ManagedEnvironmentEntry = {
      ref: `orphaned:${envId}`,
      envId,
      state,
      source: 'orphaned',
      packages: [],
      label: indexEntry.name,
      referrers: [...indexEntry.referrers].sort(),
      consumers: [],
      ...(includeDynamic ? { sizeBytes: await sizeOf(indexEntry.prefix) } : {}),
      ...(errorFor(indexEntry, build, state) ? { error: errorFor(indexEntry, build, state) } : {})
    }
    entries.push(entry)
  }

  return entries.sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      (left.label ?? left.ref).localeCompare(right.label ?? right.ref)
  )
}
