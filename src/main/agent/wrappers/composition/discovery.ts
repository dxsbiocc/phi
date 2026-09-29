import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { parseWrapperCompositionManifest, type WrapperCompositionManifest } from './manifest'
import {
  resolveActiveWrapperPack,
  type ActiveWrapperPack,
  type WrapperPackResolution
} from './packs'
import type {
  WrapperModuleDetails,
  WrapperModuleMeta,
  WrapperModuleTool
} from '../../../../shared/wrapperModuleDetailsTypes'

/**
 * Discovery for the agent-composition wrapper layout — see
 * docs/design/phi-wrapper-agent-composition-design.md section 4: scan
 * `modules/**\/wrapper/wrapper.yaml` and `subworkflows/**\/wrapper/wrapper.yaml`
 * under the active wrapper pack root — the bundled `resources/wrappers/`
 * (packaging-aware via `getBundledWrapperPackagesDir`) unless a verified newer
 * overlay pack replaces it (see `packs.ts`).
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
  /** The pack this entry was discovered in; absent only on hand-built test entries. */
  pack?: ActiveWrapperPack
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

let cachedCatalog: WrapperCompositionEntry[] | undefined
let cachedPackResolution: WrapperPackResolution | undefined

/**
 * The wrapper pack discovery reads from — the bundled pack, or a verified
 * newer overlay pack (see `packs.ts`). Cached with the catalog; call
 * `resetWrapperCompositionCatalogCache()` to re-resolve.
 */
export function getWrapperPackResolution(): WrapperPackResolution {
  if (!cachedPackResolution) {
    cachedPackResolution = resolveActiveWrapperPack()
  }
  return cachedPackResolution
}

export function getActiveWrapperPack(): ActiveWrapperPack {
  return getWrapperPackResolution().active
}

function loadCatalog(): WrapperCompositionEntry[] {
  const pack = getActiveWrapperPack()
  const entries: WrapperCompositionEntry[] = []

  for (const componentRoot of COMPONENT_ROOTS) {
    const rootDir = join(pack.root, componentRoot)
    if (!existsSync(rootDir)) continue

    for (const wrapperYamlPath of findWrapperYamlFiles(rootDir)) {
      try {
        const manifest = parseWrapperCompositionManifest(readFileSync(wrapperYamlPath, 'utf-8'))
        const wrapperDir = join(wrapperYamlPath, '..')
        entries.push({ manifest, wrapperDir, componentDir: join(wrapperDir, '..'), pack })
      } catch {
        // A malformed wrapper.yaml never blocks discovery of the others.
      }
    }
  }

  // readdirSync order is filesystem-dependent, not alphabetical — sort by id
  // so entries from the same tool family (`bowtie2-align`/`bowtie2-build`,
  // `samtools-*`, ...) land next to each other in the UI's flat per-tier
  // list, since the id convention already hyphenates the family prefix in.
  entries.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))

  return entries
}

/** Cached after first call — call `resetWrapperCompositionCatalogCache()` in tests. */
export function listWrapperCompositionCatalog(): WrapperCompositionEntry[] {
  if (!cachedCatalog) {
    cachedCatalog = loadCatalog()
  }
  return cachedCatalog
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

export function findWrapperCompositionEntry(id: string): WrapperCompositionEntry | undefined {
  return listWrapperCompositionCatalog().find((entry) => entry.manifest.id === id)
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
export function readWrapperCompositionDag(id: string): string | undefined {
  const entry = findWrapperCompositionEntry(id)
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
export function readWrapperModuleDetails(id: string): WrapperModuleDetails | undefined {
  const entry = findWrapperCompositionEntry(id)
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
  cachedPackResolution = undefined
}
