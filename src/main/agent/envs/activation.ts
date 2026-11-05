import { win32 } from 'node:path'

import {
  micromambaEnvironment,
  normalizeWindowsEnvironment,
  runMicromamba,
  type RunMicromambaOptions
} from './runtime'
import { toLinuxPath, toWindowsPath } from './wsl'

/** Same minimal PATH assigned by `micromambaEnvironment`. */
const MINIMAL_SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

// Windows PowerShell is part of the supported Windows x64 installation. Use a fixed encoded
// command to avoid cmd.exe quoting and emit UTF-8 JSON so Unicode and multiline values survive.
const WINDOWS_ENV_FRAME = 'PHI_ACTIVATION_ENV='
const WINDOWS_ENV_PROBE = Buffer.from(
  "$ErrorActionPreference = 'Stop'\n" +
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n' +
    `[Console]::WriteLine('${WINDOWS_ENV_FRAME}' + (ConvertTo-Json -Compress -InputObject ([Environment]::GetEnvironmentVariables())))`,
  'utf16le'
).toString('base64')
// Cold Windows runners have taken over 30 seconds to activate a freshly installed
// prefix and start PowerShell, even though the same prefix works on subsequent runs.
const ACTIVATION_TIMEOUT_MS = 120_000

const EXCLUDED_NAMES = new Set([
  'PATH',
  'SHLVL',
  'PWD',
  'OLDPWD',
  '_',
  'CONDA_SHLVL',
  'CONDA_PROMPT_MODIFIER',
  'CONDA_EXE',
  'PS1'
])

export interface ActivationSnapshot {
  set: Record<string, string>
  pathPrepend: string[]
}

function excludedName(name: string): boolean {
  return EXCLUDED_NAMES.has(name) || name.startsWith('MAMBA_')
}

/** Preserve the activation order before micromamba's isolated system PATH. */
function pathEntriesBeforeMinimal(pathValue: string, minimalPath?: string): string[] {
  const entries = pathValue.split(minimalPath ? ';' : ':')
  const comparable = minimalPath ? entries.map(windowsPathKey) : entries
  const system = minimalPath ? minimalPath.split(';').map(windowsPathKey) : MINIMAL_SYSTEM_PATH
  const width = system.length
  for (let index = 0; index <= entries.length - width; index += 1) {
    const matches = system.every((entry, offset) => comparable[index + offset] === entry)
    if (matches) return entries.slice(0, index).filter((entry) => entry.length > 0)
  }
  return []
}

function windowsPathKey(path: string): string {
  return win32.normalize(path).replace(/\\+$/u, '').toLowerCase()
}

/**
 * Diff an activated environment against the sanitised base `runMicromamba` passes.
 * `set` contains variables that are new or changed. `PATH` and shell/conda noise are dropped.
 * `CONDA_PREFIX` and `activate.d` variables such as `JAVA_HOME` are kept.
 */
export function diffActivation(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  platform?: NodeJS.Platform
): ActivationSnapshot {
  if (platform === 'win32') {
    before = normalizeWindowsEnvironment(before)
    after = normalizeWindowsEnvironment(after)
  }
  const set: Record<string, string> = {}
  for (const [name, value] of Object.entries(after)) {
    if (excludedName(name) || before[name] === value) continue
    if (platform === 'win32' && name === 'PSMODULEPATH') continue
    set[name] = value
  }
  return {
    set,
    pathPrepend: pathEntriesBeforeMinimal(
      after.PATH ?? '',
      platform === 'win32' ? before.PATH : undefined
    )
  }
}

function parseNulEnvironment(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of text.split('\0')) {
    if (entry.length === 0) continue
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    env[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return env
}

function parseWindowsEnvironment(text: string): Record<string, string> {
  // Activation hooks may write other lines. Only consume the probe's framed payload.
  const frame = text.split(/\r?\n/u).findLast((line) => line.startsWith(WINDOWS_ENV_FRAME))
  try {
    const env = JSON.parse(frame?.slice(WINDOWS_ENV_FRAME.length) ?? '') as unknown
    if (!env || typeof env !== 'object' || Array.isArray(env))
      throw new Error('invalid environment')
    if (Object.values(env).some((value) => typeof value !== 'string')) {
      throw new Error('invalid environment value')
    }
    return env as Record<string, string>
  } catch {
    // The snapshot can contain proxy credentials, so never include the raw payload in errors.
    throw new Error('failed to decode the Windows activation environment')
  }
}

function windowsProbeArgs(systemRoot: string): string[] {
  return [
    win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    WINDOWS_ENV_PROBE
  ]
}

function activationOutput(
  result: Awaited<ReturnType<typeof runMicromamba>>,
  windows: boolean,
  signal?: AbortSignal
): string {
  if (signal?.aborted) throw new Error('environment build aborted')
  if (result.code === null) {
    throw new Error(
      windows ? 'Windows activation probe timed out or was terminated' : 'environment build aborted'
    )
  }
  if (result.code === 0) return result.stdout
  const detail = result.stderr.trim() || (windows ? '' : result.stdout.trim())
  const label = `failed to capture activation (${result.code})`
  throw new Error(detail ? `${label}: ${detail.split('\n')[0]}` : label)
}

export async function captureActivation(
  root: string,
  prefix: string,
  signal?: AbortSignal,
  wsl?: RunMicromambaOptions['wsl'],
  options: { platform?: NodeJS.Platform; run?: typeof runMicromamba } = {}
): Promise<ActivationSnapshot> {
  const platform = wsl ? 'linux' : (options.platform ?? process.platform)
  const before = micromambaEnvironment(root, process.env, platform)
  const runPrefix = wsl ? toLinuxPath(prefix, wsl.ready.distro) : prefix
  const windows = platform === 'win32'
  const probe = windows ? windowsProbeArgs(before.SystemRoot) : ['/usr/bin/env', '-0']
  const result = await (options.run ?? runMicromamba)(['run', '-p', runPrefix, ...probe], {
    root,
    signal,
    ...(windows ? { timeoutMs: ACTIVATION_TIMEOUT_MS } : {}),
    ...(wsl ? { wsl } : {})
  })
  const stdout = activationOutput(result, windows, signal)
  const after = windows ? parseWindowsEnvironment(stdout) : parseNulEnvironment(stdout)
  const snapshot = diffActivation(before, after, platform)
  if (!snapshot.set.CONDA_PREFIX) {
    throw new Error('activation snapshot is missing CONDA_PREFIX')
  }
  if (!wsl) return snapshot
  return {
    set: Object.fromEntries(
      Object.entries(snapshot.set).map(([name, value]) => [name, toWindowsPath(value)])
    ),
    pathPrepend: snapshot.pathPrepend.map((entry) => toWindowsPath(entry))
  }
}
