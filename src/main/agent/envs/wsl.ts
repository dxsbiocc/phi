import { execFile, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, posix, win32 } from 'node:path'
import { promisify } from 'node:util'

import { type PhiPlatform } from './platform'

export const WSL_LOCK_PLATFORM: PhiPlatform = 'linux-x64'

export type WslProbe =
  | { status: 'unsupported' }
  | { status: 'missing' }
  | { status: 'no-distro'; executable: string }
  | { status: 'distro-unavailable'; executable: string; distro: string }
  | { status: 'not-version-2'; executable: string; distro: string; version: number }
  | { status: 'ready'; executable: string; distro: string }

export type ReadyWsl = Extract<WslProbe, { status: 'ready' }>

export type WslListEntry = {
  distro: string
  state: string
  version: number
  default: boolean
}

export type WslExec = (executable: string, args: readonly string[]) => Buffer | string

const WSL_LIST_ROW = /^\s*(\*)?\s*(.+?)\s{2,}(.+?)\s+(\d+)\s*$/u
const WSL_COMPACT_LIST_ROW = /^\s*(\*)?\s*(\S+)\s+(\S+)\s+(\d+)\s*$/u
const WSL_INTERNAL_DISTROS = new Set(['docker-desktop', 'docker-desktop-data'])

export function usesWslEnvironment(
  hostPlatform: NodeJS.Platform,
  lockPlatform: PhiPlatform
): boolean {
  return hostPlatform === 'win32' && lockPlatform === WSL_LOCK_PLATFORM
}

function stripNuls(text: string): string {
  return text.split('\0').join('')
}

export function decodeWslOutput(output: Buffer | string): string {
  if (typeof output === 'string') return stripNuls(output)
  if (output.length >= 2 && output[0] === 0xff && output[1] === 0xfe) {
    return stripNuls(output.subarray(2).toString('utf16le'))
  }
  let nuls = 0
  for (const byte of output) if (byte === 0) nuls += 1
  if (output.length > 0 && nuls > output.length / 4) return stripNuls(output.toString('utf16le'))
  return stripNuls(output.toString('utf8'))
}

export function parseWslList(output: Buffer | string): WslListEntry[] {
  const text = decodeWslOutput(output).replace(/^\uFEFF/, '')
  const entries: WslListEntry[] = []
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trimEnd()
    const match = WSL_LIST_ROW.exec(line) ?? WSL_COMPACT_LIST_ROW.exec(line)
    if (!match) continue
    entries.push({
      default: match[1] === '*',
      distro: match[2],
      state: match[3],
      version: Number(match[4])
    })
  }
  return entries
}

export function defaultWslExecutable(systemRoot = process.env.SystemRoot || 'C:\\Windows'): string {
  return join(systemRoot, 'System32', 'wsl.exe')
}

export function wslProcessEnvironment(base = process.env): NodeJS.ProcessEnv {
  const system = ['systemroot', 'windir', 'userprofile', 'localappdata', 'temp', 'tmp']
  return Object.fromEntries(
    Object.entries(base).filter(([key]) => system.includes(key.toLowerCase()))
  )
}

export function defaultWslExec(
  executable: string,
  args: readonly string[],
  timeout = 8_000
): Buffer {
  return execFileSync(executable, [...args], {
    encoding: 'buffer',
    timeout,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: wslProcessEnvironment()
  }) as Buffer
}

const execWslAsync = promisify(execFile)

async function runWslAsync(
  executable: string,
  args: readonly string[],
  timeout = 8_000
): Promise<Buffer> {
  const { stdout } = await execWslAsync(executable, [...args], {
    encoding: 'buffer',
    timeout,
    windowsHide: true,
    env: wslProcessEnvironment()
  })
  return stdout
}

function distroUnavailable(executable: string, distro?: string): WslProbe {
  return distro
    ? { status: 'distro-unavailable', executable, distro }
    : { status: 'no-distro', executable }
}

function probeFailure(executable: string, distro: string | undefined, error: unknown): WslProbe {
  const result = error as { stdout?: Buffer | string; stderr?: Buffer | string } | null
  const diagnostic = decodeWslOutput(result?.stdout ?? '') + decodeWslOutput(result?.stderr ?? '')
  return /WSL_E_DISTRO_NOT_FOUND|wsl(?:\.exe)?\s+--list\s+--online/iu.test(diagnostic)
    ? distroUnavailable(executable, distro)
    : { status: 'missing' }
}

function selectDistribution(
  executable: string,
  output: Buffer | string,
  distro?: string
): WslProbe {
  const listed = parseWslList(output).filter(
    (entry) => !WSL_INTERNAL_DISTROS.has(entry.distro.toLowerCase())
  )
  const requested = distro?.toLowerCase()
  const selected = requested
    ? listed.find((entry) => entry.distro.toLowerCase() === requested)
    : (listed.find((entry) => entry.default && entry.version === 2) ??
      listed.find((entry) => entry.version === 2) ??
      listed[0])
  if (!selected) return distroUnavailable(executable, distro)
  if (selected.version !== 2) {
    return {
      status: 'not-version-2',
      executable,
      distro: selected.distro,
      version: selected.version
    }
  }
  return { status: 'ready', executable, distro: selected.distro }
}

export function probeWsl(
  options: {
    platform?: NodeJS.Platform
    executable?: string
    exec?: WslExec
    distro?: string
  } = {}
): WslProbe {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return { status: 'unsupported' }
  const executable = options.executable ?? defaultWslExecutable()
  if (!existsSync(executable)) return { status: 'missing' }
  try {
    const output = (options.exec ?? defaultWslExec)(executable, ['-l', '-v'])
    return selectDistribution(executable, output, options.distro)
  } catch (error) {
    return probeFailure(executable, options.distro, error)
  }
}

async function probeWslForBuild(distro?: string): Promise<WslProbe> {
  if (process.platform !== 'win32') return { status: 'unsupported' }
  const executable = defaultWslExecutable()
  try {
    return selectDistribution(executable, await runWslAsync(executable, ['-l', '-v']), distro)
  } catch (error) {
    return probeFailure(executable, distro, error)
  }
}

/** Check the saved distribution without starting it, staging tools, or writing runtime state. */
export function probeManagedWsl(root: string): Promise<WslProbe> {
  return probeWslForBuild(readWslRuntime(root)?.ready.distro)
}

export function wslRequiredMessage(probe: WslProbe): string {
  if (probe.status === 'missing' || probe.status === 'unsupported') {
    return 'WSL2 is not installed. Open an elevated PowerShell, run wsl --install, restart Windows, then build this environment.'
  }
  if (probe.status === 'no-distro') {
    return 'WSL2 has no Linux distribution. Run wsl --install -d Ubuntu, then build this environment.'
  }
  if (probe.status === 'not-version-2') {
    return `WSL distro ${probe.distro} is version ${probe.version}. Convert it with wsl --set-version ${probe.distro} 2, then build this environment.`
  }
  if (probe.status === 'distro-unavailable') {
    return `Phi's WSL distribution ${probe.distro} is unavailable. Restore that distribution to access its managed environments.`
  }
  return 'WSL2 is required to build and run this environment.'
}

export function requireReadyWsl(probe: WslProbe = probeWsl()): ReadyWsl {
  if (probe.status === 'ready') return probe
  throw new Error(wslRequiredMessage(probe))
}

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u
const WSL_UNC = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\(.*))?$/iu

export function looksLikeWindowsPath(value: string): boolean {
  return WINDOWS_DRIVE.test(value) || WSL_UNC.test(value)
}

export function wslArgument(value: string, ready: ReadyWsl): string {
  if (looksLikeWindowsPath(value) || value.startsWith('\\\\')) return toWslPath(ready, value)
  const flagValue = /^(--[A-Za-z0-9_-]+=)(.*)$/u.exec(value)
  if (flagValue && (looksLikeWindowsPath(flagValue[2]) || flagValue[2].startsWith('\\\\'))) {
    return `${flagValue[1]}${toWslPath(ready, flagValue[2])}`
  }
  return value
}

export function toLinuxPath(windowsPath: string, distro?: string): string {
  const normalized = windowsPath.replace(/\//g, '\\')
  const unc = WSL_UNC.exec(normalized)
  if (unc) {
    if (distro && unc[1].toLowerCase() !== distro.toLowerCase()) {
      throw new Error(`WSL path is for distro ${unc[1]}, not ${distro}`)
    }
    const rest = (unc[2] ?? '').replace(/\\/g, '/')
    return rest ? `/${rest}` : '/'
  }
  if (!WINDOWS_DRIVE.test(windowsPath) && windowsPath.startsWith('/')) return windowsPath
  const parsed = win32.parse(windowsPath)
  if (!parsed.root) return windowsPath.replace(/\\/g, '/')
  if (!WINDOWS_DRIVE.test(windowsPath)) {
    throw new Error(`WSL cannot access this Windows path directly: ${windowsPath}`)
  }
  const drive = parsed.root.slice(0, 1).toLowerCase()
  const rest = win32.relative(parsed.root, windowsPath).split(/[\\/]/u).filter(Boolean).join('/')
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`
}

/** Resolve a drive path through the chosen distribution so custom automounts are honored. */
export function toWslPath(ready: ReadyWsl, path: string): string {
  if (process.platform !== 'win32' || !WINDOWS_DRIVE.test(path)) {
    return toLinuxPath(path, ready.distro)
  }
  const output = defaultWslExec(ready.executable, [
    '-d',
    ready.distro,
    '--exec',
    '/usr/bin/wslpath',
    '-a',
    '-u',
    path
  ])
  const linuxPath = decodeWslOutput(output).replace(/\r?\n$/u, '')
  if (!linuxPath.startsWith('/')) throw new Error(`WSL could not map Windows path ${path}`)
  return linuxPath
}

export function toWindowsPath(linuxPath: string): string {
  const match = /^\/mnt\/([a-z])(?:\/(.*))?$/iu.exec(linuxPath)
  if (!match) return linuxPath
  return `${match[1].toUpperCase()}:\\${(match[2] ?? '').replace(/\//g, '\\')}`
}

export function toUncPath(distro: string, linuxPath: string): string {
  const relative = linuxPath.replace(/^\/+/u, '').replace(/\//g, '\\')
  return relative ? `\\\\wsl$\\${distro}\\${relative}` : `\\\\wsl$\\${distro}`
}

export function posixJoin(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/')
}

async function wslHome(ready: ReadyWsl): Promise<string> {
  const text = decodeWslOutput(
    await runWslAsync(ready.executable, [
      '-d',
      ready.distro,
      '--exec',
      '/bin/sh',
      '-c',
      'cd "$HOME" && pwd -P'
    ])
  ).trim()
  if (!text.startsWith('/')) {
    throw new Error(`WSL distro ${ready.distro} did not report a home directory.`)
  }
  return text
}

export type WslSpawnPlan = {
  executable: string
  args: string[]
}

export function wslSpawnArgv(
  ready: ReadyWsl,
  linuxExecutable: string,
  linuxArgs: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {}
): WslSpawnPlan {
  const args = ['-d', ready.distro]
  if (options.cwd) args.push('--cd', toLinuxPath(options.cwd, ready.distro))
  args.push('--exec')
  if (options.env) {
    args.push('/usr/bin/env', '-i', '--')
    for (const name of Object.keys(options.env).sort()) {
      args.push(`${name}=${translateEnvValue(ready.distro, name, options.env[name] ?? '')}`)
    }
  }
  args.push(linuxExecutable, ...linuxArgs)
  return { executable: ready.executable, args }
}

function translateEnvValue(distro: string, name: string, value: string): string {
  if (name === 'PATH' || name.endsWith('_PATH') || name === 'PYTHONPATH') {
    const windowsParts = value.split(';')
    const parts =
      windowsParts.length > 1 && windowsParts.some(looksLikeWindowsPath)
        ? windowsParts
        : (value.match(/(?:[A-Za-z]:[\\/])?[^:]+/gu) ?? [])
    return parts
      .map((entry) => (looksLikeWindowsPath(entry) ? toLinuxPath(entry, distro) : entry))
      .filter(Boolean)
      .join(':')
  }
  return looksLikeWindowsPath(value) ? toLinuxPath(value, distro) : value
}

export function wslUserRuntimeRoot(home: string): string {
  return posixJoin(home, '.phi', 'runtime')
}

export interface WslRuntime {
  ready: ReadyWsl
  linuxHome: string
  linuxRoot: string
  linuxMicromamba: string
}

function runtimeBindingPath(root: string): string {
  return join(root, 'state', 'wsl-runtime.json')
}

export function readWslRuntime(root: string): WslRuntime | undefined {
  let text: string
  try {
    text = readFileSync(runtimeBindingPath(root), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const binding = JSON.parse(text) as { distro?: unknown; home?: unknown } | null
  if (
    !binding ||
    typeof binding.distro !== 'string' ||
    !binding.distro ||
    /[\\/\0]/u.test(binding.distro) ||
    typeof binding.home !== 'string' ||
    !binding.home.startsWith('/') ||
    posix.normalize(binding.home) !== binding.home ||
    /[\\\r\n\0]/u.test(binding.home)
  ) {
    throw new Error('Phi’s saved WSL runtime location is invalid.')
  }
  const id = createHash('sha256')
    .update(win32.normalize(realpathSync(root)).toLowerCase())
    .digest('hex')
    .slice(0, 16)
  const linuxRoot = posixJoin(wslUserRuntimeRoot(binding.home), 'desktop', id)
  return {
    ready: { status: 'ready', executable: defaultWslExecutable(), distro: binding.distro },
    linuxHome: binding.home,
    linuxRoot,
    linuxMicromamba: posixJoin(linuxRoot, 'bin', 'micromamba')
  }
}

export async function bindWslRuntime(root: string, supplied?: ReadyWsl): Promise<WslRuntime> {
  const saved = readWslRuntime(root)
  const ready = supplied ?? requireReadyWsl(await probeWslForBuild(saved?.ready.distro))
  if (!saved) {
    const home = await wslHome(ready)
    mkdirSync(join(root, 'state'), { recursive: true })
    const target = runtimeBindingPath(root)
    const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ distro: ready.distro, home }), {
        flag: 'wx',
        mode: 0o600
      })
      linkSync(temporary, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  const binding = readWslRuntime(root)
  if (!binding || binding.ready.distro.toLowerCase() !== ready.distro.toLowerCase()) {
    throw new Error('The requested WSL distribution differs from Phi’s saved runtime distribution.')
  }
  return { ...binding, ready }
}

export function wslRuntimeDirectory(runtime: WslRuntime): string {
  return toUncPath(runtime.ready.distro, runtime.linuxRoot)
}

export function wslEnvironmentPrefix(runtime: WslRuntime, envId: string): string {
  if (!/^[a-z][a-z0-9-]*-[a-f0-9]{12}$/u.test(envId)) {
    throw new Error('Invalid managed WSL environment ID.')
  }
  return toUncPath(runtime.ready.distro, posixJoin(runtime.linuxRoot, 'envs', envId))
}

function wslRemoveArgs(runtime: WslRuntime, envId: string, removeCache: boolean): string[] {
  const { ready } = runtime
  const prefix = toLinuxPath(wslEnvironmentPrefix(runtime, envId), ready.distro)
  return [
    '-d',
    ready.distro,
    '--exec',
    '/bin/sh',
    '-ec',
    'for path do if [ -e "$path" ] || [ -L "$path" ]; then ' +
      'test "$(realpath -- "$path")" = "$path"; test -d "$path"; ' +
      'find "$path" -type d -exec chmod u+w -- {} +; rm -rf -- "$path"; fi; done',
    'phi-remove-environment',
    prefix,
    ...(removeCache ? [posixJoin(runtime.linuxRoot, 'cache', envId)] : [])
  ]
}

export function removeWslEnvironmentSync(runtime: WslRuntime, envId: string): void {
  defaultWslExec(runtime.ready.executable, wslRemoveArgs(runtime, envId, true), 120_000)
}

export async function removeWslEnvironment(
  runtime: WslRuntime,
  envId: string,
  removeCache = false
): Promise<void> {
  await runWslAsync(runtime.ready.executable, wslRemoveArgs(runtime, envId, removeCache), 120_000)
}

export async function lockWslEnvironment(runtime: WslRuntime, envId: string): Promise<void> {
  const { ready } = runtime
  const prefix = toLinuxPath(wslEnvironmentPrefix(runtime, envId), ready.distro)
  await runWslAsync(
    ready.executable,
    [
      '-d',
      ready.distro,
      '--exec',
      '/bin/sh',
      '-ec',
      'test "$(realpath -- "$1")" = "$1"; find "$1" \\( -type d -o -type f \\) ' +
        '-exec chmod a-w -- {} +',
      'phi-lock-environment',
      prefix
    ],
    120_000
  )
}

export async function stageWslRuntime(runtime: WslRuntime, windowsBinary: string): Promise<void> {
  const { ready, linuxHome, linuxRoot } = runtime
  const linuxBinary = WINDOWS_DRIVE.test(windowsBinary)
    ? decodeWslOutput(
        await runWslAsync(ready.executable, [
          '-d',
          ready.distro,
          '--exec',
          '/usr/bin/wslpath',
          '-a',
          '-u',
          windowsBinary
        ])
      ).replace(/\r?\n$/u, '')
    : toLinuxPath(windowsBinary, ready.distro)
  if (!linuxBinary.startsWith('/')) throw new Error('WSL could not locate the bundled micromamba.')
  await runWslAsync(
    ready.executable,
    [
      '-d',
      ready.distro,
      '--exec',
      '/bin/sh',
      '-ec',
      'umask 077; cd "$HOME"; test "$(pwd -P)" = "$1" || { echo "WSL default user home changed" >&2; exit 1; }; ' +
        'test "$(uname -m)" = x86_64 || { echo "WSL x86_64 is required" >&2; exit 1; }; ' +
        'case "$(stat -f -c %T .)" in 9p|drvfs|fuseblk) echo "WSL home must use a Linux filesystem" >&2; exit 1 ;; esac; shift; ' +
        'for part in .phi runtime desktop "$1"; do test ! -L "$part"; mkdir -p -- "$part"; cd "$part"; done; ' +
        'for part in bin envs pkgs home processes cache sources state state/tmp; do test ! -L "$part"; mkdir -p -- "$part"; done; ' +
        'if [ -L bin/micromamba ] || [ ! -x bin/micromamba ] || ! cmp -s -- "$2" bin/micromamba; then ' +
        'temp=$(mktemp bin/micromamba.XXXXXX); trap \'rm -f -- "$temp"\' EXIT; ' +
        'cp -- "$2" "$temp"; chmod 700 -- "$temp"; mv -fT -- "$temp" bin/micromamba; fi',
      'phi-stage-runtime',
      linuxHome,
      posix.basename(linuxRoot),
      linuxBinary
    ],
    30_000
  )
}
