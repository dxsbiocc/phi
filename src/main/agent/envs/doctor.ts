import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import Ajv from 'ajv'

import {
  computeEnvId,
  currentPlatform,
  lockSha256,
  parseExplicitLock,
  type EnvMetadata,
  type PhiPlatform
} from './contract'
import {
  acquireEnvironmentLock,
  ensureEnvironment,
  removeManagedEnvironmentPrefix,
  type EnsureEnvironmentResult
} from './ensure'
import { readEnvironmentIndex, updateEnvironmentEntry } from './index-store'
import { hasLiveEnvironmentLeases } from './leases'
import { ensureMambarc, ensureRuntimeLayout, runMicromamba } from './runtime'
import { envMetadataSchema } from './schemas'
import {
  readWslRuntime,
  toLinuxPath,
  usesWslEnvironment,
  wslEnvironmentPrefix,
  type WslRuntime
} from './wsl'

import { errorMessage } from '../../../shared/errorCodes'
const ajv = new Ajv({ allErrors: true, strict: false })
const validateEnvMetadata = ajv.compile(envMetadataSchema)

export interface LockPackage {
  name: string
  version: string
  build: string
  channel: string
  subdir: string
}

export interface EnvironmentCheck {
  envId: string
  ok: boolean
  problems: string[]
}

interface PackageIdentity {
  name: string
  version: string
  build: string
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) return String(error.code)
  return undefined
}

function validationErrors(): string {
  return (validateEnvMetadata.errors ?? [])
    .map((error) => `${error.instancePath || '(root)'} ${error.message ?? 'is invalid'}`.trim())
    .join('; ')
}

/** `<name>-<version>-<build>.conda` or `.tar.bz2`. Names may contain `-`, so split from the right. */
export function parseLockPackage(url: string): LockPackage {
  const hash = url.indexOf('#')
  const bare = hash === -1 ? url : url.slice(0, hash)
  let pathname: string
  try {
    pathname = new URL(bare).pathname
  } catch {
    throw new Error(`invalid conda package url '${url}'`)
  }
  const parts = pathname.split('/').filter((part) => part.length > 0)
  const filename = parts.at(-1)
  const subdir = parts.at(-2)
  const channel = parts.at(-3)
  const stem = filename ? packageStem(filename) : undefined
  const split = stem ? splitPackageStem(stem) : undefined
  if (!filename || !subdir || !channel || !split) {
    throw new Error(`invalid conda package url '${url}'`)
  }
  return { name: split.name, version: split.version, build: split.build, channel, subdir }
}

function packageStem(filename: string): string | undefined {
  if (filename.endsWith('.tar.bz2')) return filename.slice(0, -'.tar.bz2'.length)
  if (filename.endsWith('.conda')) return filename.slice(0, -'.conda'.length)
  return undefined
}

function splitPackageStem(
  stem: string
): { name: string; version: string; build: string } | undefined {
  const buildAt = stem.lastIndexOf('-')
  if (buildAt <= 0) return undefined
  const versionAt = stem.lastIndexOf('-', buildAt - 1)
  if (versionAt <= 0) return undefined
  const name = stem.slice(0, versionAt)
  const version = stem.slice(versionAt + 1, buildAt)
  const build = stem.slice(buildAt + 1)
  if (!name || !version || !build) return undefined
  return { name, version, build }
}

function isDirectory(directory: string): boolean {
  try {
    const stat = lstatSync(directory)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

function inspectEnvJson(prefix: string, lockText: string): string[] {
  const file = join(prefix, '.phi', 'env.json')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return ['env.json is missing']
    return ['env.json is unreadable']
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return ['env.json is invalid']
  }
  if (!validateEnvMetadata(parsed)) {
    const detail = validationErrors()
    return [detail ? `env.json is invalid: ${detail}` : 'env.json is invalid']
  }
  const metadata = parsed as unknown as EnvMetadata
  const problems: string[] = []
  if (metadata.status !== 'ready') problems.push(`status is '${metadata.status}', expected 'ready'`)
  if (metadata.lockSha256 !== lockSha256(lockText)) {
    problems.push('lockSha256 does not match the lock')
  }
  return problems
}

function lockPackages(lockText: string): { packages: PackageIdentity[]; problems: string[] } {
  const parsed = parseExplicitLock(lockText)
  if (!parsed.ok) {
    return {
      packages: [],
      problems: parsed.errors.map((error) => `invalid explicit lock: ${error}`)
    }
  }
  const packages: PackageIdentity[] = []
  const problems: string[] = []
  for (const entry of parsed.entries) {
    try {
      const pkg = parseLockPackage(entry.url)
      packages.push({ name: pkg.name, version: pkg.version, build: pkg.build })
    } catch (error) {
      problems.push(errorMessage(error))
    }
  }
  return { packages, problems }
}

function packageRows(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object') {
    const packages = (value as { packages?: unknown }).packages
    if (Array.isArray(packages)) return packages
  }
  return undefined
}

function asPackage(value: unknown): PackageIdentity | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const build = record.build_string ?? record.build
  if (
    typeof record.name !== 'string' ||
    typeof record.version !== 'string' ||
    typeof build !== 'string' ||
    record.name.length === 0 ||
    record.version.length === 0 ||
    build.length === 0
  ) {
    return undefined
  }
  return { name: record.name, version: record.version, build }
}

function countPackages(
  packages: readonly PackageIdentity[]
): Map<string, { pkg: PackageIdentity; count: number }> {
  const counts = new Map<string, { pkg: PackageIdentity; count: number }>()
  for (const pkg of packages) {
    const key = `${pkg.name}\0${pkg.version}\0${pkg.build}`
    const existing = counts.get(key)
    if (existing) existing.count += 1
    else counts.set(key, { pkg, count: 1 })
  }
  return counts
}

function formatPackage(label: string, pkg: PackageIdentity): string {
  return `${label} ${pkg.name} ${pkg.version} ${pkg.build}`
}

function packageDifferences(expected: PackageIdentity[], actual: PackageIdentity[]): string[] {
  const expectedCounts = countPackages(expected)
  const actualCounts = countPackages(actual)
  const problems: string[] = []
  for (const [key, expectedEntry] of expectedCounts) {
    const missing = expectedEntry.count - (actualCounts.get(key)?.count ?? 0)
    for (let index = 0; index < missing; index += 1) {
      problems.push(formatPackage('missing package', expectedEntry.pkg))
    }
  }
  for (const [key, actualEntry] of actualCounts) {
    const extra = actualEntry.count - (expectedCounts.get(key)?.count ?? 0)
    for (let index = 0; index < extra; index += 1) {
      problems.push(formatPackage('extra package', actualEntry.pkg))
    }
  }
  problems.sort()
  return problems
}

async function listInstalled(
  root: string,
  prefix: string,
  wsl?: WslRuntime
): Promise<{ packages: PackageIdentity[]; problems: string[] }> {
  const layout = ensureRuntimeLayout(root)
  const runtimeRoot = realpathSync(layout.root)
  ensureMambarc(runtimeRoot)
  // micromamba 2.9.0: list -p <prefix> --json
  const runtimePrefix = wsl ? toLinuxPath(prefix, wsl.ready.distro) : prefix
  const result = await runMicromamba(['list', '-p', runtimePrefix, '--json'], {
    root: runtimeRoot,
    wsl
  })
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split('\n')[0]
    const code = result.code === null ? 'aborted' : String(result.code)
    return {
      packages: [],
      problems: [
        detail ? `micromamba list failed (${code}): ${detail}` : `micromamba list failed (${code})`
      ]
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout) as unknown
  } catch {
    return { packages: [], problems: ['micromamba list returned invalid JSON'] }
  }
  const rows = packageRows(parsed)
  if (!rows) return { packages: [], problems: ['micromamba list returned unexpected JSON'] }
  const packages: PackageIdentity[] = []
  const problems: string[] = []
  for (const row of rows) {
    const pkg = asPackage(row)
    if (!pkg) problems.push('micromamba list returned an unrecognized package')
    else packages.push(pkg)
  }
  return { packages, problems }
}

/** First writable regular file. Symlinks are not followed. */
function firstWritableFile(directory: string): string | undefined {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )
  const children: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = join(directory, entry.name)
    if (entry.isFile()) {
      let mode: number
      try {
        mode = lstatSync(full).mode
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue
        throw error
      }
      if ((mode & 0o222) !== 0) return full
      continue
    }
    if (entry.isDirectory()) children.push(full)
  }
  for (const child of children) {
    const found = firstWritableFile(child)
    if (found) return found
  }
  return undefined
}

export async function checkEnvironment(
  root: string,
  envId: string,
  lockText: string
): Promise<EnvironmentCheck> {
  const problems: string[] = []
  const entry = readEnvironmentIndex(root).environments[envId]
  const marker = entry?.prefix ?? join(root, 'envs', envId)
  const viaWsl = entry && usesWslEnvironment(process.platform, entry.platform)
  const wsl = viaWsl ? readWslRuntime(root) : undefined
  const prefix = wsl ? wslEnvironmentPrefix(wsl, envId) : marker
  if (!entry) problems.push(`index entry for '${envId}' is missing`)
  problems.push(...inspectEnvJson(marker, lockText))
  if (viaWsl && (!wsl || !isDirectory(prefix)))
    problems.push('WSL environment prefix is unavailable')
  if ((!viaWsl || wsl) && isDirectory(prefix)) {
    const lock = lockPackages(lockText)
    problems.push(...lock.problems)
    if (lock.problems.length === 0) {
      const installed = await listInstalled(root, prefix, wsl)
      problems.push(...installed.problems)
      if (installed.problems.length === 0) {
        problems.push(...packageDifferences(lock.packages, installed.packages))
      }
    }
    const writable = firstWritableFile(prefix)
    if (writable) problems.push(`writable file ${writable}`)
  }

  const ok = problems.length === 0
  if (!ok && entry) {
    updateEnvironmentEntry(root, envId, {
      status: 'drifted',
      updatedAt: new Date().toISOString()
    })
  }
  return { envId, ok, problems }
}

function environmentTarget(input: Parameters<typeof ensureEnvironment>[0]): {
  root: string
  envId: string
  prefix: string
  platform: PhiPlatform
} {
  const layout = ensureRuntimeLayout(input.root)
  const root = realpathSync(layout.root)
  const platform = input.platform ?? currentPlatform()
  const envId = computeEnvId({
    scope: input.scope,
    owner: input.owner,
    name: input.spec.name,
    platform,
    lockText: input.lockText,
    sourcePackages: input.spec.sourcePackages,
    installation: input.spec.installation
  })
  return { root, envId, prefix: join(root, 'envs', envId), platform }
}

export async function repairEnvironment(
  input: Parameters<typeof ensureEnvironment>[0]
): Promise<EnsureEnvironmentResult> {
  const target = environmentTarget(input)
  const lock = await acquireEnvironmentLock({
    root: target.root,
    envId: target.envId,
    signal: input.signal
  })
  try {
    if (hasLiveEnvironmentLeases(target.root, target.envId))
      throw new Error(`environment ${target.envId} is in use by active consumer leases`)
    await removeManagedEnvironmentPrefix(target.root, target.envId, target.prefix, target.platform)
  } finally {
    lock.release()
  }
  return ensureEnvironment(input)
}
