import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'

import { parse as parseYaml } from 'yaml'

import type {
  PhiPluginDependency,
  PhiPluginDependencyManifest
} from '../../../shared/phiPluginDetailTypes'
import { isRecord } from '../../../shared/guards'
import { parseEnvironmentRef } from '../envs'

const ROOT_MANIFESTS = [
  'environment.yml',
  'environment.yaml',
  'renv.lock',
  'package.json',
  'DESCRIPTION',
  'conda-lock.yml'
] as const
const MAX_MANIFEST_BYTES = 512 * 1024
const MAX_DEPENDENCIES = 2_048
const MAX_YAML_TEXT = 64 * 1024

export interface PhiPluginDependencyManifestInput {
  pluginDir: string
  environmentRef: string
  explicitManifest?: string
  bundledEnvironmentsDir: string
}

export interface PhiPluginDependencyManifestRead {
  channels: string[]
  dependencyManifest: PhiPluginDependencyManifest
}

interface ParsedManifest {
  dependencies: PhiPluginDependency[]
  channels: string[]
  yamlText?: string
}

function bounded(value: string, limit = 4_096): string {
  return value.replace(/\0/g, '').slice(0, limit)
}

function normalized(path: string): string {
  return path.split(sep).join('/')
}

function inside(root: string, path: string): string | undefined {
  const rel = relative(resolve(root), resolve(path))
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) ? normalized(rel) : undefined
}

function displayPath(path: string, pluginDir: string, environmentsDir: string): string {
  const pluginRelative = inside(pluginDir, path)
  if (pluginRelative) return pluginRelative
  const environmentRelative = inside(environmentsDir, path)
  if (environmentRelative) {
    return `resources/runtime/environments/${environmentRelative}`
  }
  return basename(path)
}

function environmentDirectoryName(ref: string): string {
  const parsed = parseEnvironmentRef(ref)
  if (parsed.kind === 'phi') return `phi-${parsed.name.replace(/_/g, '-')}`
  if (parsed.kind === 'plugin' || parsed.kind === 'project') return parsed.name.replace(/_/g, '-')
  return 'phi-r'
}

function candidates(input: PhiPluginDependencyManifestInput): string[] {
  const paths = ROOT_MANIFESTS.map((name) => resolve(input.pluginDir, name))
  if (input.explicitManifest) paths.unshift(resolve(input.explicitManifest))
  const environmentDir = resolve(
    input.bundledEnvironmentsDir,
    environmentDirectoryName(input.environmentRef)
  )
  paths.push(
    resolve(environmentDir, 'environment.yml'),
    resolve(environmentDir, 'environment.yaml')
  )
  return [...new Set(paths)]
}

function readBoundedText(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function packageEntry(rawValue: string, kind: 'conda' | 'pip'): PhiPluginDependency | undefined {
  const raw = rawValue.split('#')[0].trim()
  if (!raw) return undefined
  const match = raw.match(/^([^=<>!~\s]+)[=<>!~]*(.*)$/)
  if (!match) return { name: bounded(raw, 128), kind }
  return {
    name: bounded(match[1].replace(/^.*::/, ''), 128),
    ...(match[2] ? { version: bounded(match[2], 128) } : {}),
    kind
  }
}

function packageEntries(value: unknown, kind: 'conda' | 'pip'): PhiPluginDependency[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'string') return []
    const parsed = packageEntry(entry, kind)
    return parsed ? [parsed] : []
  })
}

function environmentDependencies(value: unknown): PhiPluginDependency[] {
  if (!Array.isArray(value)) return []
  const dependencies: PhiPluginDependency[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const parsed = packageEntry(entry, 'conda')
      if (parsed) dependencies.push(parsed)
      continue
    }
    if (!isRecord(entry)) continue
    if (typeof entry.conda === 'string') {
      const parsed = packageEntry(entry.conda, 'conda')
      if (parsed) dependencies.push(parsed)
    }
    dependencies.push(...packageEntries(entry.pip, 'pip'))
  }
  return dependencies
}

function sourceDependencies(value: unknown): PhiPluginDependency[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string') return []
    const version = typeof entry.ref === 'string' ? bounded(entry.ref, 128) : undefined
    const note =
      typeof entry.repo === 'string'
        ? `github:${bounded(entry.repo, 256)}`
        : typeof entry.source === 'string'
          ? bounded(entry.source, 256)
          : 'source'
    return [
      {
        name: bounded(entry.name, 128),
        ...(version ? { version } : {}),
        kind: 'source' as const,
        note
      }
    ]
  })
}

function parseEnvironmentYaml(text: string): ParsedManifest | undefined {
  let document: unknown
  try {
    document = parseYaml(text)
  } catch {
    return undefined
  }
  if (!isRecord(document)) return undefined
  const channels = Array.isArray(document.channels)
    ? document.channels
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 256)
        .map((entry) => bounded(entry, 128))
    : []
  const dependencies = [
    ...environmentDependencies(document.dependencies),
    ...sourceDependencies(document.sourcePackages)
  ]
  return { dependencies, channels, yamlText: bounded(text, MAX_YAML_TEXT) }
}

function parseCondaLock(text: string): ParsedManifest | undefined {
  const parsed = parseEnvironmentYaml(text)
  if (!parsed) return undefined
  let document: unknown
  try {
    document = parseYaml(text)
  } catch {
    return parsed
  }
  if (!isRecord(document) || !Array.isArray(document.package)) return parsed
  const dependencies = [...parsed.dependencies]
  for (const entry of document.package) {
    if (!isRecord(entry) || typeof entry.name !== 'string') continue
    const kind = entry.manager === 'pip' ? 'pip' : 'conda'
    dependencies.push({
      name: bounded(entry.name, 128),
      ...(typeof entry.version === 'string' ? { version: bounded(entry.version, 128) } : {}),
      kind
    })
  }
  return { ...parsed, dependencies }
}

function parsePackageJson(text: string): ParsedManifest | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const dependencies: PhiPluginDependency[] = []
  for (const [field, note] of [
    ['dependencies', 'npm'],
    ['peerDependencies', 'npm peer']
  ] as const) {
    const packages = value[field]
    if (!isRecord(packages)) continue
    for (const [name, version] of Object.entries(packages)) {
      if (typeof version !== 'string') continue
      dependencies.push({
        name: bounded(name, 128),
        version: bounded(version, 128),
        kind: 'other',
        note
      })
    }
  }
  return { dependencies, channels: [] }
}

function parseRenvLock(text: string): ParsedManifest | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value) || !isRecord(value.Packages)) return undefined
  const dependencies: PhiPluginDependency[] = []
  for (const [name, metadata] of Object.entries(value.Packages)) {
    if (name === 'R' || name === 'renv' || !isRecord(metadata)) continue
    dependencies.push({
      name: bounded(name, 128),
      ...(typeof metadata.Version === 'string' ? { version: bounded(metadata.Version, 128) } : {}),
      kind: 'other',
      note: typeof metadata.Source === 'string' ? bounded(metadata.Source, 256) : 'renv'
    })
  }
  return { dependencies, channels: [] }
}

function descriptionField(text: string, field: 'Depends' | 'Imports'): string | undefined {
  const match = text.match(new RegExp(`^${field}:\\s*(.*(?:\\n[ \\t].*)*)`, 'm'))
  return match?.[1]?.replace(/\n[ \t]+/g, ' ')
}

function parseDescription(text: string): ParsedManifest {
  const dependencies: PhiPluginDependency[] = []
  const blob = [descriptionField(text, 'Depends'), descriptionField(text, 'Imports')]
    .filter((value): value is string => Boolean(value))
    .join(', ')
  for (const entry of blob.split(',')) {
    const match = entry.trim().match(/^([^\s(]+)(?:\s*\(([^)]+)\))?/)
    if (!match || match[1] === 'R') continue
    dependencies.push({
      name: bounded(match[1], 128),
      ...(match[2] ? { version: bounded(match[2], 128) } : {}),
      kind: 'other',
      note: 'DESCRIPTION'
    })
  }
  return { dependencies, channels: [] }
}

function parseManifest(path: string, text: string): ParsedManifest | undefined {
  const file = basename(path)
  if (file === 'package.json') return parsePackageJson(text)
  if (file === 'renv.lock') return parseRenvLock(text)
  if (file === 'DESCRIPTION') return parseDescription(text)
  if (file === 'conda-lock.yml') return parseCondaLock(text)
  if (/\.ya?ml$/i.test(file)) return parseEnvironmentYaml(text)
  return undefined
}

function yamlFor(
  dependencies: readonly PhiPluginDependency[],
  channels: readonly string[]
): string {
  const lines: string[] = []
  if (channels.length > 0) {
    lines.push('channels:', ...channels.map((channel) => `  - ${channel}`))
  }
  lines.push('dependencies:')
  const pip = dependencies.filter((entry) => entry.kind === 'pip')
  for (const entry of dependencies.filter((candidate) => candidate.kind !== 'pip')) {
    lines.push(
      entry.kind === 'source'
        ? `  - ${entry.name}${entry.version ? `@${entry.version}` : ''}`
        : `  - ${entry.name}${entry.version ? `=${entry.version}` : ''}`
    )
  }
  if (pip.length > 0) {
    lines.push('  - pip:', ...pip.map((entry) => `    - ${entry.name}${entry.version ?? ''}`))
  }
  return `${lines.join('\n')}\n`.slice(0, MAX_YAML_TEXT)
}

/** Read the first parsable dependency manifest in the same candidate order as phi-site. */
export function readPhiPluginDependencyManifest(
  input: PhiPluginDependencyManifestInput
): PhiPluginDependencyManifestRead {
  const paths = candidates(input)
  const lookedFor = paths.map((path) =>
    bounded(displayPath(path, input.pluginDir, input.bundledEnvironmentsDir))
  )
  for (const path of paths) {
    const text = readBoundedText(path)
    if (text === undefined) continue
    const parsed = parseManifest(path, text)
    if (!parsed) continue
    const dependencies = parsed.dependencies.slice(0, MAX_DEPENDENCIES)
    return {
      channels: parsed.channels,
      dependencyManifest: {
        dependencies,
        ...(parsed.yamlText !== undefined
          ? { yamlText: parsed.yamlText }
          : dependencies.length > 0
            ? { yamlText: yamlFor(dependencies, parsed.channels) }
            : {}),
        sourceFile: displayPath(path, input.pluginDir, input.bundledEnvironmentsDir),
        lookedFor
      }
    }
  }
  return { channels: [], dependencyManifest: { dependencies: [], lookedFor } }
}
