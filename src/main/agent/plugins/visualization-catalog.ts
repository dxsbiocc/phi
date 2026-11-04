import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { parse as parseYaml } from 'yaml'

import {
  templatePreviewFile,
  type VisualizationTemplate,
  type VisualizationTemplateCatalog,
  type VisualizationTemplateGroup
} from '../../../shared/visualizationTemplateTypes'
import { listInstalledPlugins, type PluginLoaderOptions } from './loader'

const EMPTY_CATALOG: VisualizationTemplateCatalog = { groups: [] }
const GROUP_ID = /^[a-z][a-z0-9_-]{0,63}$/
const TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/
const TITLE_MAX = 200
const ALIAS_MAX = 80
const ALIAS_LIMIT = 40

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0 || text.length > max) return null
  return text
}

function aliasesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const aliases: string[] = []
  for (const item of value) {
    const alias = boundedText(item, ALIAS_MAX)
    if (!alias || aliases.includes(alias)) continue
    aliases.push(alias)
    if (aliases.length >= ALIAS_LIMIT) break
  }
  return aliases
}

/** Resolve a catalog-relative path and reject anything that leaves the skill root. */
function resolveInside(skillRoot: string, relativePath: string): string | null {
  if (
    relativePath.trim() !== relativePath ||
    isAbsolute(relativePath) ||
    relativePath.includes('\\')
  ) {
    return null
  }
  const parts = relativePath.split('/')
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
    return null
  }
  let realPath: string
  try {
    realPath = realpathSync(resolve(skillRoot, relativePath))
  } catch {
    return null
  }
  const fromRoot = relative(skillRoot, realPath)
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) return null
  return realPath
}

function acceptedPreview(skillRoot: string, groupId: string, preview: string): string | null {
  const realPath = resolveInside(skillRoot, preview)
  if (!realPath) return null
  const parts = relative(skillRoot, realPath).split(sep)
  if (
    parts.length !== 4 ||
    parts[0] !== 'scripts' ||
    parts[1] !== groupId ||
    parts[3] !== 'preview.png' ||
    parts.includes('..')
  ) {
    return null
  }
  return realPath
}

const VARIANT_LIMIT = 24

function variantTitle(title: string, variant: string): string {
  return `${title} · ${variant.replace(/[_-]+/g, ' ')}`
}

/** Other drawings shipped next to the catalog `preview.png`. */
function variantTemplates(
  skillRoot: string,
  groupId: string,
  template: VisualizationTemplate
): VisualizationTemplate[] {
  const folder = basename(dirname(template.previewPath))
  let names: string[]
  try {
    names = readdirSync(dirname(template.previewPath))
  } catch {
    return [template]
  }
  const extras: VisualizationTemplate[] = []
  for (const name of names.sort((left, right) => left.localeCompare(right, 'en'))) {
    if (extras.length >= VARIANT_LIMIT) break
    const parsed = templatePreviewFile(name)
    if (!parsed?.variant) continue
    const previewPath = acceptedVariant(skillRoot, groupId, folder, name)
    if (!previewPath || previewPath === template.previewPath) continue
    extras.push({
      id: template.id,
      title: variantTitle(template.title, parsed.variant),
      aliases: template.aliases,
      previewPath,
      variant: parsed.variant
    })
  }
  return [template, ...extras]
}

function acceptedVariant(
  skillRoot: string,
  groupId: string,
  folder: string,
  name: string
): string | null {
  const realPath = resolveInside(skillRoot, `scripts/${groupId}/${folder}/${name}`)
  if (!realPath) return null
  try {
    if (!statSync(realPath).isFile()) return null
  } catch {
    return null
  }
  const parts = relative(skillRoot, realPath).split(sep)
  if (
    parts.length !== 4 ||
    parts[0] !== 'scripts' ||
    parts[1] !== groupId ||
    parts[2] !== folder ||
    parts[3] !== name
  ) {
    return null
  }
  return realPath
}

function readTemplates(
  skillRoot: string,
  groupId: string,
  catalogPath: string
): VisualizationTemplate[] {
  let document: unknown
  try {
    document = parseYaml(readFileSync(catalogPath, 'utf8'))
  } catch {
    return []
  }
  if (!isRecord(document) || !Array.isArray(document.templates)) return []

  const templates: VisualizationTemplate[] = []
  const seen = new Set<string>()
  for (const raw of document.templates) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.preview !== 'string') continue
    const id = raw.id.trim()
    const title = boundedText(raw.title, TITLE_MAX)
    if (!TEMPLATE_ID.test(id) || seen.has(id) || !title) continue
    const previewPath = acceptedPreview(skillRoot, groupId, raw.preview)
    if (!previewPath) continue
    seen.add(id)
    templates.push(
      ...variantTemplates(skillRoot, groupId, {
        id,
        title,
        aliases: aliasesOf(raw.aliases),
        previewPath
      })
    )
  }
  return templates
}

/**
 * Read `references/plots.yaml` and each family's catalog. Groups and templates
 * keep catalog order. Each template keeps its `preview.png`, then any
 * `preview_<name>.png` siblings, so other supported drawings are visible.
 * Anything outside `scripts/<group>/<template>/` is dropped.
 */
export function readVisualizationTemplateCatalog(skillDir: string): VisualizationTemplateCatalog {
  let skillRoot: string
  try {
    skillRoot = realpathSync(skillDir)
  } catch {
    return EMPTY_CATALOG
  }

  let document: unknown
  try {
    document = parseYaml(readFileSync(resolve(skillRoot, 'references', 'plots.yaml'), 'utf8'))
  } catch {
    return EMPTY_CATALOG
  }
  if (!isRecord(document) || !isRecord(document.groups)) return EMPTY_CATALOG

  const groups: VisualizationTemplateGroup[] = []
  for (const [groupId, rawGroup] of Object.entries(document.groups)) {
    if (!GROUP_ID.test(groupId) || !isRecord(rawGroup) || typeof rawGroup.catalog !== 'string') {
      continue
    }
    const title = boundedText(rawGroup.title, TITLE_MAX)
    const catalogPath = title ? resolveInside(skillRoot, rawGroup.catalog) : null
    if (!title || !catalogPath) continue
    const templates = readTemplates(skillRoot, groupId, catalogPath)
    if (templates.length === 0) continue
    groups.push({ id: groupId, title, templates })
  }
  return { groups }
}

/** Catalog for the installed visualization plugin, including when that plugin is disabled. */
export function visualizationTemplateCatalog(
  options: PluginLoaderOptions = {}
): VisualizationTemplateCatalog {
  const plugin = listInstalledPlugins(options).find((item) => item.id === 'visualization')
  const skill = plugin?.skills.find((item) => item.name === 'omics-visualization')
  if (!skill) return EMPTY_CATALOG
  return readVisualizationTemplateCatalog(skill.dir)
}
