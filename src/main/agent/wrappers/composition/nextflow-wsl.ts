import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { posix } from 'node:path'

import { looksLikeWindowsPath, toWslPath, wslSpawnArgv, type WslRuntime } from '../../envs/wsl'
import { wslProcessSupervisorArgs } from '../../envs/wsl-process-supervisor'

const activeWslProcesses = new Set<() => void>()

export function stopWslNextflowProcesses(): void {
  for (const stop of activeWslProcesses) stop()
}

/** Close the ownership pipe; the supervisor sends TERM and escalates to KILL in Linux. */
export function trackWslNextflowProcess(child: ChildProcess): () => void {
  const stdin = child.stdin
  if (!stdin) throw new Error('WSL2 Nextflow requires a process ownership pipe')
  const stop = (): void => {
    if (!stdin.writableEnded && !stdin.destroyed) stdin.end()
  }
  stdin.on('error', () => undefined)
  activeWslProcesses.add(stop)
  child.once('close', () => activeWslProcesses.delete(stop))
  return stop
}

export function wslNextflowParams(
  params: Record<string, unknown>,
  pathParams: Iterable<string>,
  mapPath: (path: string) => string
): Record<string, unknown> {
  const mapped = { ...params }
  for (const key of pathParams) {
    const value = mapped[key]
    if (typeof value !== 'string') continue
    if (!looksLikeWindowsPath(value) && /^[a-z][a-z0-9+.-]+:\/\//iu.test(value)) continue
    mapped[key] = mapPath(value)
  }
  return mapped
}

export function wslNextflowProcess(
  wsl: WslRuntime,
  input: {
    command: string
    args: readonly string[]
    env: Record<string, string>
    cwd: string
    graceMs: number
  },
  mapPath = (path: string): string => toWslPath(wsl.ready, path)
): { executable: string; args: string[] } {
  const distro = wsl.ready.distro
  const args = input.args.map((arg) =>
    looksLikeWindowsPath(arg) || arg.startsWith('\\\\') ? mapPath(arg) : arg
  )
  // WSL's native filesystem supports the symlinks and Unix permissions needed by
  // Nextflow tasks. Keep these work files like normal Nextflow runs, for inspection.
  const workDir = posix.join(wsl.linuxRoot, 'nextflow-work', randomUUID())
  const python = posix.join(posix.dirname(input.command), 'python')
  return wslSpawnArgv(
    wsl.ready,
    python,
    wslProcessSupervisorArgs([input.command, ...args, '-work-dir', workDir], {
      distro,
      graceMs: input.graceMs
    }),
    { cwd: mapPath(input.cwd), env: input.env }
  )
}
