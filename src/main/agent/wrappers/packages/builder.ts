import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { stringify as stringifyYaml } from 'yaml'

import { createDeterministicTarGz, type ArchiveFile } from '../../packages/archive'
import { parseWrapperCompositionManifest } from '../composition/manifest'
import { collectIncludeReferences } from '../composition/includes'
import {
  findPackageIcon,
  PACKAGE_ICON_FILENAMES,
  writeRegistryIconAsset
} from '../../packages/icon-assets'
import type { RegistryIconAsset } from '../../../../shared/resourceIconTypes'

export type WrapperPackageKind = 'module' | 'subworkflow' | 'workflow' | 'support'

export interface WrapperPackageDependency {
  id: string
  type: 'wrapper'
  version: string
}

export interface GeneratedWrapperPackageManifest {
  schemaVersion: 1
  id: string
  type: 'wrapper'
  version: string
  title: string
  summary: string
  dependsOn: WrapperPackageDependency[]
  files: 'files.json'
}

export interface WrapperPackageSource {
  kind: WrapperPackageKind
  manifest: GeneratedWrapperPackageManifest
  /** Tree-relative source files plus the generated package manifest. */
  files: Map<string, Buffer>
  /** Optional icon at the family root or beside its root wrapper adapter. */
  iconPath?: string
  /** A shared family icon may be published as a sidecar without duplicate tree ownership. */
  iconData?: Buffer
}

export interface UnattributedWrapperInclude {
  packageId: string
  from: string
  target: string
  reason: 'not-found' | 'outside-wrapper-tree' | 'unowned-file'
}

export interface WrapperPackageBuildDiagnostics {
  unattributedIncludes: UnattributedWrapperInclude[]
  unattributedSupportFiles: string[]
}

export interface BuildWrapperPackageSourcesOptions {
  wrappersRoot: string
  /** POSIX paths relative to wrappersRoot. Omit to walk the tree at runtime. */
  files?: string[]
  version?: string
}

export interface BuildWrapperPackageSourcesResult {
  sources: WrapperPackageSource[]
  diagnostics: WrapperPackageBuildDiagnostics
}

export interface WrapperRegistryEntry {
  id: string
  type: 'wrapper'
  version: string
  title: string
  summary: string
  archive: string
  sha256: string
  size: number
  dependsOn: WrapperPackageDependency[]
  iconAsset?: RegistryIconAsset
}

export interface WrapperRegistryIndex {
  schemaVersion: 1
  generatedAt: string
  packages: WrapperRegistryEntry[]
}

export interface MaterializeWrapperRegistryOptions extends BuildWrapperPackageSourcesOptions {
  outDir: string
  generatedAt?: string
  /** The combined build writes its own index after adding skills and plugins. */
  writeIndex?: boolean
  /** Only selected packages need archives when reconciling an existing wrapper tree. */
  includePackage?: (source: WrapperPackageSource) => boolean
}

export interface MaterializeWrapperRegistryResult extends BuildWrapperPackageSourcesResult {
  index: WrapperRegistryIndex
}

interface MutablePackage {
  id: string
  root: string
  kind: WrapperPackageKind
  provider: string
  title: string
  summary: string
  filePaths: Set<string>
  dependencyIds: Set<string>
  iconPath?: string
}

interface SupportUnit {
  root: string
  name: string
  filePaths: string[]
}

const DEFAULT_VERSION = '1.0.0'
const LEGACY_ROOT_FILES = new Set(['index.json', 'pack.json'])

/**
 * Partition a wrapper source tree into independently installable packages.
 * This function intentionally has no git dependency so the desktop runtime
 * can build a temporary bundled registry from shipped resources.
 */
export function buildWrapperPackageSources(
  options: BuildWrapperPackageSourcesOptions
): BuildWrapperPackageSourcesResult {
  const wrappersRoot = resolve(options.wrappersRoot)
  const version = options.version ?? DEFAULT_VERSION
  const files = (options.files ?? walkRegularFiles(wrappersRoot))
    .map(normalizeTreePath)
    .filter((path) => !LEGACY_ROOT_FILES.has(path))
    .sort(compareText)
  assertUnique(files, 'wrapper source path')
  for (const path of files) {
    if (isRunLeftover(path)) throw new Error(`run leftover is not allowed in wrapper tree: ${path}`)
  }
  validateWrapperAdapters(wrappersRoot, files)

  const packages = discoverComponentPackages(wrappersRoot, files)
  const supportUnits = discoverSupportUnits(files)
  const unattributedSupportFiles: string[] = []

  for (const support of supportUnits) {
    const consumers = packages.filter((source) =>
      packageMentionsSupport(source, support, wrappersRoot)
    )
    if (consumers.length === 0) {
      unattributedSupportFiles.push(...support.filePaths)
      continue
    }
    if (consumers.length === 1) {
      for (const path of support.filePaths) consumers[0].filePaths.add(path)
      continue
    }

    const providers = new Set(consumers.map((source) => source.provider))
    const provider = providers.size === 1 ? consumers[0].provider : 'shared'
    const id = packageId('support', provider, support.name)
    const source: MutablePackage = {
      id,
      root: support.root,
      kind: 'support',
      provider,
      title: `${support.name} shared wrapper support`,
      summary: `Shared wrapper-tree support files for ${support.name}.`,
      filePaths: new Set(support.filePaths),
      dependencyIds: new Set()
    }
    packages.push(source)
    for (const consumer of consumers) consumer.dependencyIds.add(id)
  }

  packages.sort((left, right) => compareText(left.id, right.id))
  assertUnique(
    packages.map((source) => source.id),
    'wrapper package id'
  )
  const ownerByFile = indexFileOwners(packages)
  const unattributedIncludes = attributeIncludeDependencies(packages, ownerByFile, wrappersRoot)
  const sources = packages.map((source) => loadPackageSource(source, wrappersRoot, version))

  return {
    sources,
    diagnostics: {
      unattributedIncludes,
      unattributedSupportFiles: unattributedSupportFiles.sort(compareText)
    }
  }
}

/** Write deterministic wrapper archives and an installer-compatible local registry. */
export function materializeWrapperRegistry(
  options: MaterializeWrapperRegistryOptions
): MaterializeWrapperRegistryResult {
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error(`invalid generatedAt: ${generatedAt}`)
  }
  const outDir = resolve(options.outDir)
  mkdirSync(outDir, { recursive: true })
  const built = buildWrapperPackageSources(options)
  const entries = built.sources
    .filter((source) => options.includePackage?.(source) ?? true)
    .map((source) => writeWrapperPackage(source, outDir))
  entries.sort(compareRegistryEntries)
  const index: WrapperRegistryIndex = { schemaVersion: 1, generatedAt, packages: entries }
  if (options.writeIndex !== false) {
    writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  }
  return { ...built, index }
}

function validateWrapperAdapters(wrappersRoot: string, files: string[]): void {
  const ids = new Map<string, string>()
  for (const path of files.filter((candidate) => candidate.endsWith('/wrapper/wrapper.yaml'))) {
    try {
      const manifest = parseWrapperCompositionManifest(
        readFileSync(join(wrappersRoot, ...path.split('/')), 'utf8')
      )
      const previous = ids.get(manifest.id)
      if (previous) {
        throw new Error(`duplicate wrapper id '${manifest.id}' in '${previous}' and '${path}'`)
      }
      ids.set(manifest.id, path)
    } catch (error) {
      throw new Error(
        `invalid wrapper adapter '${path}': ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

function discoverComponentPackages(wrappersRoot: string, files: string[]): MutablePackage[] {
  const availableFiles = new Set(files)
  const roots = new Map<string, { provider: string; name: string }>()
  for (const path of files) {
    const match = /^subworkflows\/([^/]+)\/([^/]+)(?:\/|$)/.exec(path)
    if (!match) continue
    roots.set(`subworkflows/${match[1]}/${match[2]}`, {
      provider: match[1],
      name: match[2]
    })
  }

  const packages: MutablePackage[] = [...roots.entries()].map(([root, definition]) => {
    const metadata = readAdapterMetadata(wrappersRoot, root)
    return {
      id: packageId('subworkflow', definition.provider, definition.name),
      root,
      kind: 'subworkflow',
      provider: definition.provider,
      title: metadata?.name ?? `${definition.provider}/${definition.name} subworkflow`,
      summary:
        metadata?.summary ?? `Vendored ${definition.provider}/${definition.name} subworkflow.`,
      filePaths: new Set(files.filter((path) => path.startsWith(`${root}/`))),
      dependencyIds: new Set()
    }
  })

  const modulePackages = new Map<string, MutablePackage>()
  const adapterSuffix = '/wrapper/wrapper.yaml'
  for (const path of files.filter(
    (candidate) => candidate.startsWith('modules/') && candidate.endsWith(adapterSuffix)
  )) {
    const root = path.slice(0, -adapterSuffix.length)
    const match = /^modules\/([^/]+)\/(.+)$/.exec(root)
    if (!match) continue
    const metadata = readAdapterMetadata(wrappersRoot, root)
    if (!metadata) continue
    const familyRoot = root.split('/').slice(0, 3).join('/')
    const familyIcon = PACKAGE_ICON_FILENAMES.map((name) => `${familyRoot}/${name}`).find((icon) =>
      availableFiles.has(icon)
    )
    modulePackages.set(root, {
      id: packageId('module', match[1], match[2].replaceAll('/', '-')),
      root,
      kind: 'module',
      provider: match[1],
      title: metadata.name,
      summary: metadata.summary,
      filePaths: new Set(),
      dependencyIds: new Set(),
      ...(familyIcon ? { iconPath: familyIcon } : {})
    })
  }
  // The closest adapter owns each module file, including nested adapter trees.
  // Family-level documentation without an adapter is deliberately not installed.
  for (const path of files.filter((candidate) => candidate.startsWith('modules/'))) {
    let root = path.slice(0, path.lastIndexOf('/'))
    while (root.startsWith('modules/')) {
      const owner = modulePackages.get(root)
      if (owner) {
        owner.filePaths.add(path)
        break
      }
      root = root.slice(0, root.lastIndexOf('/'))
    }
  }
  packages.push(...modulePackages.values())

  const workflowSuffix = adapterSuffix
  for (const path of files.filter(
    (candidate) => candidate.startsWith('workflows/') && candidate.endsWith(workflowSuffix)
  )) {
    const root = path.slice(0, -workflowSuffix.length)
    const metadata = readAdapterMetadata(wrappersRoot, root)
    if (!metadata) continue
    const idMatch = /^([^/]+)\/workflows\/(.+)$/.exec(metadata.id)
    if (!idMatch) continue
    packages.push({
      id: packageId('workflow', idMatch[1], idMatch[2]),
      root,
      kind: 'workflow',
      provider: idMatch[1],
      title: metadata.name,
      summary: metadata.summary,
      filePaths: new Set(files.filter((candidate) => candidate.startsWith(`${root}/`))),
      dependencyIds: new Set()
    })
  }
  return packages
}

function readAdapterMetadata(
  wrappersRoot: string,
  componentRoot: string
): { id: string; name: string; summary: string } | undefined {
  const path = join(wrappersRoot, ...componentRoot.split('/'), 'wrapper', 'wrapper.yaml')
  try {
    const manifest = parseWrapperCompositionManifest(readFileSync(path, 'utf8'))
    return { id: manifest.id, name: manifest.name, summary: manifest.summary }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function discoverSupportUnits(files: string[]): SupportUnit[] {
  const byRoot = new Map<string, string[]>()
  for (const path of files) {
    const image = /^(images\/[^/]+)(?:\/|$)/.exec(path)
    const root =
      image?.[1] ?? (!path.includes('/') && !LEGACY_ROOT_FILES.has(path) ? path : undefined)
    if (!root) continue
    const values = byRoot.get(root) ?? []
    values.push(path)
    byRoot.set(root, values)
  }
  return [...byRoot.entries()]
    .map(([root, filePaths]) => ({
      root,
      name: root.startsWith('images/') ? basename(root) : basename(root).replace(/^\./, ''),
      filePaths: filePaths.sort(compareText)
    }))
    .sort((left, right) => compareText(left.root, right.root))
}

function packageMentionsSupport(
  source: MutablePackage,
  support: SupportUnit,
  wrappersRoot: string
): boolean {
  const needles = support.root.startsWith('images/')
    ? [support.root, `resources/wrappers/${support.root}`]
    : [support.root]
  for (const path of source.filePaths) {
    if (!isTextLike(path)) continue
    const text = readFileSync(join(wrappersRoot, ...path.split('/')), 'utf8')
    if (needles.some((needle) => text.includes(needle))) return true
  }
  return false
}

function indexFileOwners(packages: MutablePackage[]): Map<string, MutablePackage> {
  const owners = new Map<string, MutablePackage>()
  for (const source of packages) {
    for (const path of source.filePaths) {
      const existing = owners.get(path)
      if (existing) {
        throw new Error(
          `wrapper tree path '${path}' belongs to both '${existing.id}' and '${source.id}'`
        )
      }
      owners.set(path, source)
    }
  }
  return owners
}

function attributeIncludeDependencies(
  packages: MutablePackage[],
  ownerByFile: Map<string, MutablePackage>,
  wrappersRoot: string
): UnattributedWrapperInclude[] {
  const diagnostics = new Map<string, UnattributedWrapperInclude>()
  for (const source of packages) {
    for (const path of [...source.filePaths]
      .filter((candidate) => candidate.endsWith('.nf'))
      .sort(compareText)) {
      const mainNf = join(wrappersRoot, ...path.split('/'))
      for (const include of collectIncludeReferences(mainNf)) {
        let reason: UnattributedWrapperInclude['reason'] | undefined
        let targetPath: string | undefined
        if (!include.resolvedFile) {
          reason = 'not-found'
        } else {
          const candidate = relative(wrappersRoot, include.resolvedFile)
          if (!candidate || candidate.startsWith('..') || isAbsolute(candidate)) {
            reason = 'outside-wrapper-tree'
          } else {
            targetPath = candidate.split(sep).join('/')
            const owner = ownerByFile.get(targetPath)
            if (!owner) reason = 'unowned-file'
            else if (owner.id !== source.id) source.dependencyIds.add(owner.id)
          }
        }
        if (!reason) continue
        const fromCandidate = relative(wrappersRoot, include.fromFile)
        const from = fromCandidate.startsWith('..')
          ? include.fromFile
          : fromCandidate.split(sep).join('/')
        const diagnostic: UnattributedWrapperInclude = {
          packageId: source.id,
          from,
          target: targetPath ?? include.target,
          reason
        }
        diagnostics.set(`${source.id}\0${from}\0${include.target}\0${reason}`, diagnostic)
      }
    }
  }
  return [...diagnostics.values()].sort(
    (left, right) =>
      compareText(left.packageId, right.packageId) ||
      compareText(left.from, right.from) ||
      compareText(left.target, right.target)
  )
}

function loadPackageSource(
  source: MutablePackage,
  wrappersRoot: string,
  version: string
): WrapperPackageSource {
  const dependencies = [...source.dependencyIds]
    .sort(compareText)
    .map((id) => ({ id, type: 'wrapper' as const, version: `^${version}` }))
  const manifest: GeneratedWrapperPackageManifest = {
    schemaVersion: 1,
    id: source.id,
    type: 'wrapper',
    version,
    title: source.title.slice(0, 80),
    summary: source.summary.slice(0, 300),
    dependsOn: dependencies,
    files: 'files.json'
  }
  const fileMap = new Map<string, Buffer>()
  for (const path of [...source.filePaths].sort(compareText)) {
    assertSafeArchivePath(path)
    if (isRunLeftover(path))
      throw new Error(`run leftover is not allowed in wrapper package: ${path}`)
    const fullPath = join(wrappersRoot, ...path.split('/'))
    const stat = lstatSync(fullPath)
    if (stat.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${path}`)
    if (!stat.isFile()) throw new Error(`non-regular wrapper package entry: ${path}`)
    fileMap.set(path, readFileSync(fullPath))
  }
  fileMap.set('phi-package.yaml', Buffer.from(stringifyYaml(manifest), 'utf8'))
  const iconPath =
    source.iconPath ?? findPackageIcon(fileMap, [source.root, `${source.root}/wrapper`])
  let iconData: Buffer | undefined
  if (iconPath && !fileMap.has(iconPath)) {
    const fullPath = join(wrappersRoot, ...iconPath.split('/'))
    const stat = lstatSync(fullPath)
    if (stat.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${iconPath}`)
    if (!stat.isFile()) throw new Error(`non-regular wrapper package icon: ${iconPath}`)
    iconData = readFileSync(fullPath)
  }
  return {
    kind: source.kind,
    manifest,
    files: fileMap,
    ...(iconPath ? { iconPath } : {}),
    ...(iconData ? { iconData } : {})
  }
}

function writeWrapperPackage(source: WrapperPackageSource, outDir: string): WrapperRegistryEntry {
  const sortedFiles = [...source.files.entries()].sort(([left], [right]) =>
    compareText(left, right)
  )
  const fileList = sortedFiles.map(([path, data]) => ({
    path,
    sha256: sha256(data),
    size: data.length
  }))
  const filesJson = Buffer.from(`${JSON.stringify({ version: 1, files: fileList }, null, 2)}\n`)
  const archiveFiles: ArchiveFile[] = sortedFiles.map(([path, data]) => ({ path, data }))
  archiveFiles.push({ path: 'files.json', data: filesJson })
  const archive = createDeterministicTarGz(archiveFiles)
  const archiveName = `wrapper-${source.manifest.id}-${source.manifest.version}.tar.gz`
  writeFileSync(join(outDir, archiveName), archive)
  const iconFiles =
    source.iconPath && source.iconData
      ? new Map([...source.files, [source.iconPath, source.iconData]])
      : source.files
  const iconAsset = writeRegistryIconAsset(source.manifest, source.iconPath, iconFiles, outDir)
  return {
    id: source.manifest.id,
    type: 'wrapper',
    version: source.manifest.version,
    title: source.manifest.title,
    summary: source.manifest.summary,
    archive: archiveName,
    sha256: sha256(archive),
    size: archive.length,
    dependsOn: source.manifest.dependsOn,
    ...(iconAsset ? { iconAsset } : {})
  }
}

function walkRegularFiles(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    const entries: Dirent[] = readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
      compareText(left.name, right.name)
    )
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${fullPath}`)
      if (entry.isDirectory()) visit(fullPath)
      else if (entry.isFile()) files.push(relative(root, fullPath).split(sep).join('/'))
      else throw new Error(`non-regular wrapper tree entry: ${fullPath}`)
    }
  }
  visit(root)
  return files.sort(compareText)
}

function packageId(kind: WrapperPackageKind, provider: string, name: string): string {
  const id = `${kind}-${provider}-${name}`
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/-$/, '')
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id))
    throw new Error(`invalid generated wrapper package id '${id}'`)
  return id
}

function normalizeTreePath(path: string): string {
  const normalized = path.split(sep).join('/')
  assertSafeArchivePath(normalized)
  return normalized
}

function assertSafeArchivePath(path: string): void {
  const parts = path.split('/')
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe package path '${path}'`)
  }
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`)
    seen.add(value)
  }
}

function isTextLike(path: string): boolean {
  return /(?:^|\/)(?:[^/]+\.(?:nf|config|ya?ml|json|md|txt|groovy|py|r|sh)|Dockerfile)$/i.test(path)
}

function isRunLeftover(path: string): boolean {
  const parts = path.split('/')
  const name = parts.at(-1) ?? ''
  return (
    parts.includes('.nextflow') ||
    parts.includes('work') ||
    parts.includes('results') ||
    parts.includes('__pycache__') ||
    name === '.DS_Store' ||
    name.startsWith('.nextflow.log')
  )
}

function compareRegistryEntries(left: WrapperRegistryEntry, right: WrapperRegistryEntry): number {
  return compareText(left.id, right.id) || compareText(left.version, right.version)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
