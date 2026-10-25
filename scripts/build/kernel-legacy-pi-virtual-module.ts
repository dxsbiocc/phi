import * as path from 'node:path'

import {
  __renderLegacyPiVirtualModule,
  type BundledPiEntry
} from '../../node_modules/@oh-my-pi/pi-coding-agent/scripts/legacy-pi-virtual-module'

export const LEGACY_PI_MODULES_SPECIFIER = 'omp-legacy-pi-modules'

const VIRTUAL_NAMESPACE = 'phi-legacy-pi-modules-build'
const repoRoot = path.resolve(import.meta.dir, '../..')
const nodeModulesRoot = path.join(repoRoot, 'node_modules', '@oh-my-pi')
const codingAgentRoot = path.join(nodeModulesRoot, 'pi-coding-agent')

type InstalledPackage = {
  readonly directory: string
  readonly identifier: string
  readonly rootShim: string | null
}

const INSTALLED_PACKAGES: readonly InstalledPackage[] = [
  { directory: 'pi-agent-core', identifier: 'PiAgentCore', rootShim: null },
  { directory: 'pi-ai', identifier: 'PiAi', rootShim: 'legacy-pi-ai-shim.ts' },
  { directory: 'pi-catalog', identifier: 'PiCatalog', rootShim: null },
  {
    directory: 'pi-coding-agent',
    identifier: 'PiCodingAgent',
    rootShim: 'legacy-pi-coding-agent-shim.ts'
  },
  { directory: 'pi-natives', identifier: 'PiNatives', rootShim: null },
  { directory: 'pi-tui', identifier: 'PiTui', rootShim: 'legacy-pi-tui-shim.ts' },
  { directory: 'pi-utils', identifier: 'PiUtils', rootShim: null }
]

const TYPEBOX_MODULE_KEY = 'typebox'
const TYPEBOX_COMPAT_MODULE = 'legacy-typebox.ts'
const SKIPPED_WILDCARD_BASENAMES = new Set(['index'])
const MAIN_THREAD_UNSAFE_WILDCARD_BASENAMES = new Set(['worker-entry'])

type PackageManifest = {
  name?: unknown
  exports?: unknown
}

type WildcardPattern = {
  exportPrefix: string
  exportSuffix: string
  sourcePrefix: string
  sourceSuffix: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bindingForSubpath(identifier: string, subpath: string): string {
  const suffix = subpath
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('')
    )
    .join('')
  return `bundled${identifier}${suffix}`
}

function isSafeWildcardBasename(basename: string): boolean {
  if (!basename || basename.startsWith('.') || basename.startsWith('_')) return false
  if (SKIPPED_WILDCARD_BASENAMES.has(basename)) return false
  if (MAIN_THREAD_UNSAFE_WILDCARD_BASENAMES.has(basename)) return false
  return !/\.(test|spec|d|d\.json|generated|bench)$/.test(basename)
}

function parseWildcardPattern(exportKey: string, sourcePattern: string): WildcardPattern | null {
  const exportStar = exportKey.indexOf('*')
  const sourceStar = sourcePattern.indexOf('*')
  if (exportStar === -1 || sourceStar === -1) return null
  if (exportKey.indexOf('*', exportStar + 1) !== -1) return null
  if (sourcePattern.indexOf('*', sourceStar + 1) !== -1) return null
  if (!sourcePattern.startsWith('./')) return null
  return {
    exportPrefix: exportKey.slice(2, exportStar),
    exportSuffix: exportKey.slice(exportStar + 1),
    sourcePrefix: sourcePattern.slice(2, sourceStar),
    sourceSuffix: sourcePattern.slice(sourceStar + 1)
  }
}

function exportImportTarget(value: unknown): string | null {
  if (typeof value === 'string') return value
  return isRecord(value) && typeof value.import === 'string' ? value.import : null
}

function shimSpecifier(file: string): string {
  return path.join(codingAgentRoot, 'src', 'extensibility', file)
}

function isMissingDirectory(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

/**
 * OMP exports its renderer, but its collector assumes an OMP monorepo with
 * packages under `packages/*`. Phi installs the same packages under
 * `node_modules/@oh-my-pi/pi-*`, so only the layout-sensitive collection is
 * adapted here; the generated loader table still uses OMP's own renderer.
 */
export async function collectInstalledBundledPiEntries(): Promise<BundledPiEntry[]> {
  const entries: BundledPiEntry[] = []
  const seenKeys = new Set<string>()
  const seenBindings = new Set<string>()

  const addEntry = (key: string, binding: string, importSpecifier: string): void => {
    if (seenKeys.has(key)) return
    if (seenBindings.has(binding)) {
      throw new Error(`Duplicate bundled Pi binding ${binding} for ${key}`)
    }
    seenKeys.add(key)
    seenBindings.add(binding)
    entries.push({ key, binding, importSpecifier })
  }

  for (const pkg of INSTALLED_PACKAGES) {
    const packageRoot = path.join(nodeModulesRoot, pkg.directory)
    const manifestPath = path.join(packageRoot, 'package.json')
    const manifest = (await Bun.file(manifestPath).json()) as PackageManifest
    if (typeof manifest.name !== 'string' || !manifest.name) {
      throw new Error(`Bundled Pi package manifest has no name: ${manifestPath}`)
    }
    const exportsField = isRecord(manifest.exports) ? manifest.exports : {}
    addEntry(
      manifest.name,
      `bundled${pkg.identifier}`,
      pkg.rootShim ? shimSpecifier(pkg.rootShim) : manifest.name
    )

    for (const exportKey in exportsField) {
      if (!exportKey.startsWith('./') || exportKey === '.' || exportKey.includes('*')) continue
      const subpath = exportKey.slice(2)
      const key = `${manifest.name}/${subpath}`
      addEntry(key, bindingForSubpath(pkg.identifier, subpath), key)
    }

    for (const exportKey in exportsField) {
      if (!exportKey.startsWith('./') || exportKey === '.' || !exportKey.includes('*')) continue
      const sourcePattern = exportImportTarget(exportsField[exportKey])
      if (!sourcePattern) continue
      const pattern = parseWildcardPattern(exportKey, sourcePattern)
      if (!pattern || !/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(pattern.sourceSuffix)) continue
      const catalogRootWildcard = pkg.directory === 'pi-catalog' && exportKey === './*'
      if ((pattern.exportPrefix === '' || pattern.exportPrefix === '/') && !catalogRootWildcard) {
        continue
      }

      const sourceDir = path.join(packageRoot, pattern.sourcePrefix)
      try {
        const matches: string[] = []
        const glob = new Bun.Glob(`**/*${pattern.sourceSuffix}`)
        for await (const match of glob.scan({ cwd: sourceDir, onlyFiles: true })) {
          matches.push(match.split(path.sep).join('/'))
        }
        matches.sort()
        for (const match of matches) {
          if (!match.endsWith(pattern.sourceSuffix)) continue
          if (catalogRootWildcard && match.includes('/')) continue
          const basename = match.slice(0, match.length - pattern.sourceSuffix.length)
          const segments = basename.split('/')
          if (segments.some((segment) => segment.startsWith('.') || segment.startsWith('_'))) {
            continue
          }
          if (!isSafeWildcardBasename(segments.at(-1) ?? '')) continue
          const subpath = `${pattern.exportPrefix}${basename}${pattern.exportSuffix}`
          const key = `${manifest.name}/${subpath}`
          addEntry(key, bindingForSubpath(pkg.identifier, subpath), key)
        }
      } catch (error) {
        if (!isMissingDirectory(error)) throw error
      }
    }
  }

  addEntry(TYPEBOX_MODULE_KEY, 'bundledTypeBoxShim', shimSpecifier(TYPEBOX_COMPAT_MODULE))
  return entries
}

export async function renderLegacyPiVirtualModule(): Promise<string> {
  return __renderLegacyPiVirtualModule(await collectInstalledBundledPiEntries())
}

export async function createPhiLegacyPiVirtualModulePlugin(): Promise<Bun.BunPlugin> {
  const source = await renderLegacyPiVirtualModule()
  return {
    name: 'phi:legacy-pi-modules',
    setup(build) {
      build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({
        path: LEGACY_PI_MODULES_SPECIFIER,
        namespace: VIRTUAL_NAMESPACE
      }))
      build.onLoad({ filter: /.*/, namespace: VIRTUAL_NAMESPACE }, () => ({
        contents: source,
        loader: 'ts'
      }))
    }
  }
}
