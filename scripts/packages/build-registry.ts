import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import semver from 'semver'
import { stringify as stringifyYaml } from 'yaml'

import { offendingResourcePaths } from '../check-resources.mjs'
import { parseSkillFile, validateSkill } from '../../src/main/agent/content/skill'
import {
  createDeterministicTarGz,
  parseTarGz,
  type ArchiveFile
} from '../../src/main/agent/packages/archive'
import {
  parsePackageManifestText,
  readPackageManifest,
  validatePackage,
  type PackageDependency,
  type PackageManifest,
  type PackageRequirements,
  type PackageType
} from '../../src/main/agent/packages/manifest'
import { validatePlugin } from '../../src/main/agent/plugins/validate'
import { signRegistryIndex } from '../../src/main/agent/packages/signature'
import { findPackageIcon, writeRegistryIconAsset } from '../../src/main/agent/packages/icon-assets'
import type { RegistryIconAsset } from '../../src/shared/resourceIconTypes'
import {
  writeRegistryManifestAsset,
  type RegistryManifestAsset
} from '../../src/main/agent/packages/manifest-assets'
import {
  materializeWrapperRegistry,
  type UnattributedWrapperInclude,
  type WrapperPackageKind
} from '../../src/main/agent/wrappers/packages/builder'

export interface RegistryIndexEntry {
  id: string
  type: PackageType
  version: string
  title: string
  summary: string
  archive: string
  sha256: string
  size: number
  minAppVersion?: string
  dependsOn: PackageDependency[]
  requires?: PackageRequirements
  category?: string
  preview?: string
  iconAsset?: RegistryIconAsset
  manifestAsset?: RegistryManifestAsset
}

export interface RegistryIndex {
  schemaVersion: 1
  generatedAt: string
  packages: RegistryIndexEntry[]
}

export interface RegistryBuildReport {
  countsByType: Record<string, number>
  sizesByType: Record<string, number>
  wrapperCountsByKind: Record<WrapperPackageKind, number>
  largestPackages: Array<Pick<RegistryIndexEntry, 'id' | 'type' | 'size'>>
  unattributedIncludes: UnattributedWrapperInclude[]
  unattributedSupportFiles: string[]
}

export interface RegistryBuildResult {
  index: RegistryIndex
  report: RegistryBuildReport
}

export interface BuildRegistryOptions {
  repoRoot?: string
  outDir?: string
  generatedAt?: string
  signKey?: string
  wrapperVersion?: string
}

interface PackageSource {
  root: string
  manifest: PackageManifest
  files: Map<string, Buffer>
}

const DEFAULT_VERSION = '1.0.0'
const nodeRequire = createRequire(import.meta.url)

export function buildRegistry(options: BuildRegistryOptions = {}): RegistryIndex {
  return buildRegistryWithReport(options).index
}

export function buildRegistryWithReport(options: BuildRegistryOptions = {}): RegistryBuildResult {
  const repoRoot = resolve(
    options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  )
  const outDir = resolve(repoRoot, options.outDir ?? 'dist/registry')
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  if (options.wrapperVersion && !semver.valid(options.wrapperVersion))
    throw new Error('wrapperVersion must be semantic version')
  if (!Number.isFinite(Date.parse(generatedAt)))
    throw new Error(`invalid generatedAt: ${generatedAt}`)
  rejectUntrackedResources(repoRoot)

  // Package contract § 2: git-tracked files only.
  const tracked = [
    ...new Set(
      gitLines(repoRoot, [
        'ls-files',
        '-z',
        '--',
        'resources/plugins',
        'resources/skills',
        'resources/connectors',
        'resources/wrappers'
      ])
    )
  ].sort(compareText)
  const roots = packageRoots(tracked)
  const sources = roots.map((root) => loadPackageSource(repoRoot, root, tracked))

  mkdirSync(outDir, { recursive: true })

  const wrappersPrefix = 'resources/wrappers/'
  const wrapperResult = materializeWrapperRegistry({
    wrappersRoot: join(repoRoot, 'resources', 'wrappers'),
    outDir,
    generatedAt,
    files: tracked
      .filter((path) => path.startsWith(wrappersPrefix))
      .map((path) => path.slice(wrappersPrefix.length)),
    writeIndex: false,
    version: options.wrapperVersion
  })
  const entries = [
    ...sources.map((source) => writePackage(source, outDir)),
    ...wrapperResult.index.packages
  ].sort(compareRegistryEntries)
  const index: RegistryIndex = { schemaVersion: 1, generatedAt, packages: entries }
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, 'utf8')
  writeFileSync(join(outDir, 'index.json'), indexBytes)
  if (options.signKey) {
    const signature = signRegistryIndex(indexBytes, readFileSync(resolve(options.signKey)))
    writeFileSync(join(outDir, 'index.sig.json'), `${JSON.stringify(signature, null, 2)}\n`, 'utf8')
  } else {
    rmSync(join(outDir, 'index.sig.json'), { force: true })
  }
  return {
    index,
    report: createBuildReport(index, wrapperResult.sources, wrapperResult.diagnostics)
  }
}

function createBuildReport(
  index: RegistryIndex,
  wrapperSources: Array<{ kind: WrapperPackageKind }>,
  diagnostics: {
    unattributedIncludes: UnattributedWrapperInclude[]
    unattributedSupportFiles: string[]
  }
): RegistryBuildReport {
  const countsByType: Record<string, number> = {}
  const sizesByType: Record<string, number> = {}
  for (const entry of index.packages) {
    countsByType[entry.type] = (countsByType[entry.type] ?? 0) + 1
    sizesByType[entry.type] = (sizesByType[entry.type] ?? 0) + entry.size
  }
  const wrapperCountsByKind: Record<WrapperPackageKind, number> = {
    module: 0,
    subworkflow: 0,
    workflow: 0,
    support: 0
  }
  for (const source of wrapperSources) wrapperCountsByKind[source.kind] += 1
  return {
    countsByType,
    sizesByType,
    wrapperCountsByKind,
    largestPackages: [...index.packages]
      .sort((left, right) => right.size - left.size || compareRegistryEntries(left, right))
      .slice(0, 10)
      .map(({ id, type, size }) => ({ id, type, size })),
    unattributedIncludes: diagnostics.unattributedIncludes,
    unattributedSupportFiles: diagnostics.unattributedSupportFiles
  }
}

function packageRoots(tracked: string[]): string[] {
  const roots = new Set<string>()
  for (const path of tracked) {
    const match = /^(resources\/(?:connectors|plugins|skills)\/[^/]+)(?:\/|$)/.exec(path)
    if (match?.[1]) roots.add(match[1])
  }
  return [...roots].sort(compareText)
}

function loadPackageSource(repoRoot: string, root: string, tracked: string[]): PackageSource {
  const type: PackageType = root.startsWith('resources/plugins/')
    ? 'plugin'
    : root.startsWith('resources/connectors/')
      ? 'mcp'
      : 'skill'
  const absoluteRoot = join(repoRoot, root)
  const relativeFiles = tracked
    .filter((path) => path.startsWith(`${root}/`))
    .map((path) => path.slice(root.length + 1))
    .sort(compareText)
  const files = new Map<string, Buffer>()
  for (const relativePath of relativeFiles) {
    assertSafeArchivePath(relativePath)
    if (isRunLeftover(relativePath)) {
      throw new Error(`run leftover is not allowed in package '${root}': ${relativePath}`)
    }
    if (relativePath === 'files.json') continue
    const fullPath = join(absoluteRoot, relativePath)
    const stat = lstatSync(fullPath)
    if (stat.isSymbolicLink())
      throw new Error(`symbolic link is not allowed: ${root}/${relativePath}`)
    if (!stat.isFile()) throw new Error(`non-regular package entry: ${root}/${relativePath}`)
    files.set(relativePath, readFileSync(fullPath))
  }

  let manifest: PackageManifest
  if (files.has('phi-package.yaml')) {
    manifest = readPackageManifest(absoluteRoot)
  } else if (type === 'skill') {
    manifest = generatedSkillManifest(absoluteRoot)
    files.set('phi-package.yaml', Buffer.from(stringifyYaml(manifest), 'utf8'))
  } else {
    throw new Error(`${type} package is missing phi-package.yaml: ${root}`)
  }

  if (manifest.type !== type) {
    throw new Error(`package type mismatch for ${root}: expected ${type}, got ${manifest.type}`)
  }
  if (manifest.id !== basename(root)) {
    throw new Error(`package id '${manifest.id}' must equal directory name '${basename(root)}'`)
  }
  if (type === 'skill') {
    const result = validateSkill(absoluteRoot)
    if (!result.ok) throwValidation(root, result.errors)
    if (result.skill?.name !== manifest.id) {
      throw new Error(
        `package id '${manifest.id}' must equal skill name '${result.skill?.name ?? ''}'`
      )
    }
  } else if (type === 'plugin') {
    const result = validatePlugin(absoluteRoot)
    if (!result.ok) throwValidation(root, result.errors)
  } else {
    const result = validatePackage(absoluteRoot)
    if (!result.ok) throwValidation(root, result.errors)
  }
  manifest = { ...manifest, files: 'files.json' }
  const manifestText = stringifyYaml(manifest)
  manifest = parsePackageManifestText(manifestText)
  files.set('phi-package.yaml', Buffer.from(manifestText, 'utf8'))
  return { root, manifest, files }
}

function generatedSkillManifest(skillDir: string): PackageManifest {
  const result = validateSkill(skillDir)
  if (!result.ok || !result.skill) throwValidation(skillDir, result.errors)
  const parsed = parseSkillFile(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'))
  if (!parsed.ok) throw new Error(parsed.error)
  const metadata = isRecord(parsed.frontmatter.metadata) ? parsed.frontmatter.metadata : {}
  const candidateVersion = metadata.version
  const version =
    typeof candidateVersion === 'string' && semver.valid(candidateVersion)
      ? candidateVersion
      : DEFAULT_VERSION
  return {
    schemaVersion: 1,
    id: result.skill.name,
    type: 'skill',
    version,
    title: result.skill.name.slice(0, 80),
    summary: result.skill.description.slice(0, 300),
    files: 'files.json'
  }
}

function writePackage(source: PackageSource, outDir: string): RegistryIndexEntry {
  const fileList = [...source.files.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([path, data]) => ({ path, sha256: sha256(data), size: data.length }))
  const filesJson = Buffer.from(`${JSON.stringify({ version: 1, files: fileList }, null, 2)}\n`)
  const archiveFiles: ArchiveFile[] = [...source.files.entries()].map(([path, data]) => ({
    path,
    data
  }))
  archiveFiles.push({ path: 'files.json', data: filesJson })
  const archive = createPackageArchive(archiveFiles)
  const archiveName = `${source.manifest.type}-${source.manifest.id}-${source.manifest.version}.tar.gz`
  writeFileSync(join(outDir, archiveName), archive)

  const entry: RegistryIndexEntry = {
    id: source.manifest.id,
    type: source.manifest.type,
    version: source.manifest.version,
    title: source.manifest.title,
    summary: source.manifest.summary,
    archive: archiveName,
    sha256: sha256(archive),
    size: archive.length,
    dependsOn: source.manifest.dependsOn ?? []
  }
  if (source.manifest.minAppVersion) entry.minAppVersion = source.manifest.minAppVersion
  if (source.manifest.requires) entry.requires = source.manifest.requires
  const iconAsset = writeRegistryIconAsset(
    entry,
    findPackageIcon(source.files),
    source.files,
    outDir
  )
  if (iconAsset) entry.iconAsset = iconAsset
  if (entry.type === 'mcp') {
    entry.manifestAsset = writeRegistryManifestAsset(
      entry,
      source.files.get('phi-package.yaml')!,
      outDir
    )
  }
  return entry
}

function rejectUntrackedResources(repoRoot: string): void {
  const paths = [
    ...gitLines(repoRoot, ['ls-files', '-z', '--others', '--exclude-standard', 'resources']),
    ...gitLines(repoRoot, [
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-standard',
      'resources'
    ])
  ]
  const offending = offendingResourcePaths(paths)
  if (offending.length > 0) {
    throw new Error(`untracked files under resources are not allowed: ${offending.join(', ')}`)
  }
}

function gitLines(repoRoot: string, args: string[]): string[] {
  const output = execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return output.split('\0').filter(Boolean)
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

function throwValidation(
  packagePath: string,
  errors: Array<{ path: string; message: string }>
): never {
  throw new Error(
    `invalid package '${packagePath}': ${errors
      .map((problem) => `${problem.path}: ${problem.message}`)
      .join('; ')}`
  )
}

function compareRegistryEntries(left: RegistryIndexEntry, right: RegistryIndexEntry): number {
  return (
    compareText(left.type, right.type) ||
    compareText(left.id, right.id) ||
    semver.compare(left.version, right.version)
  )
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function createPackageArchive(files: ArchiveFile[]): Buffer {
  type TarModule = {
    create(
      options: Record<string, unknown>,
      paths: string[]
    ): { read(): Buffer | Uint8Array | string | null }
  }
  let tar: TarModule | undefined
  try {
    tar = nodeRequire('tar') as TarModule
  } catch {
    return createDeterministicTarGz(files)
  }

  const staging = mkdtempSync(join(tmpdir(), 'phi-package-build-'))
  try {
    for (const file of files) {
      const target = join(staging, ...file.path.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.data, { mode: file.mode ?? 0o644 })
    }
    const paths = files.map((file) => file.path).sort(compareText)
    const stream = tar.create(
      {
        cwd: staging,
        sync: true,
        gzip: { level: 9 },
        portable: true,
        noMtime: true,
        preservePaths: false,
        follow: false
      },
      paths
    )
    const chunks: Buffer[] = []
    let chunk: Buffer | Uint8Array | string | null
    while ((chunk = stream.read()) !== null) chunks.push(Buffer.from(chunk))
    const archive = Buffer.concat(chunks)
    const archivedPaths = parseTarGz(archive)
      .filter((entry) => entry.type === 'file')
      .map((entry) => entry.path)
      .sort(compareText)
    return JSON.stringify(archivedPaths) === JSON.stringify(paths)
      ? archive
      : createDeterministicTarGz(files)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseOptionalArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

const entryScript = process.argv[1] ? resolve(process.argv[1]) : ''
if (entryScript === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2)
    const outDir = parseOptionalArg(argv, '--out')
    const signKey = parseOptionalArg(argv, '--sign-key')
    const repoRoot = parseOptionalArg(argv, '--source')
    const wrapperVersion = parseOptionalArg(argv, '--wrapper-version')
    const { index, report } = buildRegistryWithReport({ outDir, signKey, repoRoot, wrapperVersion })
    const totalSize = index.packages.reduce((sum, item) => sum + item.size, 0)
    console.log(`Built ${index.packages.length} packages (${totalSize} bytes).`)
    for (const type of Object.keys(report.countsByType).sort(compareText)) {
      console.log(
        `  ${type}: ${report.countsByType[type]} packages (${report.sizesByType[type]} bytes)`
      )
    }
    console.log(
      `Wrapper kinds: ${Object.entries(report.wrapperCountsByKind)
        .map(([kind, count]) => `${kind}=${count}`)
        .join(', ')}`
    )
    console.log('Largest packages:')
    for (const entry of report.largestPackages) {
      console.log(`  ${entry.type}:${entry.id} ${entry.size} bytes`)
    }
    if (report.unattributedIncludes.length > 0) {
      console.log(`Unattributed includes (${report.unattributedIncludes.length}):`)
      for (const include of report.unattributedIncludes) {
        console.log(
          `  ${include.packageId}: ${include.from} -> ${include.target} (${include.reason})`
        )
      }
    } else {
      console.log('Unattributed includes: none')
    }
    if (report.unattributedSupportFiles.length > 0) {
      console.log(`Unattributed support files: ${report.unattributedSupportFiles.join(', ')}`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
