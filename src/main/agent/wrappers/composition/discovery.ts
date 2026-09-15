import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { getBundledWrapperPackagesDir } from '../catalog'
import { parseWrapperCompositionManifest, type WrapperCompositionManifest } from './manifest'

/**
 * Discovery for the agent-composition wrapper layout — see
 * docs/design/phi-wrapper-agent-composition-design.md section 4: scan only
 * `modules/**\/wrapper/wrapper.yaml` and `subworkflows/**\/wrapper/wrapper.yaml`
 * under the same bundled-resources root the package-level catalog already
 * uses (`resources/wrappers/`, packaging-aware via `getBundledWrapperPackagesDir`).
 */

export interface WrapperCompositionEntry {
  manifest: WrapperCompositionManifest
  /** The `wrapper/` adapter directory — where main.nf/params.json/wrapper.yaml live. */
  wrapperDir: string
  /** The module/subworkflow's own root directory (wrapperDir's parent). */
  componentDir: string
}

const COMPONENT_ROOTS = ['modules', 'subworkflows']
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

function loadCatalog(): WrapperCompositionEntry[] {
  const bundledRoot = getBundledWrapperPackagesDir()
  const entries: WrapperCompositionEntry[] = []

  for (const componentRoot of COMPONENT_ROOTS) {
    const rootDir = join(bundledRoot, componentRoot)
    if (!existsSync(rootDir)) continue

    for (const wrapperYamlPath of findWrapperYamlFiles(rootDir)) {
      try {
        const manifest = parseWrapperCompositionManifest(readFileSync(wrapperYamlPath, 'utf-8'))
        const wrapperDir = join(wrapperYamlPath, '..')
        entries.push({ manifest, wrapperDir, componentDir: join(wrapperDir, '..') })
      } catch {
        // A malformed wrapper.yaml never blocks discovery of the others.
      }
    }
  }

  return entries
}

/** Cached after first call — call `resetWrapperCompositionCatalogCache()` in tests. */
export function listWrapperCompositionCatalog(): WrapperCompositionEntry[] {
  if (!cachedCatalog) {
    cachedCatalog = loadCatalog()
  }
  return cachedCatalog
}

export function findWrapperCompositionEntry(id: string): WrapperCompositionEntry | undefined {
  return listWrapperCompositionCatalog().find((entry) => entry.manifest.id === id)
}

export function resetWrapperCompositionCatalogCache(): void {
  cachedCatalog = undefined
}
