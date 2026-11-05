import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, win32 } from 'node:path'

import { type PhiPlatform } from './platform'

export const WSL_LOCK_PLATFORM: PhiPlatform = 'linux-x64'

export type WslProbe =
  | { status: 'unsupported' }
  | { status: 'missing' }
  | { status: 'no-distro'; executable: string }
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

const WSL_LIST_ROW = /^\s*(\*)?\s*(\S+)\s+(\S+)\s+(\d+)\s*$/u

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
    const match = WSL_LIST_ROW.exec(line)
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

function defaultWslExec(executable: string, args: readonly string[]): Buffer {
  return execFileSync(executable, [...args], {
    encoding: 'buffer',
    timeout: 8_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }) as Buffer
}

export function probeWsl(
  options: {
    platform?: NodeJS.Platform
    executable?: string
    exec?: WslExec
  } = {}
): WslProbe {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return { status: 'unsupported' }
  const executable = options.executable ?? defaultWslExecutable()
  if (!existsSync(executable)) return { status: 'missing' }
  let listed: WslListEntry[]
  try {
    listed = parseWslList((options.exec ?? defaultWslExec)(executable, ['-l', '-v']))
  } catch {
    return { status: 'missing' }
  }
  if (listed.length === 0) return { status: 'no-distro', executable }
  const selected = listed.find((entry) => entry.default) ?? listed[0]
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
  return 'WSL2 is required to build and run this environment.'
}

export function requireReadyWsl(probe: WslProbe = probeWsl()): ReadyWsl {
  if (probe.status === 'ready') return probe
  throw new Error(wslRequiredMessage(probe))
}

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u
const WSL_UNC = /^\\\\wsl\$\\([^\\]+)(?:\\(.*))?$/iu

export function looksLikeWindowsPath(value: string): boolean {
  return WINDOWS_DRIVE.test(value) || WSL_UNC.test(value)
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
  const drive = parsed.root.slice(0, 1).toLowerCase()
  const rest = win32.relative(parsed.root, windowsPath).split(/[\\/]/u).filter(Boolean).join('/')
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`
}

export function toWindowsPath(linuxPath: string): string {
  const match = /^\/mnt\/([a-z])\/(.*)$/iu.exec(linuxPath)
  if (!match) return linuxPath
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`
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

export function wslHome(ready: ReadyWsl, exec: WslExec = defaultWslExec): string {
  const text = decodeWslOutput(
    exec(ready.executable, ['-d', ready.distro, '--', 'sh', '-c', 'printf %s "$HOME"'])
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
  args.push('--')
  if (options.env && Object.keys(options.env).length > 0) {
    args.push('env')
    for (const name of Object.keys(options.env).sort()) {
      args.push(`${name}=${translateEnvValue(ready.distro, name, options.env[name] ?? '')}`)
    }
  }
  args.push(linuxExecutable, ...linuxArgs)
  return { executable: ready.executable, args }
}

function translateEnvValue(distro: string, name: string, value: string): string {
  if (name === 'PATH' || name.endsWith('PATH')) {
    const parts = value.includes(';') ? value.split(';') : value.split(':')
    return parts
      .map((entry) => (looksLikeWindowsPath(entry) ? toLinuxPath(entry, distro) : entry))
      .filter(Boolean)
      .join(':')
  }
  return looksLikeWindowsPath(value) ? toLinuxPath(value, distro) : value
}

/** Linux micromamba lives on the WSL ext4 filesystem so the NTFS execute bit is not required. */
export function wslMicromambaPath(home: string): string {
  return posixJoin(home, '.phi', 'runtime', 'bin', 'micromamba')
}

export function wslUserRuntimeRoot(home: string): string {
  return posixJoin(home, '.phi', 'runtime')
}

export function stageWslMicromamba(
  ready: ReadyWsl,
  windowsBinary: string,
  exec: WslExec = defaultWslExec
): string {
  const home = wslHome(ready, exec)
  const linuxPath = wslMicromambaPath(home)
  const directory = posixJoin(home, '.phi', 'runtime', 'bin')
  exec(ready.executable, ['-d', ready.distro, '--', 'mkdir', '-p', directory])
  exec(ready.executable, [
    '-d',
    ready.distro,
    '--',
    'cp',
    toLinuxPath(windowsBinary, ready.distro),
    linuxPath
  ])
  exec(ready.executable, ['-d', ready.distro, '--', 'chmod', '+x', linuxPath])
  return linuxPath
}
