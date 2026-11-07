import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import semver from 'semver'

import { parseSkillFile } from '../content/skill'
import { setEnabled } from '../enablement'
import type {
  HomeSkillCandidate,
  HomeSkillImportCandidatesResult,
  HomeSkillImportResult,
  HomeSkillImportSelection,
  HomeSkillSource,
  HomeSkillSourceStatus
} from '../../../shared/homeSkillImportTypes'
import { createDeterministicTarGz } from './archive'
import { listInstalledPackages } from './installed'
import type { LocalRegistry, RegistryPackageEntry } from './installer-types'
import { compareText, isRecord, sha256 } from './installer-utils'
import { installPackages } from './lifecycle'
import { regularPackageFiles } from './materialize-registry'
import { runPackageMutation } from './mutation-queue'
import { planInstall } from './planning'

const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const silentLogger = { info: (): void => undefined, warn: (): void => undefined }

interface DiscoveredHomeSkill extends HomeSkillCandidate {
  dir: string
}

/** The renderer never sees local skill directories. */
function publicCandidate(skill: DiscoveredHomeSkill): HomeSkillCandidate {
  const copy: Partial<DiscoveredHomeSkill> = { ...skill }
  delete copy.dir
  return copy as HomeSkillCandidate
}

const SOURCE_ROOTS: ReadonlyArray<{
  source: HomeSkillSource
  relativeDirs: readonly string[]
}> = [
  { source: 'agents', relativeDirs: ['.agents/skills', '.agent/skills'] },
  { source: 'claude', relativeDirs: ['.claude/skills'] },
  { source: 'codex', relativeDirs: ['.codex/skills'] },
  { source: 'cursor', relativeDirs: ['.cursor/skills'] }
]

export function listHomeSkillImportCandidates(
  options: { agentDir: string; homeDir?: string } = { agentDir: '' }
): HomeSkillImportCandidatesResult {
  const discovered = discoverHomeSkills(options)
  return {
    candidates: discovered.candidates.map(publicCandidate),
    sources: discovered.sources,
    installedIds: discovered.installedIds
  }
}

export async function importHomeSkills(
  selections: readonly HomeSkillImportSelection[],
  options: { agentDir: string; appVersion: string; homeDir?: string }
): Promise<HomeSkillImportResult> {
  const home = options.homeDir ?? homedir()
  const discovered = discoverHomeSkills({ agentDir: options.agentDir, homeDir: home })
  const byKey = new Map(
    discovered.candidates.map((candidate) => [`${candidate.source}:${candidate.id}`, candidate])
  )
  const installedIds = new Set(discovered.installedIds)
  const imported: string[] = []
  const skipped: string[] = []
  const errors: HomeSkillImportResult['errors'] = []

  for (const selection of selections) {
    const key = `${selection.source}:${selection.id}`
    const candidate = byKey.get(key)
    if (!candidate) {
      errors.push({
        source: selection.source,
        id: selection.id,
        message: 'Skill is no longer available in that home directory'
      })
      continue
    }
    if (installedIds.has(candidate.id)) {
      skipped.push(candidate.id)
      continue
    }
    try {
      await runPackageMutation(async () => {
        await installHomeSkillCandidate(candidate, { ...options, homeDir: home })
      })
      imported.push(candidate.id)
      installedIds.add(candidate.id)
    } catch (error) {
      errors.push({
        source: selection.source,
        id: selection.id,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return { imported, skipped, errors }
}

function discoverHomeSkills(options: { agentDir: string; homeDir?: string }): {
  candidates: DiscoveredHomeSkill[]
  sources: HomeSkillSourceStatus[]
  installedIds: string[]
} {
  const home = options.homeDir ?? homedir()
  const installedIds = listInstalledPackages({ agentDir: options.agentDir })
    .filter((item) => item.type === 'skill')
    .map((item) => item.id)
  const installed = new Set(installedIds)
  const candidates: DiscoveredHomeSkill[] = []
  const sources: HomeSkillSourceStatus[] = []
  const seen = new Set<string>()

  for (const entry of SOURCE_ROOTS) {
    let present = false
    let count = 0
    const sourceIds = new Set<string>()
    // relativeDirs are ordered so earlier roots win (e.g. ~/.agents before ~/.agent).
    for (const relative of entry.relativeDirs) {
      const root = join(home, relative)
      if (!existsSync(root)) continue
      let rootStat
      try {
        rootStat = lstatSync(root)
      } catch {
        continue
      }
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) continue
      present = true
      for (const candidate of scanSkillRoot(root, entry.source, home)) {
        const key = `${candidate.source}:${candidate.id}`
        if (seen.has(key) || sourceIds.has(candidate.id)) continue
        seen.add(key)
        sourceIds.add(candidate.id)
        count += 1
        candidates.push({
          ...candidate,
          installed: installed.has(candidate.id)
        })
      }
    }
    sources.push({ source: entry.source, present, count })
  }

  candidates.sort((left, right) => {
    const bySource = compareText(left.source, right.source)
    return bySource !== 0 ? bySource : compareText(left.id, right.id)
  })

  return { candidates, sources, installedIds }
}

async function installHomeSkillCandidate(
  candidate: DiscoveredHomeSkill,
  options: { agentDir: string; appVersion: string; homeDir: string }
): Promise<void> {
  assertSafeImportTarget(candidate.dir, options.homeDir)
  const temporaryRoot = join(options.agentDir, '.staging')
  mkdirSync(temporaryRoot, { recursive: true })
  const temporary = mkdtempSync(join(temporaryRoot, 'home-skill-'))
  try {
    const skillMd = readFileSync(join(candidate.dir, 'SKILL.md'), 'utf8')
    const parsed = parseSkillFile(skillMd)
    if (!parsed.ok) throw new Error(parsed.error)
    const registry = buildHomeSkillRegistry(candidate, parsed.frontmatter, temporary)
    const existing = listInstalledPackages({ agentDir: options.agentDir }).find(
      (item) => item.type === 'skill' && item.id === candidate.id
    )
    if (existing && existing.registry !== registry.id) {
      throw new Error(
        `Skill ${candidate.id} is already installed from another source; resolve the conflict in Skills first`
      )
    }
    if (existing) return
    const installOptions = { agentDir: options.agentDir, appVersion: options.appVersion }
    const plan = planInstall(registry, { type: 'skill', id: candidate.id }, installOptions)
    if (plan.packages.length > 0) {
      await installPackages(plan, installOptions)
    }
    setEnabled(`skill:${candidate.id}`, true, {
      agentDir: options.agentDir,
      logger: silentLogger
    })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function buildHomeSkillRegistry(
  candidate: DiscoveredHomeSkill,
  frontmatter: Record<string, unknown>,
  temporary: string
): LocalRegistry {
  const metadata = isRecord(frontmatter.metadata) ? frontmatter.metadata : undefined
  const version =
    typeof metadata?.version === 'string' && semver.valid(metadata.version)
      ? metadata.version
      : '1.0.0'
  const summary =
    typeof frontmatter.description === 'string' && frontmatter.description.trim()
      ? frontmatter.description.trim().slice(0, 300)
      : candidate.summary || `Imported skill ${candidate.id}`
  const title =
    typeof frontmatter.name === 'string' && frontmatter.name.trim()
      ? frontmatter.name.trim()
      : candidate.title
  const manifest = {
    schemaVersion: 1,
    type: 'skill',
    id: candidate.id,
    version,
    title,
    summary,
    files: 'files.json'
  }
  const packageDir = join(temporary, 'package')
  mkdirSync(packageDir)
  for (const file of regularPackageFiles(candidate.dir)) {
    if (file.path === 'phi-package.yaml' || file.path === '.source.json') continue
    const target = join(packageDir, ...file.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.data, { flag: 'wx' })
    chmodSync(target, file.mode ?? 0o644)
  }
  writeFileSync(join(packageDir, 'phi-package.yaml'), `${JSON.stringify(manifest, null, 2)}\n`)
  const files = regularPackageFiles(packageDir).sort((left, right) =>
    compareText(left.path, right.path)
  )
  const filesJson = Buffer.from(
    `${JSON.stringify({ version: 1, files: files.map((file) => ({ path: file.path, sha256: sha256(file.data), size: file.data.length })) }, null, 2)}\n`
  )
  const archive = createDeterministicTarGz([...files, { path: 'files.json', data: filesJson }])
  const registryDir = join(temporary, 'registry')
  mkdirSync(registryDir)
  const archiveName = `skill-${candidate.id}-${version}.tar.gz`
  writeFileSync(join(registryDir, archiveName), archive)
  const entry: RegistryPackageEntry = {
    ...manifest,
    type: 'skill',
    archive: archiveName,
    sha256: sha256(archive),
    size: archive.length,
    dependsOn: []
  }
  return {
    schemaVersion: 1,
    id: `home-skill:${candidate.source}/${candidate.id}`,
    dir: registryDir,
    trust: 'imported',
    generatedAt: new Date().toISOString(),
    packages: [entry]
  }
}

function scanSkillRoot(root: string, source: HomeSkillSource, home: string): DiscoveredHomeSkill[] {
  const out: DiscoveredHomeSkill[] = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(root, entry.name)
    if (!isSafeSkillDir(dir, home)) continue
    const skillPath = join(dir, 'SKILL.md')
    if (!existsSync(skillPath)) continue
    let skillStat
    try {
      skillStat = lstatSync(skillPath)
    } catch {
      continue
    }
    if (skillStat.isSymbolicLink() || !skillStat.isFile()) continue
    let text: string
    try {
      text = readFileSync(skillPath, 'utf8')
    } catch {
      continue
    }
    const parsed = parseSkillFile(text)
    if (!parsed.ok) continue
    const id = skillIdFor(entry.name, parsed.frontmatter)
    if (!id) continue
    const title =
      typeof parsed.frontmatter.name === 'string' && parsed.frontmatter.name.trim()
        ? parsed.frontmatter.name.trim()
        : id
    const summary =
      typeof parsed.frontmatter.description === 'string' && parsed.frontmatter.description.trim()
        ? parsed.frontmatter.description.trim().slice(0, 300)
        : ''
    out.push({ source, id, title, summary, dir, installed: false })
  }
  return out
}

function skillIdFor(dirName: string, frontmatter: Record<string, unknown>): string | undefined {
  if (SKILL_ID.test(dirName)) return dirName
  if (typeof frontmatter.name === 'string' && SKILL_ID.test(frontmatter.name))
    return frontmatter.name
  return undefined
}

function assertSafeImportTarget(dir: string, home: string): void {
  if (!isSafeSkillDir(dir, home)) {
    throw new Error('Skill directory is missing, unsafe, or no longer under the home folder')
  }
  const skillPath = join(dir, 'SKILL.md')
  let skillStat
  try {
    skillStat = lstatSync(skillPath)
  } catch {
    throw new Error('Skill directory no longer contains SKILL.md')
  }
  if (skillStat.isSymbolicLink() || !skillStat.isFile()) {
    throw new Error('SKILL.md must be a regular file')
  }
}

function isSafeSkillDir(dir: string, home: string): boolean {
  let stat
  try {
    stat = lstatSync(dir)
  } catch {
    return false
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false
  let real: string
  let homeReal: string
  try {
    real = realpathSync(dir)
    homeReal = realpathSync(home)
  } catch {
    return false
  }
  const homeRoot = homeReal.endsWith(sep) ? homeReal : homeReal + sep
  return real === homeReal || real.startsWith(homeRoot)
}

export function parseHomeSkillImportSelections(value: unknown): HomeSkillImportSelection[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new Error('Select one or more skills')
  }
  const selections: HomeSkillImportSelection[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (
      !isRecord(item) ||
      !isHomeSkillSource(item.source) ||
      typeof item.id !== 'string' ||
      !SKILL_ID.test(item.id)
    ) {
      throw new Error('Skill selection is invalid')
    }
    const key = `${item.source}:${item.id}`
    if (seen.has(key)) continue
    seen.add(key)
    selections.push({ source: item.source, id: item.id })
  }
  if (selections.length === 0) throw new Error('Select one or more skills')
  return selections
}

const HOME_SKILL_SOURCES: ReadonlySet<string> = new Set(['agents', 'claude', 'codex', 'cursor'])

function isHomeSkillSource(value: unknown): value is HomeSkillSource {
  return typeof value === 'string' && HOME_SKILL_SOURCES.has(value)
}
