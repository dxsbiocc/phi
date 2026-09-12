import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKSPACE_DIR } from './session/sessions'
import {
  installRuntimePlugin,
  listRuntimePlugins,
  removeRuntimePlugin
} from './runtime/runtime-adapter'

export const PLUGIN_CATALOG_URL = 'https://pi.dev/packages'

export type PluginKind = 'extension' | 'skill' | 'prompt' | 'theme' | 'package'

export interface PluginCatalogItem {
  id: string
  name: string
  source: string
  description: string
  author?: string
  kind: PluginKind
  downloads?: string
  updated?: string
  homepageUrl: string
  npmUrl: string
  installed: boolean
  installedPath?: string
}

type ConfiguredPackage = {
  source: string
  scope: 'user' | 'project'
  filtered: boolean
  installedPath?: string
}

type RuntimePlugin = Awaited<ReturnType<typeof listRuntimePlugins>>[number]

function sourceToName(source: string): string {
  return source.replace(/^npm:/, '').replace(/^git:/, '').trim()
}

function nameToSource(name: string): string {
  const trimmed = name.trim()
  return trimmed.startsWith('npm:') || trimmed.startsWith('git:') ? trimmed : `npm:${trimmed}`
}

function isNpmPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(value)
}

export function isRuntimeSupportedPluginSource(source: string): boolean {
  const trimmed = source.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('git:')) return trimmed.length > 'git:'.length
  const npmName = trimmed.startsWith('npm:') ? trimmed.slice('npm:'.length).trim() : trimmed
  return isNpmPackageName(npmName)
}

function assertRuntimeSupportedPluginSource(source: string): void {
  if (!isRuntimeSupportedPluginSource(source)) {
    throw new Error('插件源格式不受支持。请使用 npm 包名、npm: 包名或 runtime 支持的 git: 源。')
  }
}

function normalizeSource(source: string): string {
  return nameToSource(source).toLowerCase()
}

function sourceMatches(left: string, right: string): boolean {
  return normalizeSource(left) === normalizeSource(right)
}

function runtimePluginToConfigured(plugin: RuntimePlugin): ConfiguredPackage {
  return {
    source: nameToSource(plugin.name),
    scope: 'user',
    filtered: plugin.enabled === false,
    installedPath: plugin.path
  }
}

function packagePageUrl(name: string): string {
  return `${PLUGIN_CATALOG_URL}/${name.split('/').map(encodeURIComponent).join('/')}`
}

function configuredToCatalogItem(item: ConfiguredPackage): PluginCatalogItem {
  const name = sourceToName(item.source)
  return {
    id: name,
    name,
    source: nameToSource(item.source),
    description: item.filtered
      ? 'Installed with a resource filter from Pi settings.'
      : 'Installed from the Pi package manager.',
    kind: 'package',
    homepageUrl: packagePageUrl(name),
    npmUrl: `https://www.npmjs.com/package/${name}`,
    installed: true,
    installedPath: item.installedPath
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]*>/g, '')
    .trim()
}

function readPackageDescription(installedPath: string | undefined): string | undefined {
  if (!installedPath) return undefined
  const packageJsonPath = join(installedPath, 'package.json')
  if (!existsSync(packageJsonPath)) return undefined

  try {
    const raw = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { description?: unknown }
    return typeof raw.description === 'string' ? raw.description : undefined
  } catch {
    return undefined
  }
}

function parseCatalogHtml(
  html: string
): Array<Omit<PluginCatalogItem, 'installed' | 'installedPath'>> {
  const cards = html.match(/<article\b[\s\S]*?<\/article>/g) ?? []
  return cards
    .map<Omit<PluginCatalogItem, 'installed' | 'installedPath'> | null>((card) => {
      const name = card.match(/data-package-name="([^"]+)"/)?.[1]
      if (!name) return null

      const description = decodeHtml(
        card.match(/<p class="packages-desc">([\s\S]*?)<\/p>/)?.[1] ?? ''
      )
      const meta = [...card.matchAll(/<div class="packages-meta">([\s\S]*?)<\/div>/g)][0]?.[1] ?? ''
      const metaValues = [...meta.matchAll(/<span>([\s\S]*?)<\/span>/g)].map((match) =>
        decodeHtml(match[1])
      )
      const types = card.match(/data-package-types="([^"]*)"/)?.[1] ?? ''
      const kind = (types.split(/\s+/).find(Boolean) ?? 'package') as PluginKind

      return {
        id: decodeHtml(name),
        name: decodeHtml(name),
        source: `npm:${decodeHtml(name)}`,
        description,
        author: metaValues[0],
        downloads: metaValues[1],
        updated: metaValues[2],
        kind,
        homepageUrl: packagePageUrl(decodeHtml(name)),
        npmUrl: `https://www.npmjs.com/package/${decodeHtml(name)}`
      }
    })
    .filter((item): item is Omit<PluginCatalogItem, 'installed' | 'installedPath'> => item !== null)
}

function mergeInstalledState(
  catalog: Array<Omit<PluginCatalogItem, 'installed' | 'installedPath'>>,
  configured: ConfiguredPackage[]
): PluginCatalogItem[] {
  const installedBySource = new Map(
    configured.map((item) => [normalizeSource(item.source), configuredToCatalogItem(item)])
  )
  const merged = catalog.map((item) => {
    const installed = installedBySource.get(normalizeSource(item.source))
    return {
      ...item,
      description:
        readPackageDescription(installed?.installedPath) ??
        item.description ??
        installed?.description ??
        '',
      installed: Boolean(installed),
      installedPath: installed?.installedPath
    }
  })

  const catalogSources = new Set(merged.map((item) => normalizeSource(item.source)))
  const configuredOnly = configured
    .filter((item) => !catalogSources.has(normalizeSource(item.source)))
    .map(configuredToCatalogItem)
  return [...merged, ...configuredOnly]
}

export async function listPlugins(): Promise<PluginCatalogItem[]> {
  const runtimePlugins = await listRuntimePlugins(WORKSPACE_DIR)
  const configured = runtimePlugins.map(runtimePluginToConfigured)

  let catalog: Array<Omit<PluginCatalogItem, 'installed' | 'installedPath'>> = []
  try {
    const response = await fetch(PLUGIN_CATALOG_URL)
    if (response.ok) {
      const parsed = parseCatalogHtml(await response.text())
      if (parsed.length > 0) {
        catalog = parsed.filter(
          (item, index, items) =>
            items.findIndex((candidate) => sourceMatches(candidate.source, item.source)) === index
        )
      }
    }
  } catch (error) {
    console.warn('Failed to fetch Pi package catalog:', error)
  }

  return mergeInstalledState(catalog, configured).sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export async function installPlugin(source: string): Promise<PluginCatalogItem[]> {
  assertRuntimeSupportedPluginSource(source)
  await installRuntimePlugin(WORKSPACE_DIR, nameToSource(source))
  return listPlugins()
}

export async function removePlugin(source: string): Promise<PluginCatalogItem[]> {
  assertRuntimeSupportedPluginSource(source)
  await removeRuntimePlugin(WORKSPACE_DIR, nameToSource(source))
  return listPlugins()
}
