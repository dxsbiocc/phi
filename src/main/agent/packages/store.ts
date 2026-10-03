import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import semver from 'semver'

import { getPhiAgentDir } from '../runtime-paths'

export interface InstalledSkillState {
  version: string
  installedAt: string
}

export interface SkillsRegistry {
  version: 1
  skills: Record<string, InstalledSkillState>
}

export function skillsRegistryPath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, 'packages', 'skills.json')
}

export function skillPackagesDir(agentDir = getPhiAgentDir()): string {
  return join(agentDir, 'packages', 'skill')
}

export function skillVersionDir(id: string, version: string, agentDir = getPhiAgentDir()): string {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new Error(`invalid skill package id '${id}'`)
  if (!semver.valid(version)) throw new Error(`invalid skill package version '${version}'`)
  return join(skillPackagesDir(agentDir), id, version)
}

export function readSkillsRegistry(agentDir = getPhiAgentDir()): SkillsRegistry {
  const file = skillsRegistryPath(agentDir)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { version: 1, skills: {} }
    if (error instanceof SyntaxError)
      throw new Error(`invalid skill package registry JSON: ${file}`)
    throw error
  }
  if (!isSkillsRegistry(value)) throw new Error(`invalid skill package registry: ${file}`)
  return value
}

export function writeSkillsRegistry(registry: SkillsRegistry, agentDir = getPhiAgentDir()): void {
  if (!isSkillsRegistry(registry)) throw new Error('refusing to write an invalid skill registry')
  const target = skillsRegistryPath(agentDir)
  const parent = dirname(target)
  mkdirSync(parent, { recursive: true })
  const temporary = join(parent, `.skills.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file may not exist when the initial write failed.
    }
    throw error
  }
}

export function listActiveSkillPackages(
  agentDir = getPhiAgentDir()
): Array<{ id: string; version: string; dir: string }> {
  return Object.entries(readSkillsRegistry(agentDir).skills)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([id, entry]) => {
      const dir = skillVersionDir(id, entry.version, agentDir)
      return existsSync(join(dir, 'SKILL.md')) ? [{ id, version: entry.version, dir }] : []
    })
}

export function installedSkillPackageIdForDir(
  dir: string,
  agentDir = getPhiAgentDir()
): string | undefined {
  const candidate = resolve(dir)
  return listActiveSkillPackages(agentDir).find((entry) => resolve(entry.dir) === candidate)?.id
}

function isSkillsRegistry(value: unknown): value is SkillsRegistry {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.skills)) return false
  return Object.entries(value.skills).every(
    ([id, entry]) =>
      /^[a-z][a-z0-9-]{1,63}$/.test(id) &&
      isRecord(entry) &&
      typeof entry.version === 'string' &&
      semver.valid(entry.version) !== null &&
      typeof entry.installedAt === 'string' &&
      Number.isFinite(Date.parse(entry.installedAt))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}
