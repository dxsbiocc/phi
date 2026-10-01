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
  type PackageDependency,
  type PackageManifest,
  type PackageRequirements,
  type PackageType
} from '../../src/main/agent/packages/manifest'
import { validatePlugin } from '../../src/main/agent/plugins/validate'

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
}

export interface RegistryIndex {
  schemaVersion: 1
  generatedAt: string
  packages: RegistryIndexEntry[]
}

export interface BuildRegistryOptions {
  repoRoot?: string
  outDir?: string
  generatedAt?: string
}

interface PackageSource {
  root: string
  manifest: PackageManifest
  files: Map<string, Buffer>
}

const DEFAULT_VERSION = '1.0.0'
const nodeRequire = createRequire(import.meta.url)

export function buildRegistry(options: BuildRegistryOptions = {}): RegistryIndex {
  const repoRoot = resolve(
    options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  )
  const outDir = resolve(repoRoot, options.outDir ?? 'dist/registry')
  rejectUntrackedResources(repoRoot)

  const tracked = gitLines(repoRoot, [
    'ls-files',
    '-z',
    '--',
    'resources/plugins',
    'resources/skills'
  ])
  const roots = packageRoots(tracked)
  const sources = roots.map((root) => loadPackageSource(repoRoot, root, tracked))

  mkdirSync(outDir, { recursive: true })

  const entries = sources.map((source) => writePackage(source, outDir)).sort(compareRegistryEntries)
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  if (!Number.isFinite(Date.parse(generatedAt)))
    throw new Error(`invalid generatedAt: ${generatedAt}`)
  const index: RegistryIndex = { schemaVersion: 1, generatedAt, packages: entries }
  writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  return index
}

function packageRoots(tracked: string[]): string[] {
  const roots = new Set<string>()
  for (const path of tracked) {
    const match = /^(resources\/(?:plugins|skills)\/[^/]+)(?:\/|$)/.exec(path)
    if (match?.[1]) roots.add(match[1])
  }
  return [...roots].sort(compareText)
}

function loadPackageSource(repoRoot: string, root: string, tracked: string[]): PackageSource {
  const type: PackageType = root.startsWith('resources/plugins/') ? 'plugin' : 'skill'
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
    throw new Error(`plugin package is missing phi-package.yaml: ${root}`)
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
  } else {
    const result = validatePlugin(absoluteRoot)
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

function parseOutArg(argv: string[]): string | undefined {
  const index = argv.indexOf('--out')
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (!value) throw new Error('--out requires a directory')
  return value
}

const entryScript = process.argv[1] ? resolve(process.argv[1]) : ''
if (entryScript === fileURLToPath(import.meta.url)) {
  try {
    const outDir = parseOutArg(process.argv.slice(2))
    const index = buildRegistry({ outDir })
    const totalSize = index.packages.reduce((sum, item) => sum + item.size, 0)
    console.log(`Built ${index.packages.length} packages (${totalSize} bytes).`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
