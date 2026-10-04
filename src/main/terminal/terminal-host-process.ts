import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBunExecutable } from './terminal-bun'

function asarUnpackedPath(path: string): string {
  return path.includes('.asar/') ? path.replace('.asar/', '.asar.unpacked/') : path
}

export function resolveTerminalScript(
  fileName: string,
  explicitPath: string | undefined,
  envName: string
): string {
  if (explicitPath) return explicitPath
  const fromEnvironment = process.env[envName]
  if (fromEnvironment) return fromEnvironment

  const sourcePath = resolve(process.cwd(), 'src/main/terminal', fileName)
  if (existsSync(sourcePath)) return sourcePath

  const bundleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [join(bundleDir, fileName), join(bundleDir, 'terminal', fileName)]
  return pickTerminalScript(candidates, existsSync)
}

/**
 * Prefer the app.asar.unpacked copy: Electron's fs reports files inside app.asar as existing,
 * but Bun runs outside Electron and cannot read them.
 */
export function pickTerminalScript(
  candidates: readonly string[],
  exists: (path: string) => boolean
): string {
  for (const candidate of candidates) {
    const unpacked = asarUnpackedPath(candidate)
    if (unpacked !== candidate && exists(unpacked)) return unpacked
    if (exists(candidate)) return candidate
  }
  return candidates[candidates.length - 1]
}

function terminalChildEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG'] as const) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export function spawnBunProcess(scriptPath: string): ChildProcessWithoutNullStreams {
  const bunExecutable = resolveBunExecutable(process.env)
  return spawn(bunExecutable, [scriptPath], {
    cwd: process.cwd(),
    env: terminalChildEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe']
  })
}
