import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
    const unpacked = asarUnpackedPath(candidate)
    if (existsSync(unpacked)) return unpacked
  }
  return candidates[1]
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
  return spawn('bun', [scriptPath], {
    cwd: process.cwd(),
    env: terminalChildEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe']
  })
}
