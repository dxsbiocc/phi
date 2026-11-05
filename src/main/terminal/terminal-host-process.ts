import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  externalWorkerPath,
  findExternalWorkerScript,
  sourceCheckoutPath
} from '../source-checkout-path'
import { resolveBunExecutable } from './terminal-bun'

export function resolveTerminalScript(
  fileName: string,
  explicitPath: string | undefined,
  envName: string
): string {
  if (explicitPath) return explicitPath
  const fromEnvironment = process.env[envName]
  if (fromEnvironment) return fromEnvironment

  const bundleDir = dirname(fileURLToPath(import.meta.url))
  const sourcePath = sourceCheckoutPath(`src/main/terminal/${fileName}`, bundleDir)
  if (sourcePath) return sourcePath

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
  return findExternalWorkerScript(candidates, exists) ?? externalWorkerPath(candidates.at(-1) ?? '')
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
  const resourcesPath = process.resourcesPath
  const bunExecutable = resolveBunExecutable(process.env, undefined, {
    resourcesPath: typeof resourcesPath === 'string' ? resourcesPath : undefined
  })
  return spawn(bunExecutable, [scriptPath], {
    cwd: process.cwd(),
    env: terminalChildEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe']
  })
}
