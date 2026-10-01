import {
  chmodSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type WriteStream
} from 'node:fs'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'

import Ajv from 'ajv'

import { captureActivation } from './activation'
import {
  ENVIRONMENT_CONTRACT_VERSION,
  computeEnvId,
  currentPlatform,
  lockSha256,
  parseExplicitLock,
  type EnvKind,
  type EnvMetadata,
  type EnvScope,
  type EnvironmentSpec,
  type PhiPlatform,
  type SourcePackage
} from './contract'
import { probeHostRequirements } from './host'
import { acquireEnvironmentLock, acquirePackageCacheLock, type EnvironmentLock } from './lock'
import { updateEnvironmentEntry } from './index-store'
import { ensureRuntimeLayout, runMicromamba, writeMambarc, type RuntimeSettings } from './runtime'
import { envMetadataSchema } from './schemas'
import { createSourcePackageInstaller } from './source-packages'

const ajv = new Ajv({ allErrors: true, strict: false })
const validateEnvMetadata = ajv.compile(envMetadataSchema)

const inflight = new Map<string, Promise<EnsureEnvironmentResult>>()

export type EnsureProgressPhase =
  'check' | 'wait' | 'create' | 'source-packages' | 'activation' | 'finalize' | 'done' | 'failed'

export interface EnsureProgressEvent {
  phase: EnsureProgressPhase
  message: string
}

export type SourcePackageInstaller = (
  prefix: string,
  packages: SourcePackage[]
) => Promise<void> | void

export interface EnsureEnvironmentInput {
  root: string
  scope: EnvScope
  owner?: string
  kind: EnvKind
  spec: EnvironmentSpec
  lockText: string
  platform?: PhiPlatform
  settings?: RuntimeSettings
  signal?: AbortSignal
  onProgress?: (event: EnsureProgressEvent) => void
  sourcePackageInstaller?: SourcePackageInstaller
}

export interface EnsureEnvironmentResult {
  envId: string
  prefix: string
  metadata: EnvMetadata
  created: boolean
  hostMissing: string[]
}

interface PreparedEnvironment {
  key: string
  root: string
  envId: string
  prefix: string
  platform: PhiPlatform
  lockDigest: string
  ready?: EnsureEnvironmentResult
}

export interface LinkScriptFailure {
  action: 'pre-link' | 'post-link' | 'pre-unlink'
  packageName: string
  detail: string
}

const LINK_SCRIPT_START =
  /^\s*warning\s+libmamba\s+Executing (pre-link|post-link|pre-unlink) script for package '([^']+)'\.\s*$/
const LIBMAMBA_LOG_LINE = /^\s*(?:trace|debug|info|warning|error|critical)\s+libmamba\b/
const SCRIPT_FAILURE_PATTERNS = [
  /:\s*line \d+:\s*(.+?: command not found)\s*$/,
  /:\s*line \d+:\s*(.+?: Permission denied)\s*$/,
  /(.+?: syntax error(?: near unexpected token.*)?)\s*$/,
  /(.+?: unbound variable)\s*$/,
  /(.+?: Bad substitution)\s*$/,
  /(.+? is not recognized as an internal or external command.*)\s*$/,
  /(The system cannot find the (?:file|path) specified\.?)\s*$/i
]

// "No such file or directory" is deliberately not a failure: scripts commonly remove or
// probe paths that may be absent and carry on.
/**
 * micromamba 2.9.0 logs link-script execution but can still exit zero when the
 * script's shell exits nonzero. Keep detection scoped to output following that
 * marker so unrelated transaction warnings remain warnings.
 */
export function linkScriptFailureFromOutput(output: string): LinkScriptFailure | undefined {
  let active: Omit<LinkScriptFailure, 'detail'> | undefined
  for (const line of output.split(/\r?\n/)) {
    const started = line.match(LINK_SCRIPT_START)
    if (started) {
      active = {
        action: started[1] as LinkScriptFailure['action'],
        packageName: started[2]
      }
      continue
    }
    if (!active) continue
    if (LIBMAMBA_LOG_LINE.test(line)) {
      active = undefined
      continue
    }
    for (const pattern of SCRIPT_FAILURE_PATTERNS) {
      const failure = line.match(pattern)
      if (failure) return { ...active, detail: failure[1].trim() }
    }
  }
  return undefined
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) return String(error.code)
  return undefined
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const line = message.split('\n')[0] ?? message
  return line.length > 300 ? `${line.slice(0, 297)}...` : line
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('environment build aborted')
}

function validationErrors(): string {
  return (validateEnvMetadata.errors ?? [])
    .map((error) => `${error.instancePath || '(root)'} ${error.message ?? 'is invalid'}`.trim())
    .join('; ')
}

function readReadyMetadata(prefix: string, lockDigest: string): EnvMetadata | undefined {
  let text: string
  try {
    text = readFileSync(join(prefix, '.phi', 'env.json'), 'utf8')
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  if (!validateEnvMetadata(parsed)) return undefined
  const metadata = parsed as unknown as EnvMetadata
  if (metadata.status !== 'ready' || metadata.lockSha256 !== lockDigest) return undefined
  return metadata
}

function readyResult(
  prepared: Pick<PreparedEnvironment, 'envId' | 'prefix' | 'platform'>,
  metadata: EnvMetadata,
  spec: EnvironmentSpec
): EnsureEnvironmentResult {
  const host = probeHostRequirements(spec.host, prepared.platform)
  return {
    envId: prepared.envId,
    prefix: prepared.prefix,
    metadata,
    created: false,
    hostMissing: host.missing
  }
}

function prepare(input: EnsureEnvironmentInput): PreparedEnvironment {
  const layout = ensureRuntimeLayout(input.root)
  const root = realpathSync(layout.root)
  writeMambarc(root, input.settings)
  const parsedLock = parseExplicitLock(input.lockText)
  if (!parsedLock.ok) {
    throw new Error(`invalid explicit lock: ${parsedLock.errors.join('; ')}`)
  }
  const platform = input.platform ?? currentPlatform()
  const envId = computeEnvId({
    scope: input.scope,
    owner: input.owner,
    name: input.spec.name,
    platform,
    lockText: input.lockText,
    sourcePackages: input.spec.sourcePackages
  })
  const prefix = join(root, 'envs', envId)
  const lockDigest = lockSha256(input.lockText)
  input.onProgress?.({ phase: 'check', message: `checking ${envId}` })
  const metadata = readReadyMetadata(prefix, lockDigest)
  const prepared: PreparedEnvironment = {
    key: `${root}\0${envId}`,
    root,
    envId,
    prefix,
    platform,
    lockDigest
  }
  if (metadata) {
    prepared.ready = readyResult(prepared, metadata, input.spec)
    input.onProgress?.({ phase: 'done', message: `${envId} is ready` })
  }
  return prepared
}

/**
 * Delete a tree whose directories may be read-only. Only directories get owner write back:
 * unlinking a file needs a writable parent, not a writable file. Files are never chmod'ed
 * here because environment files are hard links into the shared package cache; restoring
 * write on them would make the same files writable in every other environment.
 */
export function removeTree(target: string): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(target)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  if (!stat.isSymbolicLink()) grantOwnerWrite(target)
  rmSync(target, { recursive: true, force: true })
}

function grantOwnerWrite(target: string): void {
  const stat = lstatSync(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return
  if ((stat.mode & 0o200) === 0) chmodSync(target, (stat.mode & 0o777) | 0o200)
  for (const name of readdirSync(target)) grantOwnerWrite(join(target, name))
}

function makeTreeReadOnly(target: string): void {
  const stat = lstatSync(target)
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    for (const name of readdirSync(target)) makeTreeReadOnly(join(target, name))
  }
  const mode = stat.mode & 0o777
  const next = mode & ~0o222
  if (next !== mode) chmodSync(target, next)
}

function cloneSourcePackages(packages: SourcePackage[] | undefined): SourcePackage[] {
  return (packages ?? []).map((pkg) => {
    const clone: SourcePackage = {
      language: pkg.language,
      name: pkg.name,
      source: pkg.source,
      ref: pkg.ref,
      sha256: pkg.sha256
    }
    if (pkg.repo !== undefined) clone.repo = pkg.repo
    return clone
  })
}

function logStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

async function closeLog(stream: WriteStream): Promise<void> {
  try {
    await finished(stream.end())
  } catch {
    // A build failure is more useful than a log-stream close error.
  }
}

async function createFromLock(
  input: EnsureEnvironmentInput,
  prepared: PreparedEnvironment
): Promise<void> {
  mkdirSync(join(prepared.root, 'state', 'tmp'), { recursive: true })
  const lockFile = join(prepared.root, 'state', 'tmp', `${prepared.envId}.lock.txt`)
  writeFileSync(lockFile, input.lockText, 'utf8')
  const logPath = join(prepared.root, 'logs', `${prepared.envId}-${logStamp()}.log`)
  const logStream = createWriteStream(logPath)
  input.onProgress?.({ phase: 'create', message: 'micromamba create' })
  try {
    throwIfAborted(input.signal)
    const cacheLock = await acquirePackageCacheLock({
      root: prepared.root,
      signal: input.signal,
      onWait: () => {
        input.onProgress?.({ phase: 'wait', message: 'waiting for the package cache' })
      }
    })
    let result: Awaited<ReturnType<typeof runMicromamba>>
    try {
      // micromamba 2.9.0: create --yes -p <prefix> -f <explicit lock>
      result = await runMicromamba(['create', '--yes', '-p', prepared.prefix, '-f', lockFile], {
        root: prepared.root,
        signal: input.signal,
        onOutput: (chunk) => {
          logStream.write(chunk.text)
          if (chunk.text.length > 0) input.onProgress?.({ phase: 'create', message: chunk.text })
        }
      })
    } finally {
      cacheLock.release()
    }
    if (input.signal?.aborted || result.code === null) throw new Error('environment build aborted')
    const scriptFailure =
      linkScriptFailureFromOutput(result.stderr) ?? linkScriptFailureFromOutput(result.stdout)
    if (scriptFailure) {
      throw new Error(
        `micromamba ${scriptFailure.action} script failed for package '${scriptFailure.packageName}': ${scriptFailure.detail}`
      )
    }
    if (result.code !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim()).split('\n')[0]
      throw new Error(
        detail
          ? `micromamba create failed (${result.code}): ${detail}`
          : `micromamba create failed (${result.code})`
      )
    }
  } finally {
    await closeLog(logStream)
    try {
      unlinkSync(lockFile)
    } catch {
      // Already gone; nothing to clean up.
    }
  }
}

/**
 * Precompile Python bytecode while the prefix is still writable. Once it is read-only,
 * Python cannot cache .pyc files and would recompile every import on every run.
 */
async function precompilePython(input: EnsureEnvironmentInput, prefix: string): Promise<void> {
  if (!existsSync(join(prefix, 'bin', 'python'))) return
  const libDir = join(prefix, 'lib')
  const sitePackages = readdirSync(libDir)
    .filter((name) => /^python3\.\d+$/.test(name))
    .map((name) => join(libDir, name, 'site-packages'))
    .filter((dir) => existsSync(dir))
  if (sitePackages.length === 0) return
  input.onProgress?.({ phase: 'finalize', message: 'precompiling Python bytecode' })
  const result = await runMicromamba(
    ['run', '-p', prefix, 'python', '-m', 'compileall', '-q', '-j', '0', ...sitePackages],
    { root: input.root, signal: input.signal }
  )
  if (input.signal?.aborted || result.code === null) throw new Error('environment build aborted')
  // compileall exits 1 when some file fails to compile (e.g. test fixtures with invalid
  // syntax shipped by a package); that is not a reason to fail the environment.
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`python bytecode precompilation failed (${result.code})`)
  }
}

async function installSourcePackages(
  input: EnsureEnvironmentInput,
  root: string,
  prefix: string
): Promise<void> {
  const packages = input.spec.sourcePackages ?? []
  if (packages.length === 0) return
  input.onProgress?.({
    phase: 'source-packages',
    message: `installing ${packages.length} source package(s)`
  })
  const installer =
    input.sourcePackageInstaller ??
    createSourcePackageInstaller({
      root,
      signal: input.signal,
      onProgress: input.onProgress
    })
  throwIfAborted(input.signal)
  await installer(prefix, packages)
  throwIfAborted(input.signal)
}

async function micromambaVersion(root: string, signal: AbortSignal | undefined): Promise<string> {
  const result = await runMicromamba(['--version'], { root, signal })
  if (signal?.aborted || result.code === null) throw new Error('environment build aborted')
  if (result.code !== 0) throw new Error(`micromamba --version failed (${result.code})`)
  const version = result.stdout.trim().split(/\s+/).pop() ?? ''
  if (!version) throw new Error('micromamba --version returned no version')
  return version
}

function writeEnvMetadata(prefix: string, metadata: EnvMetadata): void {
  if (!validateEnvMetadata(metadata)) {
    throw new Error(`env.json failed validation: ${validationErrors() || 'invalid metadata'}`)
  }
  const directory = join(prefix, '.phi')
  mkdirSync(directory, { recursive: true })
  const target = join(directory, 'env.json')
  const temporary = join(directory, `.env.${process.pid}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  try {
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temp file may already have been renamed.
    }
    throw error
  }
}

function markEntry(
  input: EnsureEnvironmentInput,
  prepared: PreparedEnvironment,
  status: 'building' | 'ready' | 'failed',
  error?: string
): void {
  updateEnvironmentEntry(prepared.root, prepared.envId, {
    name: input.spec.name,
    kind: input.kind,
    platform: prepared.platform,
    prefix: prepared.prefix,
    status,
    lockSha256: prepared.lockDigest,
    updatedAt: new Date().toISOString(),
    error: status === 'failed' ? (error ?? 'environment build failed') : null
  })
}

async function failBuild(
  input: EnsureEnvironmentInput,
  prepared: PreparedEnvironment,
  error: unknown
): Promise<never> {
  let reported = error
  try {
    removeTree(prepared.prefix)
  } catch (removeError) {
    reported = new Error(
      `${shortError(error)}; failed to remove prefix: ${shortError(removeError)}`
    )
  }
  try {
    markEntry(input, prepared, 'failed', shortError(reported))
  } catch {
    // The original build error is the one to surface.
  }
  input.onProgress?.({ phase: 'failed', message: shortError(reported) })
  throw reported instanceof Error ? reported : new Error(shortError(reported))
}

async function runBuild(
  input: EnsureEnvironmentInput,
  prepared: PreparedEnvironment
): Promise<EnsureEnvironmentResult> {
  let lock: EnvironmentLock | undefined
  let building = false
  try {
    lock = await acquireEnvironmentLock({
      root: prepared.root,
      envId: prepared.envId,
      signal: input.signal,
      onWait: () => {
        input.onProgress?.({
          phase: 'wait',
          message: `waiting for ${prepared.envId}`
        })
      }
    })
    const ready = readReadyMetadata(prepared.prefix, prepared.lockDigest)
    if (ready) {
      const result = readyResult(prepared, ready, input.spec)
      input.onProgress?.({ phase: 'done', message: `${prepared.envId} is ready` })
      return result
    }

    building = true
    markEntry(input, prepared, 'building')
    if (existsSync(prepared.prefix)) removeTree(prepared.prefix)
    await createFromLock(input, prepared)
    await installSourcePackages(input, prepared.root, prepared.prefix)
    await precompilePython(input, prepared.prefix)

    input.onProgress?.({ phase: 'activation', message: 'capturing activation' })
    const activation = await captureActivation(prepared.root, prepared.prefix, input.signal)
    const host = probeHostRequirements(input.spec.host, prepared.platform)
    input.onProgress?.({ phase: 'finalize', message: 'writing environment metadata' })
    const version = await micromambaVersion(prepared.root, input.signal)
    const metadata: EnvMetadata = {
      envId: prepared.envId,
      name: input.spec.name,
      kind: input.kind,
      platform: prepared.platform,
      lockSha256: prepared.lockDigest,
      createdAt: new Date().toISOString(),
      micromambaVersion: version,
      activation,
      host: host.found,
      sourcePackages: cloneSourcePackages(input.spec.sourcePackages),
      status: 'ready',
      contractVersion: ENVIRONMENT_CONTRACT_VERSION
    }
    writeEnvMetadata(prepared.prefix, metadata)
    makeTreeReadOnly(prepared.prefix)
    markEntry(input, prepared, 'ready')
    input.onProgress?.({ phase: 'done', message: `${prepared.envId} is ready` })
    return {
      envId: prepared.envId,
      prefix: prepared.prefix,
      metadata,
      created: true,
      hostMissing: host.missing
    }
  } catch (error) {
    if (!building) throw error
    return await failBuild(input, prepared, error)
  } finally {
    lock?.release()
  }
}

export { acquireEnvironmentLock, type EnvironmentLock } from './lock'

export function ensureEnvironment(input: EnsureEnvironmentInput): Promise<EnsureEnvironmentResult> {
  let prepared: PreparedEnvironment
  try {
    prepared = prepare(input)
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
  if (prepared.ready) return Promise.resolve(prepared.ready)
  const existing = inflight.get(prepared.key)
  if (existing) {
    input.onProgress?.({ phase: 'wait', message: `waiting for ${prepared.envId}` })
    return existing
  }
  const promise = runBuild(input, prepared).finally(() => {
    inflight.delete(prepared.key)
  })
  inflight.set(prepared.key, promise)
  return promise
}
