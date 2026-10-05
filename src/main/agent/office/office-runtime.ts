import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { getBundledResourceDir } from '../runtime/runtime-adapter'
import { runOfficeCli, type OfficeCliRunResult } from './office-driver'

export const OFFICECLI_PLATFORM_IDS = ['darwin-arm64', 'darwin-x64'] as const
export type OfficePlatformId = (typeof OFFICECLI_PLATFORM_IDS)[number]

/** Top-level verbs Phi's driver relies on; checked against the pinned binary's --help. */
export const REQUIRED_OFFICECLI_COMMANDS = [
  'create',
  'open',
  'close',
  'save',
  'watch',
  'unwatch',
  'view',
  'get',
  'query',
  'set',
  'add',
  'remove',
  'move',
  'batch',
  'import',
  'validate'
] as const

/** `batch` flags Phi depends on for atomic transactions and JSON input. */
const REQUIRED_BATCH_FLAGS = ['--input', '--commands', '--best-effort'] as const

// The first execution of a newly installed binary can spend ~8 s in macOS's security assessment
// (measured on the packaged app); later runs take ~0.1 s. Leave headroom so that is not an error.
const PROBE_TIMEOUT_MS = 30_000
const FETCH_HINT = 'Run `bun run office:fetch` to download the pinned OfficeCLI binary.'
export const MAX_ACTIVE_OFFICE_DOCUMENTS = 3

export interface OfficePlatformRelease {
  url: string
  sha256: string
}

export interface OfficeManifest {
  version: string
  platforms: Partial<Record<string, OfficePlatformRelease>>
}

export type OfficeRuntimeStatus =
  | { state: 'available'; binaryPath: string; version: string; platform: OfficePlatformId }
  | { state: 'unsupported-platform'; platform: string }
  | { state: 'missing'; expectedPath: string; hint: string }
  | { state: 'checksum-mismatch'; binaryPath: string }
  | { state: 'version-mismatch'; binaryPath: string; expected: string; found: string }
  | { state: 'incompatible'; binaryPath: string; missing: string[] }
  | { state: 'unusable'; binaryPath: string; reason: string }

export interface DetectOfficeRuntimeOptions {
  manifest?: OfficeManifest
  platform?: string
  arch?: string
  /** Binary locations in priority order; defaults to the packaged then repository bundle. */
  candidates?: readonly string[]
  /** Directory for the probe processes; they never create files, but keep them away from projects. */
  cwd?: string
  timeoutMs?: number
}

export function officePlatformId(platform: string, arch: string): OfficePlatformId | undefined {
  const id = `${platform}-${arch}`
  return (OFFICECLI_PLATFORM_IDS as readonly string[]).includes(id)
    ? (id as OfficePlatformId)
    : undefined
}

/** Packaged extraResources path first, then the repository bundle used in development. */
export function officeBinaryCandidates(
  platformId: OfficePlatformId,
  options: { resourcesPath?: string; bundledOfficeDir: string }
): string[] {
  const bundled = join(options.bundledOfficeDir, 'officecli', platformId, 'officecli')
  if (typeof options.resourcesPath !== 'string') return [bundled]
  return [join(options.resourcesPath, 'office', 'officecli', platformId, 'officecli'), bundled]
}

export function parseOfficeManifest(raw: unknown): OfficeManifest {
  const section = (raw as { officecli?: { version?: unknown; platforms?: unknown } } | null)
    ?.officecli
  if (!section || typeof section.version !== 'string' || typeof section.platforms !== 'object') {
    throw new Error('Office manifest is missing the officecli version or platforms')
  }
  const platforms: Record<string, OfficePlatformRelease> = {}
  for (const [id, entry] of Object.entries(section.platforms as Record<string, unknown>)) {
    const release = entry as Partial<OfficePlatformRelease> | null
    if (typeof release?.url === 'string' && typeof release.sha256 === 'string') {
      platforms[id] = { url: release.url, sha256: release.sha256 }
    }
  }
  return { version: section.version, platforms }
}

export function loadOfficeManifest(officeDir: string): OfficeManifest {
  return parseOfficeManifest(JSON.parse(readFileSync(join(officeDir, 'manifest.json'), 'utf8')))
}

// Hashing a ~34 MB binary on every probe is wasteful; reuse the digest while the file is unchanged.
const digestCache = new Map<string, { stamp: string; sha256: string }>()

function fileDigest(binaryPath: string): string {
  const stats = statSync(binaryPath)
  const stamp = `${stats.size}:${stats.mtimeMs}`
  const cached = digestCache.get(binaryPath)
  if (cached?.stamp === stamp) return cached.sha256
  const sha256 = createHash('sha256').update(readFileSync(binaryPath)).digest('hex')
  digestCache.set(binaryPath, { stamp, sha256 })
  return sha256
}

function failureReason(result: OfficeCliRunResult, what: string): string | undefined {
  if (result.spawnError) return `could not start (${result.spawnError})`
  if (result.timedOut) return `${what} timed out`
  if (result.truncated) return `${what} produced too much output`
  if (result.exitCode !== 0) return `${what} exited with code ${String(result.exitCode)}`
  return undefined
}

function helpCommands(help: string): Set<string> {
  const names = new Set<string>()
  let inCommands = false
  for (const line of help.split('\n')) {
    if (/^Commands:/.test(line)) {
      inCommands = true
      continue
    }
    if (inCommands && /^\S/.test(line)) break
    const match = inCommands ? /^ {2}([a-z][a-z-]*)\b/.exec(line) : null
    if (match) names.add(match[1])
  }
  return names
}

async function probeCompatibility(
  binaryPath: string,
  run: { cwd?: string; timeoutMs: number }
): Promise<{ missing: string[] } | { reason: string }> {
  const help = await runOfficeCli(binaryPath, ['--help'], run)
  const helpFailure = failureReason(help, '--help')
  if (helpFailure) return { reason: helpFailure }
  const commands = helpCommands(help.stdout)
  const missing: string[] = REQUIRED_OFFICECLI_COMMANDS.filter((name) => !commands.has(name))

  const batch = await runOfficeCli(binaryPath, ['batch', '--help'], run)
  const batchFailure = failureReason(batch, 'batch --help')
  if (batchFailure) return { reason: batchFailure }
  for (const flag of REQUIRED_BATCH_FLAGS) {
    if (!batch.stdout.includes(flag)) missing.push(`batch ${flag}`)
  }
  return { missing }
}

/**
 * Reports whether the pinned OfficeCLI is usable. Read-only: only `--version`, `--help` and
 * `batch --help` run, with updates disabled, and no document is created or opened.
 */
export async function detectOfficeRuntime(
  options: DetectOfficeRuntimeOptions = {}
): Promise<OfficeRuntimeStatus> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const platformId = officePlatformId(platform, arch)
  if (!platformId) return { state: 'unsupported-platform', platform: `${platform}-${arch}` }

  const manifest = options.manifest ?? loadDefaultManifest()
  const release = manifest.platforms[platformId]
  if (!release) return { state: 'unsupported-platform', platform: platformId }

  const candidates = options.candidates ?? defaultCandidates(platformId)
  const binaryPath = candidates.find((candidate) => existsSync(candidate))
  if (!binaryPath) {
    return {
      state: 'missing',
      expectedPath: candidates[candidates.length - 1] ?? '',
      hint: FETCH_HINT
    }
  }

  try {
    if (fileDigest(binaryPath) !== release.sha256) return { state: 'checksum-mismatch', binaryPath }
  } catch (error) {
    return { state: 'unusable', binaryPath, reason: `could not read binary (${String(error)})` }
  }

  const run = { cwd: options.cwd, timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS }
  const versionResult = await runOfficeCli(binaryPath, ['--version'], run)
  const versionFailure = failureReason(versionResult, '--version')
  if (versionFailure) return { state: 'unusable', binaryPath, reason: versionFailure }
  const found = versionResult.stdout.trim()
  if (found !== manifest.version) {
    return { state: 'version-mismatch', binaryPath, expected: manifest.version, found }
  }

  const compatibility = await probeCompatibility(binaryPath, run)
  if ('reason' in compatibility) {
    return { state: 'unusable', binaryPath, reason: compatibility.reason }
  }
  if (compatibility.missing.length > 0) {
    return { state: 'incompatible', binaryPath, missing: compatibility.missing }
  }
  return { state: 'available', binaryPath, version: found, platform: platformId }
}

function loadDefaultManifest(): OfficeManifest {
  return loadOfficeManifest(defaultOfficeDir())
}

function defaultCandidates(platformId: OfficePlatformId): string[] {
  const resourcesPath = process.resourcesPath
  return officeBinaryCandidates(platformId, {
    resourcesPath: typeof resourcesPath === 'string' ? resourcesPath : undefined,
    bundledOfficeDir: defaultOfficeDir()
  })
}

function defaultOfficeDir(): string {
  return getBundledResourceDir('office')
}
