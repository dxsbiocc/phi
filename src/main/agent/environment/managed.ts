import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { EnvironmentBuild } from '../../../shared/environmentBuildTypes'
import type {
  ManagedEnvironmentConsumer,
  ManagedEnvironmentEntry,
  ManagedEnvironmentState
} from '../../../shared/environmentTypes'
import { discoverPhiAgents } from '../agents/discovery'
import { describeEnvironment, bundledEnvironmentsDir } from '../content/environment-refs'
import { parseSkillFile } from '../content/skill'
import {
  computeEnvId,
  currentPlatform,
  getRuntimeRoot,
  readEnvironmentIndex,
  type EnvironmentIndexEntry,
  type PhiPlatform
} from '../envs'
import { estimateBuild } from '../envs/estimate'
import { projectEnvironmentExists, readOverrides } from '../envs/project-environments'
import { listBundledPlugins, bundledPluginsDir } from '../plugins/bundled'
import { listSkills } from '../resources'
import { getPhiAgentDir } from '../runtime-paths'
import { getBundledAgentsDir } from '../runtime/runtime-adapter'
import { directorySize } from './size'

export interface ManagedEnvironmentConsumerDeclaration {
  ref: string
  consumer: ManagedEnvironmentConsumer
}

export interface ListManagedEnvironmentsOptions {
  projectDir?: string
  root?: string
  environmentsDir?: string
  pluginsDir?: string
  platform?: PhiPlatform
  builds?: readonly EnvironmentBuild[]
  /** Tests and non-UI callers can supply the already-loaded consumer declarations. */
  consumers?: readonly ManagedEnvironmentConsumerDeclaration[]
  sizeOf?: (prefix: string) => Promise<number>
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

function officialEnvironments(environmentsDir: string): KnownEnvironment[] {
  return listDirectories(environmentsDir).flatMap((name) => {
    if (!name.startsWith('phi-') || !isFile(join(environmentsDir, name, 'environment.yml'))) {
      return []
    }
    return [{ ref: `phi:${name.slice('phi-'.length)}@1`, source: 'official' as const }]
  })
}

function pluginEnvironments(pluginsDir: string): KnownEnvironment[] {
  return listBundledPlugins(pluginsDir).flatMap((plugin) => {
    if (!plugin.environmentsDir) return []
    return listDirectories(plugin.environmentsDir).flatMap((name) =>
      isFile(join(plugin.environmentsDir!, name, 'environment.yml'))
        ? [{ ref: `plugin:${name}`, source: 'plugin' as const, pluginId: plugin.id }]
        : []
    )
  })
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
    sourcePackages: descriptor.spec.sourcePackages
  })
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
  pluginsDir: string
): Promise<ManagedEnvironmentConsumerDeclaration[]> {
  const cwd = projectDir ?? process.cwd()
  const declarations: ManagedEnvironmentConsumerDeclaration[] = []
  for (const skill of await listSkills(cwd)) {
    try {
      const parsed = parseSkillFile(readFileSync(skill.filePath, 'utf8'))
      if (!parsed.ok) continue
      const phi = parsed.frontmatter.phi
      if (!phi || typeof phi !== 'object' || Array.isArray(phi)) continue
      const ref = (phi as Record<string, unknown>).environment
      if (typeof ref === 'string' && ref && !ref.startsWith('./')) {
        declarations.push({ ref, consumer: { kind: 'skill', name: skill.name } })
      }
    } catch {
      // A resource can disappear between loader discovery and this read; omit it from this snapshot.
    }
  }

  const agents = discoverPhiAgents({
    cwd,
    agentDir: getPhiAgentDir(),
    bundledDir: getBundledAgentsDir(),
    pluginAgentDirs: listBundledPlugins(pluginsDir).flatMap((plugin) =>
      plugin.agentsDir ? [plugin.agentsDir] : []
    )
  }).agents
  for (const agent of agents) {
    if (agent.environment) {
      declarations.push({
        ref: agent.environment,
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
              consumer: { kind: 'plugin', name: environment.pluginId }
            }
          ]
        : []
    )
  ]
  for (const declaration of effectiveDeclarations) {
    const override = overrides[declaration.ref]
    const effectiveRef = override && projectRefs.has(override) ? override : declaration.ref
    addConsumer(map, effectiveRef, declaration.consumer)
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

/** Catalog all known managed environments without building or mutating the runtime. */
export async function listManagedEnvironments(
  options: ListManagedEnvironmentsOptions = {}
): Promise<ManagedEnvironmentEntry[]> {
  const root = options.root ?? getRuntimeRoot()
  const environmentsDir = options.environmentsDir ?? bundledEnvironmentsDir()
  const pluginsDir = options.pluginsDir ?? bundledPluginsDir()
  const platform = options.platform ?? currentPlatform()
  const builds = options.builds ?? []
  const sizeOf = options.sizeOf ?? directorySize
  const known = [
    ...officialEnvironments(environmentsDir),
    ...pluginEnvironments(pluginsDir),
    ...projectEnvironments(options.projectDir)
  ]
  const consumerDeclarations = [
    ...(options.consumers ?? (await loadedConsumerDeclarations(options.projectDir, pluginsDir))),
    ...FIXED_CONSUMERS
  ]
  const consumers = consumersByRef(consumerDeclarations, known, options.projectDir)
  const index = readEnvironmentIndex(root)
  const describedIds = new Set<string>()

  const entries = await Promise.all(
    known.map(async (environment): Promise<ManagedEnvironmentEntry> => {
      const descriptor = describeEnvironment(environment.ref, {
        environmentsDir,
        pluginsDir,
        platform,
        ...(options.projectDir ? { projectDir: options.projectDir } : {})
      })
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
        label: descriptor.spec.name,
        ...(descriptor.spec.description ? { description: descriptor.spec.description } : {}),
        referrers: [...(indexEntry?.referrers ?? [])].sort(),
        consumers: consumers.get(environment.ref) ?? [],
        ...(environment.overrideFrom ? { overrideFrom: environment.overrideFrom } : {}),
        ...(errorFor(indexEntry, build, state) ? { error: errorFor(indexEntry, build, state) } : {})
      }
      if (state === 'absent') entry.estimate = estimateBuild(root, descriptor.lockText)
      else if (indexEntry) entry.sizeBytes = await sizeOf(indexEntry.prefix)
      return entry
    })
  )

  for (const [envId, indexEntry] of Object.entries(index.environments)) {
    if (describedIds.has(envId)) continue
    const build = builds.find((candidate) => candidate.envId === envId)
    const state = resolvedState(indexEntry, build)
    const entry: ManagedEnvironmentEntry = {
      ref: `orphaned:${envId}`,
      envId,
      state,
      source: 'orphaned',
      label: indexEntry.name,
      referrers: [...indexEntry.referrers].sort(),
      consumers: [],
      sizeBytes: await sizeOf(indexEntry.prefix),
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
