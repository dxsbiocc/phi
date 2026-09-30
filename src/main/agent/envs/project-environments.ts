import { createHash, randomBytes } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { stringify } from 'yaml'

import {
  PHI_PLATFORMS,
  parseEnvironmentRef,
  parseEnvironmentSpec,
  parseExplicitLock,
  type EnvironmentSpec,
  type PhiPlatform
} from './contract'

export interface ProjectOverrides {
  overrides: Record<string, string>
  /** Set when the file is missing or not a valid overrides document. */
  problem?: string
}

export interface ProjectEnvironmentFiles {
  name: string
  spec: EnvironmentSpec
  lockText: string
  platform: PhiPlatform
}

const ENVIRONMENTS_JSON = 'environments.json'

/** `p` plus the first 10 hex digits of SHA-256 over the project's real path. */
export function projectOwner(projectDir: string): string {
  const real = realpathSync(projectDir)
  return `p${createHash('sha256').update(real).digest('hex').slice(0, 10)}`
}

/** Missing or invalid `environments.json` yields `{}` and a problem string. */
export function readOverrides(projectDir: string): ProjectOverrides {
  const file = overridesPath(projectDir)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
      return { overrides: {}, problem: 'environments.json is missing' }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { overrides: {}, problem: `environments.json is invalid: ${message}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { overrides: {}, problem: `environments.json is invalid: ${message}` }
  }
  const overrides = validOverrides(parsed)
  if (!overrides) {
    return { overrides: {}, problem: 'environments.json is invalid' }
  }
  return { overrides }
}

/** `<base>-x<n>`, with `n` one more than the highest existing environment of that base. */
export function nextProjectEnvironmentName(projectDir: string, baseName: string): string {
  assertEnvironmentName(baseName)
  const directory = environmentsDir(projectDir)
  let highest = 0
  let names: string[] = []
  try {
    names = readdirSync(directory)
  } catch (error) {
    const code = errorCode(error)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  }
  const pattern = new RegExp(`^${baseName}-x([1-9][0-9]*)$`)
  for (const name of names) {
    const match = pattern.exec(name)
    if (!match) continue
    if (!isDirectory(join(directory, name))) continue
    const value = Number(match[1])
    if (value > highest) highest = value
  }
  const next = `${baseName}-x${String(highest + 1)}`
  assertEnvironmentName(next)
  return next
}

export function writeProjectEnvironment(projectDir: string, input: ProjectEnvironmentFiles): void {
  assertEnvironmentName(input.name)
  if (!isPhiPlatform(input.platform)) {
    throw new Error(`unsupported platform '${input.platform}'`)
  }
  if (input.spec.name !== input.name) {
    throw new Error(
      `project environment name '${input.name}' does not match spec name '${input.spec.name}'`
    )
  }
  const yaml = stringify(input.spec, { lineWidth: 0 })
  const parsed = parseEnvironmentSpec(yaml.endsWith('\n') ? yaml : `${yaml}\n`)
  if (!parsed.ok) {
    throw new Error(`project environment spec is invalid: ${parsed.errors.join('; ')}`)
  }
  const lock = parseExplicitLock(input.lockText)
  if (!lock.ok) {
    throw new Error(`project environment lock is invalid: ${lock.errors.join('; ')}`)
  }
  const directory = join(environmentsDir(projectDir), input.name)
  atomicWrite(join(directory, 'environment.yml'), yaml.endsWith('\n') ? yaml : `${yaml}\n`)
  atomicWrite(join(directory, 'locks', `${input.platform}.txt`), input.lockText)
}

export function setOverride(projectDir: string, from: string, to: string): void {
  assertEnvironmentRef(from)
  assertProjectRef(to)
  const current = readOverrides(projectDir)
  const overrides = { ...(current.problem ? {} : current.overrides) }
  overrides[from] = to
  writeOverrides(projectDir, overrides)
}

/** Replace the overrides map. Every key and `project:` value is validated. */
export function writeOverrides(projectDir: string, overrides: Record<string, string>): void {
  for (const [from, to] of Object.entries(overrides)) {
    assertEnvironmentRef(from)
    assertProjectRef(to)
  }
  const text = `${JSON.stringify({ version: 1, overrides }, null, 2)}\n`
  atomicWrite(overridesPath(projectDir), text)
}

/**
 * Apply `environments.json` once. A missing file leaves the ref unchanged and
 * does not warn. An override whose project environment is absent is ignored.
 */
export function applyOverrides(
  ref: string,
  projectDir: string
): { ref: string; warnings: string[] } {
  const file = readOverrides(projectDir)
  const target = file.overrides[ref]
  if (target === undefined) return { ref, warnings: [] }
  let name: string
  try {
    const parsed = parseEnvironmentRef(target)
    if (parsed.kind !== 'project') {
      return { ref, warnings: [`override '${ref}' is invalid and was ignored`] }
    }
    name = parsed.name
  } catch {
    return { ref, warnings: [`override '${ref}' is invalid and was ignored`] }
  }
  if (!projectEnvironmentExists(projectDir, name)) {
    return {
      ref,
      warnings: [
        `override '${ref}' points at missing project environment '${target}' and was ignored`
      ]
    }
  }
  return { ref: target, warnings: [] }
}

export function projectEnvironmentExists(projectDir: string, name: string): boolean {
  try {
    return statSync(join(environmentsDir(projectDir), name, 'environment.yml')).isFile()
  } catch {
    return false
  }
}

function overridesPath(projectDir: string): string {
  return join(projectDir, '.phi', ENVIRONMENTS_JSON)
}

function environmentsDir(projectDir: string): string {
  return join(projectDir, '.phi', 'environments')
}

function assertEnvironmentName(name: string): void {
  parseEnvironmentRef(`project:${name}`)
}

function assertEnvironmentRef(ref: string): void {
  parseEnvironmentRef(ref)
}

function assertProjectRef(ref: string): void {
  const parsed = parseEnvironmentRef(ref)
  if (parsed.kind !== 'project') {
    throw new Error(`override target must be project:<name>, got '${ref}'`)
  }
}

function validOverrides(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  if (value.version !== 1) return undefined
  if (!isRecord(value.overrides)) return undefined
  for (const key of Object.keys(value)) {
    if (key !== 'version' && key !== 'overrides') return undefined
  }
  const overrides: Record<string, string> = {}
  for (const [from, to] of Object.entries(value.overrides)) {
    if (typeof to !== 'string') return undefined
    try {
      parseEnvironmentRef(from)
      const target = parseEnvironmentRef(to)
      if (target.kind !== 'project') return undefined
    } catch {
      return undefined
    }
    overrides[from] = to
  }
  return overrides
}

function atomicWrite(file: string, text: string): void {
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true })
  const temporary = join(
    directory,
    `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  )
  try {
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temp file may not exist when writeFileSync failed first.
    }
    throw error
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isPhiPlatform(value: string): value is PhiPlatform {
  for (const platform of PHI_PLATFORMS) {
    if (platform === value) return true
  }
  return false
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) return String(error.code)
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
