import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'

import type { WrapperCompositionCatalogItem } from '../../../../shared/wrapperCompositionManifestTypes'
import { getEnablementPath, getEnablementSnapshot } from '../../enablement'
import { getPhiAgentDir } from '../../runtime-paths'
import { findResourceIcon } from '../../resource-icons'
import {
  readWrapperTreeRegistry,
  wrapperTreeDir,
  wrapperTreeRegistryPath
} from '../../packages/wrapper-tree'
import { parseWrapperCompositionManifest, type WrapperCompositionManifest } from './manifest'
import type {
  WrapperModuleDetails,
  WrapperModuleMeta,
  WrapperModuleTool
} from '../../../../shared/wrapperModuleDetailsTypes'

/**
 * Discovery for the agent-composition wrapper layout — see
 * resources/skills/create-wrapper/references/guide.md section 4: scan
 * `modules/**\/wrapper/wrapper.yaml` and `subworkflows/**\/wrapper/wrapper.yaml`
 * under the assembled installed tree, plus the same layout under
 * `wrappers/custom/` for user-authored wrappers. Package ownership and
 * enablement come from `wrappers/tree.json`.
 *
 * Extended with a third root, `workflows/**\/wrapper/wrapper.yaml`, beyond
 * what the design doc's own scan targets list — for a *complete* pipeline
 * (e.g. `workflows/nf-core/rnaseq/`), not a single module/subworkflow. A
 * full nf-core pipeline is self-contained (its own vendored `modules/`/
 * `subworkflows/`, `nextflow_schema.json`, `conf/*.config`) rather than
 * something to hand-decompose into our modules/subworkflows tiers, so it
 * gets the same `wrapper/` adapter convention at its own third tier,
 * matching nf-core's own modules/subworkflows/workflows repo layout.
 */

export interface WrapperCompositionEntry {
  manifest: WrapperCompositionManifest
  /** The `wrapper/` adapter directory — where main.nf/params.json/wrapper.yaml live. */
  wrapperDir: string
  /** The module/subworkflow's own root directory (wrapperDir's parent). */
  componentDir: string
  /** Bounded module family root, derived from the provider/family layout. */
  familyDir?: string
  /** Installed package owner; absent for user-authored wrappers. */
  packageId?: string
  /** Stable identifier for the existing wrapper enablement API. */
  enablementId?: string
  /** Why agent tools must hide this wrapper. */
  hiddenReason?: string
}

const COMPONENT_ROOTS = ['modules', 'subworkflows', 'workflows']
const MAX_SCAN_DEPTH = 6

function findWrapperYamlFiles(rootDir: string): string[] {
  const results: string[] = []

  function walk(dir: string, depth: number): void {
    if (depth > MAX_SCAN_DEPTH) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      let stats: ReturnType<typeof statSync>
      try {
        stats = statSync(full)
      } catch {
        continue
      }
      if (stats.isDirectory()) {
        walk(full, depth + 1)
      } else if (name === 'wrapper.yaml' && basename(dir) === 'wrapper') {
        results.push(full)
      }
    }
  }

  walk(rootDir, 0)
  return results
}

export interface WrapperCompositionDiscoveryOptions {
  agentDir?: string
  projectDir?: string
  /** Explicit source tree for tooling/tests that do not run desktop startup installation. */
  sourceRoot?: string
}

interface CachedCatalog {
  agentDir: string
  sourceRoot?: string
  projectDir?: string
  revision?: string
  entries: WrapperCompositionEntry[]
  packageEnabled: Map<string, boolean>
  packageSelected: Set<string>
}

let cachedCatalog: CachedCatalog | undefined

function catalogRevision(agentDir: string): string {
  return [wrapperTreeRegistryPath(agentDir), getEnablementPath(agentDir)]
    .map((path) => {
      try {
        const stat = statSync(path)
        return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      } catch {
        return 'missing'
      }
    })
    .join('|')
}

function customWrappersDir(agentDir: string): string {
  return join(dirname(wrapperTreeRegistryPath(agentDir)), 'custom')
}

function scanCompositionRoot(
  root: string,
  packageByPath?: ReadonlyMap<string, string>
): WrapperCompositionEntry[] {
  const entries: WrapperCompositionEntry[] = []
  for (const componentRoot of COMPONENT_ROOTS) {
    const rootDir = join(root, componentRoot)
    if (!existsSync(rootDir)) continue
    for (const wrapperYamlPath of findWrapperYamlFiles(rootDir)) {
      try {
        const manifest = parseWrapperCompositionManifest(readFileSync(wrapperYamlPath, 'utf-8'))
        const wrapperDir = join(wrapperYamlPath, '..')
        const componentDir = dirname(wrapperDir)
        const familyParts = relative(rootDir, componentDir).split(/[\\/]/)
        const familyDir =
          familyParts.length >= 2 ? join(rootDir, ...familyParts.slice(0, 2)) : undefined
        const path = relative(root, wrapperYamlPath).split('\\').join('/')
        const packageId = packageByPath?.get(path)
        entries.push({
          manifest,
          wrapperDir,
          componentDir,
          ...(familyDir ? { familyDir } : {}),
          ...(packageId ? { packageId } : {})
        })
      } catch {
        // A malformed wrapper.yaml never blocks discovery of the others.
      }
    }
  }
  return entries
}

function loadCatalog(agentDir: string, projectDir?: string): CachedCatalog {
  const registry = readWrapperTreeRegistry(agentDir)
  const treeRoot = wrapperTreeDir(agentDir)
  const packageByPath = new Map<string, string>()
  const packageEnabled = new Map<string, boolean>()
  const packageSelected = new Set<string>()
  const enablement = getEnablementSnapshot({ agentDir, ...(projectDir ? { projectDir } : {}) })
  const configured = (id: string): boolean | undefined =>
    enablement.project[`wrapper:${id}`] ?? enablement.global[`wrapper:${id}`]
  for (const [id, state] of Object.entries(registry.packages)) {
    // The former startup installer used this registry for every bundled package.
    // Retain its payloads, but require a user choice before exposing them to tools.
    const wasAutomaticallyInstalled = state.source.registry === 'bundled-wrappers'
    const value = configured(id)
    packageEnabled.set(id, value ?? !wasAutomaticallyInstalled)
    if (value !== undefined || !wasAutomaticallyInstalled) packageSelected.add(id)
    for (const path of state.paths) packageByPath.set(path, id)
  }

  const resolvedDependencies = new Set<string>()
  const enableDependencies = (id: string): void => {
    if (resolvedDependencies.has(id) || packageEnabled.get(id) !== true) return
    resolvedDependencies.add(id)
    for (const dependency of registry.packages[id]?.manifest.dependsOn ?? []) {
      if (dependency.type !== 'wrapper' || !registry.packages[dependency.id]) continue
      packageSelected.add(dependency.id)
      // An explicit dependency override always wins over the selected root.
      if (configured(dependency.id) !== false) packageEnabled.set(dependency.id, true)
      enableDependencies(dependency.id)
    }
  }
  for (const id of packageSelected) enableDependencies(id)

  const reasonCache = new Map<string, string | undefined>()
  const unavailableReason = (id: string, visiting = new Set<string>()): string | undefined => {
    if (reasonCache.has(id)) return reasonCache.get(id)
    if (visiting.has(id)) return `依赖出现循环：${id}`
    if (packageEnabled.get(id) === false) {
      const reason = `软件包 ${id} 已停用`
      reasonCache.set(id, reason)
      return reason
    }
    const state = registry.packages[id]
    if (!state) return `依赖的软件包 ${id} 未安装`
    const nextVisiting = new Set(visiting).add(id)
    for (const dependency of state.manifest.dependsOn ?? []) {
      if (dependency.type !== 'wrapper') continue
      const dependencyReason = unavailableReason(dependency.id, nextVisiting)
      if (!dependencyReason) continue
      const reason = `依赖 ${dependency.id} 不可用（${dependencyReason}）`
      reasonCache.set(id, reason)
      return reason
    }
    reasonCache.set(id, undefined)
    return undefined
  }

  const packaged = scanCompositionRoot(treeRoot, packageByPath).map((entry) => {
    if (!entry.packageId) {
      return { ...entry, hiddenReason: 'Wrapper tree path has no package owner.' }
    }
    const hiddenReason = unavailableReason(entry.packageId)
    return {
      ...entry,
      enablementId: entry.packageId,
      ...(hiddenReason ? { hiddenReason } : {})
    }
  })
  const seenIds = new Set(packaged.map((entry) => entry.manifest.id))
  const custom = scanCompositionRoot(customWrappersDir(agentDir))
    .filter((entry) => !seenIds.has(entry.manifest.id))
    .map((entry) => {
      const enablementId = `custom-${createHash('sha256').update(entry.manifest.id).digest('hex').slice(0, 24)}`
      const enabled = configured(enablementId) ?? true
      packageEnabled.set(enablementId, enabled)
      packageSelected.add(enablementId)
      return {
        ...entry,
        enablementId,
        ...(!enabled ? { hiddenReason: `自定义 wrapper ${entry.manifest.name} 已停用` } : {})
      }
    })
  const entries = [...packaged, ...custom].sort((left, right) =>
    left.manifest.id.localeCompare(right.manifest.id)
  )
  return { agentDir, projectDir, entries, packageEnabled, packageSelected }
}

function catalogFor(options: WrapperCompositionDiscoveryOptions = {}): CachedCatalog {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const sourceRoot = options.sourceRoot
  const projectDir = options.projectDir
  // Enable/install IPC runs in the desktop host, while tool discovery also runs
  // in long-lived agent workers. Observe persisted changes in both processes.
  const revision = sourceRoot ? undefined : catalogRevision(agentDir)
  if (
    !cachedCatalog ||
    cachedCatalog.agentDir !== agentDir ||
    cachedCatalog.sourceRoot !== sourceRoot ||
    cachedCatalog.projectDir !== projectDir ||
    cachedCatalog.revision !== revision
  ) {
    cachedCatalog = sourceRoot
      ? {
          agentDir,
          sourceRoot,
          projectDir,
          entries: scanCompositionRoot(sourceRoot).sort((left, right) =>
            left.manifest.id.localeCompare(right.manifest.id)
          ),
          packageEnabled: new Map(),
          packageSelected: new Set()
        }
      : loadCatalog(agentDir, projectDir)
    cachedCatalog.revision = revision
  }
  return cachedCatalog
}

/** Only available wrappers are exposed to generic agent tools. */
export function listWrapperCompositionCatalog(
  options: WrapperCompositionDiscoveryOptions = {}
): WrapperCompositionEntry[] {
  return catalogFor(options).entries.filter((entry) => !entry.hiddenReason)
}

/** Includes disabled wrappers so the renderer can explain and change package enablement. */
export function listWrapperCompositionCatalogStatus(
  options: WrapperCompositionDiscoveryOptions = {}
): WrapperCompositionCatalogItem[] {
  const catalog = catalogFor(options)
  return catalog.entries.map((entry) => {
    const icon = findResourceIcon(entry.wrapperDir, [
      entry.componentDir,
      ...(entry.familyDir ? [entry.familyDir] : [])
    ])
    return {
      ...entry.manifest,
      ...(icon ? { icon } : {}),
      ...(entry.packageId ? { packageId: entry.packageId } : {}),
      ...(entry.enablementId
        ? {
            enablementId: entry.enablementId,
            packageSelected: catalog.packageSelected.has(entry.enablementId),
            packageEnabled: catalog.packageEnabled.get(entry.enablementId) !== false
          }
        : {}),
      ...(entry.hiddenReason ? { hiddenReason: entry.hiddenReason } : {})
    }
  })
}

/** A wrapper's `params.json` (the defaults every run starts from); {} when missing or unreadable. */
export function readWrapperDefaultParams(wrapperDir: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(wrapperDir, 'params.json'), 'utf-8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export function findWrapperCompositionEntry(
  id: string,
  options: WrapperCompositionDiscoveryOptions = {}
): WrapperCompositionEntry | undefined {
  return listWrapperCompositionCatalog(options).find((entry) => entry.manifest.id === id)
}

const DAG_FILE = 'dag.mmd'

/**
 * Reads the pre-generated Mermaid DAG next to a wrapper's own `wrapper.yaml`,
 * when one exists — see `scripts/generate-wrapper-dags.mjs` for how it's
 * produced (Nextflow's own `-preview -with-dag`, not hand-authored or
 * derived from the composition manifest, which has no step/DAG concept at
 * all). Returns `undefined` for a wrapper that predates that script or
 * whose generation failed; callers fall back to a generic structure view.
 */
export function readWrapperCompositionDag(
  id: string,
  options: WrapperCompositionDiscoveryOptions = {}
): string | undefined {
  const entry = findWrapperCompositionEntry(id, options)
  if (!entry) return undefined
  const dagPath = join(entry.wrapperDir, DAG_FILE)
  if (!existsSync(dagPath)) return undefined
  try {
    return readFileSync(dagPath, 'utf-8')
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length > 0 ? strings : undefined
}

/**
 * `meta.yml`'s `tools` field is a YAML list of single-key maps, e.g.
 * `[{fastqc: {description, homepage, licence, ...}}]` — one entry per tool
 * the module wraps (almost always exactly one).
 */
function parseTools(value: unknown): WrapperModuleTool[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tools: WrapperModuleTool[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const [name, info] = Object.entries(item)[0] ?? []
    if (typeof name !== 'string' || !isRecord(info)) continue
    tools.push({
      name,
      description: typeof info.description === 'string' ? info.description.trim() : undefined,
      homepage: typeof info.homepage === 'string' ? info.homepage : undefined,
      documentation: typeof info.documentation === 'string' ? info.documentation : undefined,
      licence: asStringArray(info.licence),
      doi: typeof info.doi === 'string' ? info.doi : undefined,
      identifier:
        typeof info.identifier === 'string' && info.identifier ? info.identifier : undefined
    })
  }
  return tools.length > 0 ? tools : undefined
}

function parseModuleMeta(yamlText: string): WrapperModuleMeta | undefined {
  const doc: unknown = parseYaml(yamlText)
  if (!isRecord(doc)) return undefined
  return {
    description: typeof doc.description === 'string' ? doc.description : undefined,
    keywords: asStringArray(doc.keywords),
    tools: parseTools(doc.tools),
    authors: asStringArray(doc.authors)
  }
}

/**
 * Reads the curated subset of a wrapper's own `meta.yml`/`environment.yml`
 * — real nf-core module metadata that sits beside `main.nf`, never
 * duplicated into `wrapper.yaml` (see `wrapperModuleDetailsTypes.ts`'s own
 * header comment). For a composed wrapper (one `main.nf` that chains
 * several modules — e.g. `bowtie2-align` also runs `bowtie2/build`
 * internally), this reads only the wrapper's own `componentDir`, i.e. the
 * primary/final module's metadata, not every module it composes — the same
 * scoping `wrapper.yaml`'s own `name`/`summary` already use. Returns
 * `undefined` fields (not an error) when a file is missing, malformed, or
 * doesn't exist at all — full pipelines (`workflows/` tier) have neither.
 */
export function readWrapperModuleDetails(
  id: string,
  options: WrapperCompositionDiscoveryOptions = {}
): WrapperModuleDetails | undefined {
  const entry = findWrapperCompositionEntry(id, options)
  if (!entry) return undefined

  const metaPath = join(entry.componentDir, 'meta.yml')
  const environmentPath = join(entry.componentDir, 'environment.yml')

  let meta: WrapperModuleMeta | undefined
  if (existsSync(metaPath)) {
    try {
      meta = parseModuleMeta(readFileSync(metaPath, 'utf-8'))
    } catch {
      meta = undefined
    }
  }

  let environment: string | undefined
  if (existsSync(environmentPath)) {
    try {
      environment = readFileSync(environmentPath, 'utf-8')
    } catch {
      environment = undefined
    }
  }

  if (!meta && !environment) return undefined
  return { meta, environment }
}

export function resetWrapperCompositionCatalogCache(): void {
  cachedCatalog = undefined
}
