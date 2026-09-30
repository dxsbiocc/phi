// Turns an environment.yml into one explicit lock per platform.
//
// Usage (needs the TS loader, so go through the npm script):
//   npm run runtime:lock -- --spec tests/fixtures/envs/minimal/environment.yml
//   npm run runtime:lock -- --spec environment.yml --out builds/locks
//   npm run runtime:lock -- --spec environment.yml --platform darwin-arm64 linux-x64
//   npm run runtime:lock -- --annotate path/to/lock.txt …

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PHI_PLATFORMS,
  lockSha256,
  parseEnvironmentSpec,
  parseExplicitLock,
  parseLockDownloadBytes,
  type PhiPlatform
} from '../../src/main/agent/envs/contract'
import { ensureRuntimeLayout, writeMambarc } from '../../src/main/agent/envs/runtime'
import {
  PLATFORM_BASELINES,
  solveExplicitLock,
  withDownloadBytes
} from '../../src/main/agent/envs/solve'

export {
  PLATFORM_BASELINES,
  baselineLabel,
  explicitLockFromDryRun,
  refusePipDependencies,
  withDownloadBytes,
  type ExplicitLockMeta
} from '../../src/main/agent/envs/solve'

export interface LockEnvironmentOptions {
  specPath: string
  outDir?: string
  platforms?: readonly PhiPlatform[]
  /** Defaults to this repo (two levels above `scripts/runtime`). */
  repoRoot?: string
}

export interface LockSummary {
  platform: PhiPlatform
  packageCount: number
  lockSha256: string
  lockPath: string
}

export async function lockEnvironment(options: LockEnvironmentOptions): Promise<LockSummary[]> {
  const repoRoot = options.repoRoot ?? defaultRepoRoot()
  const specPath = resolve(options.specPath)
  const parsed = parseEnvironmentSpec(readSpec(specPath))
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'))

  const platforms = options.platforms ?? PHI_PLATFORMS
  const outDir = resolve(options.outDir ?? join(dirname(specPath), 'locks'))
  mkdirSync(outDir, { recursive: true })
  const specLabel = repoRelative(specPath, repoRoot)

  const root = mkdtempSync(join(tmpdir(), 'phi-lock-env-'))
  try {
    ensureRuntimeLayout(root)
    writeMambarc(root)
    const summaries: LockSummary[] = []
    for (const platform of platforms) {
      const text = await solveExplicitLock({
        root,
        spec: parsed.spec,
        platform,
        condaOverrides: PLATFORM_BASELINES[platform],
        specPath: specLabel,
        log: (message) => console.error(message)
      })
      const validated = parseExplicitLock(text)
      if (!validated.ok) {
        throw new Error(`generated lock is invalid:\n${validated.errors.join('\n')}`)
      }
      const lockPath = join(outDir, `${platform}.txt`)
      writeFileSync(lockPath, text, 'utf8')
      summaries.push({
        platform,
        packageCount: validated.entries.length,
        lockSha256: lockSha256(text),
        lockPath
      })
    }
    return summaries
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function readSpec(specPath: string): string {
  try {
    return readFileSync(specPath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to read environment spec ${specPath}: ${message}`)
  }
}

function repoRelative(specPath: string, repoRoot: string): string {
  return relative(repoRoot, specPath).split(sep).join('/')
}

function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..')
}

function isPhiPlatform(value: string): value is PhiPlatform {
  for (const platform of PHI_PLATFORMS) {
    if (platform === value) return true
  }
  return false
}

const HEAD_ATTEMPTS = 3
const HEAD_CONCURRENCY = 16

export interface AnnotateLockOptions {
  fetch?: typeof fetch
  /** Defaults to 16. */
  concurrency?: number
  /** Sizes already known, keyed by the package URL without the md5 fragment. */
  cache?: Map<string, number>
  delay?: (ms: number) => Promise<void>
}

/** Insert or replace `# download-bytes:` after `# baseline:` without changing any other line. */
function downloadUrl(lockUrl: string): string {
  const hash = lockUrl.indexOf('#')
  return hash === -1 ? lockUrl : lockUrl.slice(0, hash)
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Math.max(1, Math.min(limit, items.length))
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await run(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}

async function headContentLength(
  url: string,
  fetchImpl: typeof fetch,
  wait: (ms: number) => Promise<void>
): Promise<number> {
  let lastError: unknown
  for (let attempt = 1; attempt <= HEAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' })
      if (!response.ok) throw new Error(`HEAD ${url} returned ${String(response.status)}`)
      const header = response.headers.get('content-length')
      if (header === null || !/^[0-9]+$/.test(header)) {
        throw new Error(`HEAD ${url} did not return Content-Length`)
      }
      const bytes = Number(header)
      if (!Number.isSafeInteger(bytes)) {
        throw new Error(`HEAD ${url} returned an invalid Content-Length`)
      }
      return bytes
    } catch (error) {
      lastError = error
      if (attempt < HEAD_ATTEMPTS) await wait(200 * attempt)
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`failed to read Content-Length for ${url}: ${message}`)
}

/** HEAD every package URL and insert `# download-bytes:`. A missing size throws; nothing is guessed. */
export async function annotateLockText(
  text: string,
  options: AnnotateLockOptions = {}
): Promise<string> {
  const parsed = parseExplicitLock(text)
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'))
  const fetchImpl = options.fetch ?? globalThis.fetch
  const wait = options.delay ?? delay
  const known = options.cache ?? new Map<string, number>()
  const urls = parsed.entries.map((entry) => downloadUrl(entry.url))
  const missing = [...new Set(urls)].filter((url) => !known.has(url))
  const fetched = await mapLimited(missing, options.concurrency ?? HEAD_CONCURRENCY, (url) =>
    headContentLength(url, fetchImpl, wait)
  )
  missing.forEach((url, index) => {
    const size = fetched[index]
    if (size === undefined) throw new Error(`missing size for ${url}`)
    known.set(url, size)
  })
  let total = 0
  for (const url of urls) {
    const size = known.get(url)
    if (size === undefined) throw new Error(`missing size for ${url}`)
    total += size
    if (!Number.isSafeInteger(total)) throw new Error('download size exceeds a safe integer')
  }
  return withDownloadBytes(text, total)
}

interface LockCliOptions {
  specPath?: string
  outDir?: string
  platforms: readonly PhiPlatform[]
  annotate: string[]
}

function parseArgs(argv: readonly string[]): LockCliOptions {
  let specPath: string | undefined
  let outDir: string | undefined
  const platforms: PhiPlatform[] = []
  const annotate: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--spec') {
      specPath = requireValue(argv, index, '--spec requires an environment.yml path')
      index += 1
      continue
    }
    if (arg === '--out') {
      outDir = requireValue(argv, index, '--out requires a directory')
      index += 1
      continue
    }
    if (arg === '--platform') {
      const consumed = takePlatforms(argv, index, platforms)
      if (consumed === 0) throw new Error('--platform requires a platform id')
      index += consumed
      continue
    }
    if (arg === '--annotate') {
      const consumed = takeAnnotatePaths(argv, index, annotate)
      if (consumed === 0) throw new Error('--annotate requires a lock path')
      index += consumed
      continue
    }
    throw new Error(`unknown argument ${arg}`)
  }

  if (annotate.length > 0 && (specPath || outDir || platforms.length > 0)) {
    throw new Error('--annotate cannot be combined with --spec, --out, or --platform')
  }
  if (annotate.length === 0 && !specPath) {
    throw new Error(
      'usage: lock-env.ts --spec <environment.yml> [--out <dir>] [--platform <id> ...] | --annotate <lock.txt> ...'
    )
  }
  return {
    specPath,
    outDir,
    platforms: platforms.length > 0 ? platforms : PHI_PLATFORMS,
    annotate
  }
}

function requireValue(argv: readonly string[], index: number, message: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(message)
  return value
}

function takePlatforms(argv: readonly string[], index: number, platforms: PhiPlatform[]): number {
  let consumed = 0
  while (index + 1 + consumed < argv.length) {
    const value = argv[index + 1 + consumed]
    if (!value || value.startsWith('--')) break
    if (!isPhiPlatform(value)) {
      throw new Error(`unknown platform: ${value} (expected ${PHI_PLATFORMS.join(', ')})`)
    }
    if (!platforms.includes(value)) platforms.push(value)
    consumed += 1
  }
  return consumed
}

function takeAnnotatePaths(argv: readonly string[], index: number, paths: string[]): number {
  let consumed = 0
  while (index + 1 + consumed < argv.length) {
    const value = argv[index + 1 + consumed]
    if (!value || value.startsWith('--')) break
    paths.push(value)
    consumed += 1
  }
  return consumed
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms)
  })
}

async function annotateLocks(paths: readonly string[]): Promise<void> {
  const cache = new Map<string, number>()
  for (const lockPath of paths) {
    const absolute = resolve(lockPath)
    const text = readFileSync(absolute, 'utf8')
    const next = await annotateLockText(text, { cache })
    if (next !== text) writeFileSync(absolute, next, 'utf8')
    const bytes = parseLockDownloadBytes(next)
    const parsed = parseExplicitLock(next)
    const count = parsed.ok ? parsed.entries.length : 0
    console.log(
      `${lockPath}: ${count} packages, download-bytes ${bytes === undefined ? 'unknown' : String(bytes)}`
    )
  }
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.annotate.length > 0) {
      await annotateLocks(options.annotate)
      return
    }
    if (!options.specPath) throw new Error('--spec requires an environment.yml path')
    const summaries = await lockEnvironment({
      specPath: options.specPath,
      ...(options.outDir ? { outDir: options.outDir } : {}),
      platforms: options.platforms
    })
    for (const summary of summaries) {
      console.log(
        `${summary.platform}: ${summary.packageCount} packages, lockSha256 ${summary.lockSha256.slice(0, 12)}`
      )
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

const entry = process.argv[1]
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) {
  void main()
}
