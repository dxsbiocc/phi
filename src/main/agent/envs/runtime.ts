import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { stringify } from 'yaml'

import { getPhiAgentDir } from '../runtime-paths'
import { getMicromambaPath } from './paths'
import { type PhiPlatform } from './platform'
import {
  posixJoin,
  requireReadyWsl,
  stageWslMicromamba,
  toLinuxPath,
  usesWslEnvironment,
  wslSpawnArgv,
  type ReadyWsl
} from './wsl'

import { errorMessage } from '../../../shared/errorCodes'
const RUNTIME_DIRECTORIES = ['envs', 'pkgs', 'logs', 'state', 'sources'] as const

// Parent variables copied into the micromamba child. LC_* is kept by prefix.
// Everything else is dropped, including CONDA_*, MAMBA_*, CONDARC, MAMBARC,
// PYTHONPATH, PYTHONHOME, VIRTUAL_ENV, R_*, LD_LIBRARY_PATH, and DYLD_*.
// PATH, MAMBA_ROOT_PREFIX, and MAMBA_NO_BANNER are assigned after the filter.
const KEPT_ENV_NAMES = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TERM',
  'LANG',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE'
])

const WINDOWS_KEPT_ENV_NAMES = new Set([
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'PATHEXT',
  'COMSPEC'
])

const UNIX_MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

export interface RuntimeLayout {
  root: string
  envs: string
  pkgs: string
  logs: string
  state: string
  sources: string
  mambarc: string
}

export interface RuntimeSettings {
  channelMirrors?: Record<string, string>
  proxy?: {
    http?: string
    https?: string
  }
}

export interface RunMicromambaOptions {
  root: string
  signal?: AbortSignal
  timeoutMs?: number
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
  /** Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv
  /** Defaults to `getMicromambaPath()`. Tests may pass a stub executable. */
  executable?: string
  /**
   * Virtual-package overrides for solving another platform (CONDA_OVERRIDE_GLIBC, …).
   * A macOS host has no glibc, so a linux-64 cross-solve needs `glibc` set.
   */
  condaOverrides?: CondaOverrides
  /** Windows hosts invoke linux-x64 micromamba through WSL2. */
  wsl?: {
    ready: import('./wsl').ReadyWsl
    linuxRoot: string
    linuxMicromamba: string
  }
}

export interface CondaOverrides {
  glibc?: string
  linux?: string
  osx?: string
  win?: string
}

export function getRuntimeRoot(agentDir = getPhiAgentDir()): string {
  return join(agentDir, 'runtime')
}

export function ensureRuntimeLayout(root: string): RuntimeLayout {
  const absoluteRoot = resolve(root)
  const layout: RuntimeLayout = {
    root: absoluteRoot,
    envs: join(absoluteRoot, 'envs'),
    pkgs: join(absoluteRoot, 'pkgs'),
    logs: join(absoluteRoot, 'logs'),
    state: join(absoluteRoot, 'state'),
    sources: join(absoluteRoot, 'sources'),
    mambarc: join(absoluteRoot, 'mambarc')
  }
  for (const name of RUNTIME_DIRECTORIES) {
    mkdirSync(layout[name], { recursive: true })
  }
  return layout
}

export function renderMambarc(root: string, settings: RuntimeSettings = {}): string {
  const document: Record<string, unknown> = {
    channels: ['conda-forge', 'bioconda'],
    channel_priority: 'strict',
    pkgs_dirs: [join(root, 'pkgs')],
    envs_dirs: [join(root, 'envs')]
  }
  const mirrors = mirroredChannels(settings.channelMirrors)
  if (mirrors) document.mirrored_channels = mirrors
  const proxy = proxyServers(settings.proxy)
  if (proxy) document.proxy_servers = proxy
  return stringify(document, { lineWidth: 0 })
}

export function withWsl(
  options: RunMicromambaOptions,
  wsl: RunMicromambaOptions['wsl']
): RunMicromambaOptions {
  return wsl ? { ...options, wsl } : options
}

export function prepareWslMicromambaRun(input: {
  hostPlatform?: NodeJS.Platform
  platform: PhiPlatform
  root: string
  settings?: RuntimeSettings
  wsl?: ReadyWsl
}): RunMicromambaOptions['wsl'] {
  if (!usesWslEnvironment(input.hostPlatform ?? process.platform, input.platform)) return undefined
  const ready = input.wsl ?? requireReadyWsl()
  mkdirSync(join(input.root, 'pkgs-linux-x64'), { recursive: true })
  const linuxRoot = toLinuxPath(input.root, ready.distro)
  writeLinuxMambarc(input.root, linuxRoot, input.settings)
  return {
    ready,
    linuxRoot,
    linuxMicromamba: stageWslMicromamba(ready, getMicromambaPath('linux-x64'))
  }
}

export function writeLinuxMambarc(
  root: string,
  linuxRoot: string,
  settings: RuntimeSettings = {}
): boolean {
  const document: Record<string, unknown> = {
    channels: ['conda-forge', 'bioconda'],
    channel_priority: 'strict',
    pkgs_dirs: [posixJoin(linuxRoot, 'pkgs-linux-x64')],
    envs_dirs: [posixJoin(linuxRoot, 'envs')]
  }
  const mirrors = mirroredChannels(settings.channelMirrors)
  if (mirrors) document.mirrored_channels = mirrors
  const proxy = proxyServers(settings.proxy)
  if (proxy) document.proxy_servers = proxy
  const content = stringify(document, { lineWidth: 0 })
  const target = join(root, 'mambarc.linux-x64')
  if (readTextIfExists(target) === content) return false
  const temporary = join(
    root,
    `.mambarc.linux.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  )
  try {
    writeFileSync(temporary, content, 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // writeFileSync may have failed before the temp file existed.
    }
    throw error
  }
  return true
}

export function writeMambarc(root: string, settings: RuntimeSettings = {}): boolean {
  const content = renderMambarc(root, settings)
  const target = join(root, 'mambarc')
  if (readTextIfExists(target) === content) return false

  const temporary = join(root, `.mambarc.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temporary, content, 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // writeFileSync may have failed before the temp file existed.
    }
    throw error
  }
  return true
}

/**
 * Write the default mambarc only when none exists. Maintenance commands (list, clean)
 * use this so they never replace the mirrors and proxy the app configured.
 */
export function ensureMambarc(root: string): void {
  if (readTextIfExists(join(root, 'mambarc')) !== undefined) return
  writeMambarc(root)
}

function windowsSystemRoot(base: NodeJS.ProcessEnv): string {
  return base.SystemRoot || base.windir || 'C:\\Windows'
}

function minimalPath(platform: NodeJS.Platform, base: NodeJS.ProcessEnv): string {
  if (platform !== 'win32') return UNIX_MINIMAL_PATH
  const systemRoot = windowsSystemRoot(base)
  return [join(systemRoot, 'System32'), systemRoot].join(';')
}

export function micromambaEnvironment(
  root: string,
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || !keptEnvName(name, platform)) continue
    env[name] = value
  }
  env.PATH = minimalPath(platform, base)
  env.MAMBA_ROOT_PREFIX = root
  env.MAMBA_NO_BANNER = '1'
  // micromamba keeps per-user state under $HOME (for example the `micromamba run` process
  // registry in ~/.cache/mamba/proc). Give it a home inside the runtime root so Phi never
  // shares or writes the user's mamba/conda state. Content processes are unaffected: they
  // are started through `environmentVariables`, which keeps the real HOME. The activation
  // snapshot is unaffected too: it diffs against this same environment.
  const home = micromambaHome(root)
  env.HOME = home
  if (platform === 'win32') {
    env.USERPROFILE = home
    env.SystemRoot = windowsSystemRoot(base)
    env.windir = base.windir || env.SystemRoot
    env.TEMP = base.TEMP || join(home, 'Temp')
    env.TMP = base.TMP || env.TEMP
  }
  return env
}

/** The HOME micromamba runs with; created on demand by `spawnMicromamba`. */
export function micromambaHome(root: string): string {
  return join(root, 'home')
}

export async function runMicromamba(
  args: readonly string[],
  options: RunMicromambaOptions
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const executable = options.executable ?? getMicromambaPath()
  const child = spawnMicromamba(executable, args, options)
  const stdoutStream = child.stdout
  const stderrStream = child.stderr
  if (!stdoutStream || !stderrStream) {
    child.kill('SIGKILL')
    throw new Error(`Failed to spawn micromamba at ${executable}: stdio pipes were not created`)
  }
  stdoutStream.setEncoding('utf8')
  stderrStream.setEncoding('utf8')

  return await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let killed = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', kill)
    }

    const finish = (error: Error | undefined, code: number | null): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve({ code, stdout, stderr })
    }

    const kill = (): void => {
      if (settled || killed) return
      killed = true
      child.kill('SIGKILL')
    }

    const append = (stream: 'stdout' | 'stderr', text: string): void => {
      if (stream === 'stdout') stdout += text
      else stderr += text
      options.onOutput?.({ stream, text })
    }

    stdoutStream.on('data', (chunk: string | Buffer) => {
      append('stdout', chunk.toString())
    })
    stderrStream.on('data', (chunk: string | Buffer) => {
      append('stderr', chunk.toString())
    })

    child.on('error', (error: Error) => {
      if (killed) {
        finish(undefined, null)
        return
      }
      finish(new Error(`Failed to spawn micromamba at ${executable}: ${error.message}`), null)
    })

    child.on('close', (code) => {
      finish(undefined, killed ? null : code)
    })

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(kill, options.timeoutMs)
    }
    if (options.signal) {
      options.signal.addEventListener('abort', kill, { once: true })
      if (options.signal.aborted) kill()
    }
  })
}

const VERSION = /^[0-9]+(\.[0-9]+){0,3}$/

function condaOverrideVariables(overrides: CondaOverrides | undefined): Record<string, string> {
  const variables: Record<string, string> = {}
  if (!overrides) return variables
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue
    if (!VERSION.test(value)) throw new Error(`invalid conda override ${key}=${value}`)
    variables[`CONDA_OVERRIDE_${key.toUpperCase()}`] = value
  }
  return variables
}

function keptEnvName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return (
    name.startsWith('LC_') ||
    KEPT_ENV_NAMES.has(name) ||
    (platform === 'win32' && WINDOWS_KEPT_ENV_NAMES.has(name))
  )
}

function mirroredChannels(
  mirrors: Record<string, string> | undefined
): Record<string, string[]> | undefined {
  if (!mirrors) return undefined
  const channels = Object.keys(mirrors).sort()
  if (channels.length === 0) return undefined
  const rendered: Record<string, string[]> = {}
  for (const channel of channels) rendered[channel] = [mirrors[channel]]
  return rendered
}

function proxyServers(proxy: RuntimeSettings['proxy']): Record<string, string> | undefined {
  if (!proxy) return undefined
  const rendered: Record<string, string> = {}
  if (proxy.http) rendered.http = proxy.http
  if (proxy.https) rendered.https = proxy.https
  return Object.keys(rendered).length > 0 ? rendered : undefined
}

function readTextIfExists(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

// micromamba 2.9.0 flags, verified with `micromamba --help` and `micromamba config --help`:
//   --rc-file FILE       use this configuration file
//   --root-prefix PATH   root prefix (`-r`)
//   --no-env             do not load configuration from the environment
// `--no-rc` exists but cannot be combined with `--rc-file`: 2.9.0 aborts with
// "Configuration files disabled by 'no_rc'". `--rc-file` replaces the user rc search,
// so `~/.condarc` and `~/.mambarc` are not loaded (`config sources` lists only this file).
function micromambaInvocationArgs(root: string, args: readonly string[], posix = false): string[] {
  const rcFile = posix ? posixJoin(root, 'mambarc.linux-x64') : join(root, 'mambarc')
  return ['--rc-file', rcFile, '--no-env', '--root-prefix', root, ...args]
}

function spawnMicromamba(
  executable: string,
  args: readonly string[],
  options: RunMicromambaOptions
): ReturnType<typeof spawn> {
  try {
    mkdirSync(micromambaHome(options.root), { recursive: true })
    if (options.wsl) {
      const linuxHome = posixJoin(options.wsl.linuxRoot, 'home')
      const plan = wslSpawnArgv(
        options.wsl.ready,
        options.wsl.linuxMicromamba,
        micromambaInvocationArgs(options.wsl.linuxRoot, args, true),
        {
          cwd: options.wsl.linuxRoot,
          env: {
            HOME: linuxHome,
            PATH: UNIX_MINIMAL_PATH,
            MAMBA_ROOT_PREFIX: options.wsl.linuxRoot,
            MAMBA_NO_BANNER: '1',
            ...condaOverrideVariables(options.condaOverrides)
          }
        }
      )
      return spawn(plan.executable, plan.args, {
        cwd: options.root,
        env: process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    }
    return spawn(executable, micromambaInvocationArgs(options.root, args), {
      cwd: options.root,
      env: {
        ...micromambaEnvironment(options.root, options.baseEnv ?? process.env),
        ...condaOverrideVariables(options.condaOverrides)
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    const message = errorMessage(error)
    throw new Error(`Failed to spawn micromamba at ${executable}: ${message}`)
  }
}
