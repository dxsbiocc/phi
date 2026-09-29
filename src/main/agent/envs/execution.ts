import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import Ajv from 'ajv'

import { type EnvMetadata } from './contract'
import { envMetadataSchema } from './schemas'

export const EXECUTION_CONTRACT_VERSION = '1.0.0'

/** `{ envId, prefix, metadata }` as returned by `ensureEnvironment`. */
export interface EnvHandle {
  envId: string
  prefix: string
  metadata: EnvMetadata
}

export interface ExecutionOptions {
  /** Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv
  extraEnv?: Record<string, string>
  /** Defaults to `process.platform`. Selects the locale default only. */
  platform?: NodeJS.Platform
}

export interface RunOptions {
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
  stdin?: string
  /** Defaults to 1 MiB per stream. */
  maxOutputBytes?: number
  extraEnv?: Record<string, string>
  baseEnv?: NodeJS.ProcessEnv
}

export interface RunResult {
  envId: string
  argv: string[]
  resolvedCommand: string
  cwd: string
  exitCode: number | null
  signal: string | null
  terminated?: 'timeout' | 'aborted'
  stdout: string
  stderr: string
  truncated: { stdout: boolean; stderr: boolean }
  durationMs: number
}

// Host variables copied into a content process. Every `LC_*` is kept.
// Everything else is dropped, including PATH, PYTHON*, CONDA_*, MAMBA_*,
// R_*, JAVA_HOME, LD_*, and DYLD_*.
const KEPT_HOST_NAMES = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TERM',
  'TZ',
  'LANG',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'SSH_AUTH_SOCK'
])

const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const CACHE_DIRECTORIES = ['matplotlib', 'numba', 'xdg'] as const
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const KILL_GRACE_MS = 5000
const UTF8_LOCALE = /utf-?8/i

const ajv = new Ajv({ allErrors: true, strict: false })
const validateEnvMetadata = ajv.compile(envMetadataSchema)

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) return String(error.code)
  return undefined
}

function validationErrors(): string {
  return (validateEnvMetadata.errors ?? [])
    .map((error) => `${error.instancePath || '(root)'} ${error.message ?? 'is invalid'}`.trim())
    .join('; ')
}

function keptHostName(name: string): boolean {
  return name.startsWith('LC_') || KEPT_HOST_NAMES.has(name)
}

function forbiddenExtraName(name: string): boolean {
  return (
    name === 'PATH' ||
    name.startsWith('PYTHON') ||
    name.startsWith('R_') ||
    name.startsWith('CONDA_') ||
    name.startsWith('MAMBA_') ||
    name.startsWith('LD_') ||
    name.startsWith('DYLD_') ||
    name.startsWith('PHI_ENV_')
  )
}

function rejectExtraEnv(extra: Record<string, string> | undefined): void {
  if (!extra) return
  for (const name of Object.keys(extra)) {
    if (forbiddenExtraName(name)) throw new Error(`extraEnv cannot set ${name}`)
  }
}

/** Adds LC_ALL when the effective locale (LC_ALL, else LC_CTYPE, else LANG) is not UTF-8. */
function utf8LocaleEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  const effective = env.LC_ALL || env.LC_CTYPE || env.LANG || ''
  if (UTF8_LOCALE.test(effective)) return {}
  return { LC_ALL: platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8' }
}

function runtimeRoot(prefix: string): string {
  return dirname(dirname(prefix))
}

function isInsideDirectory(entry: string, directory: string): boolean {
  const relativePath = relative(directory, entry)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function environmentPath(prefix: string, metadata: EnvMetadata): string {
  const entries: string[] = []
  const seen = new Set<string>()
  const add = (entry: string): void => {
    if (entry.length === 0 || seen.has(entry)) return
    seen.add(entry)
    entries.push(entry)
  }
  // Only the environment's own directories. `micromamba run` also prepends the runtime's
  // `condabin`, which would expose micromamba itself to content if it ever existed.
  for (const entry of metadata.activation.pathPrepend) {
    if (isInsideDirectory(entry, prefix)) add(entry)
  }
  for (const executable of Object.values(metadata.host)) add(dirname(executable))
  for (const entry of SYSTEM_PATH) add(entry)
  return entries.join(':')
}

function isolationVariables(env: EnvHandle, cache: string): Record<string, string> {
  const library = join(env.prefix, 'lib', 'R', 'library')
  return {
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    R_LIBS_USER: library,
    R_LIBS_SITE: library,
    R_PROFILE_USER: '/dev/null',
    R_ENVIRON_USER: '/dev/null',
    MPLBACKEND: 'Agg',
    MPLCONFIGDIR: join(cache, 'matplotlib'),
    NUMBA_CACHE_DIR: join(cache, 'numba'),
    XDG_CACHE_HOME: join(cache, 'xdg'),
    PHI_ENV_ID: env.envId,
    PHI_ENV_PREFIX: env.prefix
  }
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function assertDirectory(cwd: string): void {
  let info: ReturnType<typeof statSync>
  try {
    info = statSync(cwd)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`cwd is not an existing directory: ${cwd}`)
    }
    throw error
  }
  if (!info.isDirectory()) throw new Error(`cwd is not an existing directory: ${cwd}`)
}

interface CapturedStream {
  push: (chunk: Buffer) => void
  end: () => void
  text: () => string
  wasTruncated: () => boolean
}

function captureStream(
  stream: 'stdout' | 'stderr',
  maxBytes: number,
  onOutput: RunOptions['onOutput']
): CapturedStream {
  const chunks: Buffer[] = []
  let bytes = 0
  let truncated = false
  const decoder = new StringDecoder('utf8')
  return {
    push(chunk: Buffer): void {
      const text = decoder.write(chunk)
      if (text.length > 0) onOutput?.({ stream, text })
      if (truncated) return
      const remaining = maxBytes - bytes
      if (chunk.length <= remaining) {
        if (chunk.length > 0) chunks.push(Buffer.from(chunk))
        bytes += chunk.length
        return
      }
      if (remaining > 0) chunks.push(Buffer.from(chunk.subarray(0, remaining)))
      bytes = maxBytes
      truncated = true
    },
    end(): void {
      const text = decoder.end()
      if (text.length > 0) onOutput?.({ stream, text })
    },
    text(): string {
      return Buffer.concat(chunks).toString('utf8')
    },
    wasTruncated(): boolean {
      return truncated
    }
  }
}

function spawnCommand(
  env: EnvHandle,
  argv: readonly string[],
  resolved: string,
  variables: Record<string, string>,
  options: RunOptions
): Promise<RunResult> {
  let child: ChildProcess
  try {
    // Own process group, so termination reaches grandchildren (R subprocesses, Nextflow
    // tasks) instead of leaving them running after the direct child exits.
    child = spawn(resolved, argv.slice(1), {
      cwd: options.cwd,
      env: variables,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to spawn ${resolved}: ${message}`)
  }

  const output = child.stdout
  const errors = child.stderr
  const input = child.stdin
  if (!output || !errors || !input) {
    child.kill('SIGKILL')
    throw new Error(`failed to spawn ${resolved}: stdio pipes were not created`)
  }

  const started = Date.now()
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const stdout = captureStream('stdout', maxBytes, options.onOutput)
  const stderr = captureStream('stderr', maxBytes, options.onOutput)

  return new Promise((resolveResult, reject) => {
    let settled = false
    let termination: 'timeout' | 'aborted' | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      child.kill('SIGKILL')
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      cleanup()
      try {
        stdout.end()
        stderr.end()
      } catch (error) {
        child.kill('SIGKILL')
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      const result: RunResult = {
        envId: env.envId,
        argv: [...argv],
        resolvedCommand: resolved,
        cwd: options.cwd,
        exitCode: termination ? null : code,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: { stdout: stdout.wasTruncated(), stderr: stderr.wasTruncated() },
        durationMs: Date.now() - started
      }
      if (termination) result.terminated = termination
      resolveResult(result)
    }

    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        child.kill(signal)
      }
    }
    const terminate = (reason: 'timeout' | 'aborted'): void => {
      if (settled || termination) return
      termination = reason
      signalGroup('SIGTERM')
      if (settled) return
      killTimer = setTimeout(() => {
        if (!settled) signalGroup('SIGKILL')
      }, KILL_GRACE_MS)
    }

    const onAbort = (): void => {
      terminate('aborted')
    }

    output.on('data', (chunk: Buffer) => {
      try {
        stdout.push(chunk)
      } catch (error) {
        fail(error)
      }
    })
    errors.on('data', (chunk: Buffer) => {
      try {
        stderr.push(chunk)
      } catch (error) {
        fail(error)
      }
    })
    input.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') return
    })
    child.on('error', (error: Error) => {
      if (termination || settled) return
      fail(new Error(`failed to spawn ${resolved}: ${error.message}`))
    })
    child.on('close', (code, signal) => {
      finish(code, signal)
    })

    if (options.stdin !== undefined) input.write(options.stdin)
    input.end()

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        terminate('timeout')
      }, options.timeoutMs)
    }
    if (options.signal) {
      if (options.signal.aborted) terminate('aborted')
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

export function sanitizeHostEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || !keptHostName(name)) continue
    env[name] = value
  }
  return env
}

/** `<root>/cache/<envId>`, with `matplotlib`, `numba`, and `xdg` created on demand. */
export function environmentCacheDir(root: string, envId: string): string {
  const cache = join(root, 'cache', envId)
  for (const name of CACHE_DIRECTORIES) mkdirSync(join(cache, name), { recursive: true })
  return cache
}

/** Delete `<root>/cache/<envId>`. `collectGarbage` should call this when it removes an environment. */
export function removeEnvironmentCache(root: string, envId: string): void {
  rmSync(join(root, 'cache', envId), { recursive: true, force: true })
}

export function environmentVariables(
  env: EnvHandle,
  options: ExecutionOptions = {}
): Record<string, string> {
  rejectExtraEnv(options.extraEnv)
  const variables = sanitizeHostEnvironment(options.baseEnv ?? process.env)
  for (const [name, value] of Object.entries(env.metadata.activation.set)) {
    variables[name] = value
  }
  const cache = environmentCacheDir(runtimeRoot(env.prefix), env.envId)
  for (const [name, value] of Object.entries(isolationVariables(env, cache))) {
    variables[name] = value
  }
  const locale = utf8LocaleEnv(variables, options.platform ?? process.platform)
  for (const [name, value] of Object.entries(locale)) variables[name] = value
  if (options.extraEnv) {
    for (const [name, value] of Object.entries(options.extraEnv)) variables[name] = value
  }
  variables.PATH = environmentPath(env.prefix, env.metadata)
  return variables
}

export function resolveCommand(command: string, pathValue: string): string | undefined {
  if (command.length === 0) return undefined
  if (isAbsolute(command) || command.includes('/')) {
    return isExecutableFile(command) ? resolve(command) : undefined
  }
  for (const directory of pathValue.split(':')) {
    if (directory.length === 0) continue
    const candidate = join(directory, command)
    if (isExecutableFile(candidate)) return resolve(candidate)
  }
  return undefined
}

export function loadEnvironment(root: string, envId: string): EnvHandle {
  const prefix = join(root, 'envs', envId)
  const file = join(prefix, '.phi', 'env.json')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
      throw new Error(`environment ${envId} metadata is missing: ${file}`)
    }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`environment ${envId} metadata is invalid JSON: ${message}`)
  }
  if (!validateEnvMetadata(parsed)) {
    const detail = validationErrors()
    throw new Error(
      detail
        ? `environment ${envId} metadata is invalid: ${detail}`
        : `environment ${envId} metadata is invalid`
    )
  }
  const metadata = parsed as unknown as EnvMetadata
  if (metadata.envId !== envId) {
    throw new Error(`environment ${envId} metadata is for ${metadata.envId}`)
  }
  if (metadata.status !== 'ready') {
    throw new Error(`environment ${envId} is not ready (status: ${metadata.status})`)
  }
  return { envId, prefix, metadata }
}

export async function runInEnvironment(
  env: EnvHandle,
  argv: readonly string[],
  options: RunOptions
): Promise<RunResult> {
  const command = argv[0]
  if (!command) throw new Error(`command not found in environment ${env.envId}: ${command ?? ''}`)
  assertDirectory(options.cwd)
  const variables = environmentVariables(env, {
    baseEnv: options.baseEnv,
    extraEnv: options.extraEnv
  })
  const resolved = resolveCommand(command, variables.PATH ?? '')
  if (!resolved) throw new Error(`command not found in environment ${env.envId}: ${command}`)
  return await spawnCommand(env, argv, resolved, variables, options)
}
