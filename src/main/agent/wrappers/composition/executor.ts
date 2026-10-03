import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { WrapperOutputRecord } from '../types'
import { prepareNextflowProfile } from './conda-profile'
import {
  resolveNextflowLaunch,
  type NextflowLaunch,
  type NextflowLaunchContext
} from './nextflow-launch'
import { buildResourceConfig, type WrapperRunResources } from './resources'

/** Execution profile a wrapper can run under — see each `wrapper/nextflow.config`'s `profiles {}` block. */
export const WRAPPER_EXECUTION_PROFILES = ['docker', 'singularity', 'conda'] as const
export type WrapperExecutionProfile = (typeof WRAPPER_EXECUTION_PROFILES)[number]

/**
 * Runs the fixed smoke command from
 * docs/design/phi-wrapper-agent-composition-design.md section 5/7:
 * `nextflow run wrapper/main.nf -params-file wrapper/params.json`, with
 * agent-supplied overrides merged into the wrapper's own default params.
 *
 * Which `nextflow` runs, and with which environment, is decided by
 * `resolveNextflowLaunch` (managed `phi:nextflow@1` by default, an explicitly chosen
 * host nextflow otherwise). The host PATH is never searched.
 */

export interface WrapperRunResult {
  success: boolean
  /** True when the run was stopped through `signal`; `success` is then false. */
  cancelled?: boolean
  exitCode: number
  /** Combined, tail-truncated stdout+stderr — enough to explain success/failure, not the full log. */
  output: string
  /** Remote runs only: contact was lost, so the true outcome is unknown (the run may still be going). */
  lost?: boolean
  /** Remote runs only: Phi stopped watching but left the run going on the cluster. */
  detached?: boolean
  /** Remote runs only: outputs as found on the cluster (a local `existsSync` cannot see them). */
  remote?: { outputs: WrapperOutputRecord[]; missingOutputs: string[] }
}

export interface RunWrapperOptions {
  /** Aborting stops Nextflow: SIGTERM to its whole process group, SIGKILL after `killGraceMs`. */
  signal?: AbortSignal
  killGraceMs?: number
}

export interface StartWrapperOptions extends RunWrapperOptions {
  /** Called with each chunk of Nextflow's combined stdout/stderr as it arrives. */
  onOutput?: (chunk: string) => void
  /** Overrides the wrapper's own cpus/memory/time for every process of this run. */
  resources?: WrapperRunResources
  /** The `nextflow` to spawn and its environment, from `resolveNextflowLaunch`. */
  launch: NextflowLaunch
}

export interface RunWrapperCompositionOptions extends RunWrapperOptions {
  /** Resolved with `resolveNextflowLaunch` when absent. */
  launch?: NextflowLaunch
  /** Passed to `resolveNextflowLaunch` when `launch` is absent. */
  launchContext?: Omit<NextflowLaunchContext, 'profile' | 'signal'>
}

/** A running (or already finished) Nextflow process. */
export interface WrapperProcess {
  pid: number | undefined
  /** Resolves once Nextflow has exited. Never rejects. */
  done: Promise<WrapperRunResult>
  /** Stops Nextflow (SIGTERM to its process group, SIGKILL after the grace period). Idempotent. */
  cancel: () => void
  /**
   * Remote runs only: stop watching without stopping the run, which carries on on the
   * cluster. `done` then resolves with `detached: true`. Absent for local runs, which
   * cannot outlive the app.
   */
  detach?: () => void
}

const DEFAULT_KILL_GRACE_MS = 10_000
const MAX_BUFFERED_OUTPUT = 64 * 1024

// Nextflow runs in its own process group so a cancel reaches java, the launcher
// script and anything they spawned. Live groups are tracked so quitting the app
// cannot leave an orphaned pipeline behind.
const activeGroups = new Set<number>()
let exitHookInstalled = false

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  } catch {
    // Already gone.
  }
}

/** SIGTERM every live Nextflow process group. Called on app quit; also runs on process exit. */
export function killAllWrapperProcesses(): void {
  for (const pid of activeGroups) signalGroup(pid, 'SIGTERM')
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', killAllWrapperProcesses)
}

/**
 * Starts Nextflow for `wrapperDir` and returns immediately. `wrapperDir` is the
 * `wrapper/` adapter directory (containing wrapper.yaml/main.nf/params.json);
 * Nextflow is launched with cwd set to its parent (the module/subworkflow
 * root), matching the fixed command's own relative path (`wrapper/main.nf`).
 * Throws synchronously for an unknown profile, or for the conda profile when the
 * bundled micromamba is missing.
 */
export function startWrapperComposition(
  wrapperDir: string,
  overrides: Record<string, unknown>,
  profile: WrapperExecutionProfile = 'docker',
  options: StartWrapperOptions
): WrapperProcess {
  if (!WRAPPER_EXECUTION_PROFILES.includes(profile)) {
    throw new Error(
      `Unknown execution profile: ${profile}. Must be one of ${WRAPPER_EXECUTION_PROFILES.join(', ')}.`
    )
  }
  const { signal } = options
  if (signal?.aborted) {
    return {
      pid: undefined,
      done: Promise.resolve({ success: false, cancelled: true, exitCode: -1, output: '' }),
      cancel: () => undefined
    }
  }

  const { launch } = options
  // Built before anything is written, so a missing micromamba throws with nothing to clean up.
  const preparedProfile = prepareNextflowProfile(profile, launch.runtimeRoot, launch.env)
  const defaultParams = JSON.parse(
    readFileSync(join(wrapperDir, 'params.json'), 'utf-8')
  ) as Record<string, unknown>
  const mergedParams = { ...defaultParams, ...overrides }

  const tmpDir = mkdtempSync(join(tmpdir(), 'phi-wrapper-run-'))
  const paramsFilePath = join(tmpDir, 'params.json')
  writeFileSync(paramsFilePath, JSON.stringify(mergedParams, null, 2))

  const componentDir = dirname(wrapperDir)
  // The launch env already sets NXF_DISABLE_CHECK_LATEST: the launcher otherwise curls
  // nextflow.io for a newer version, with no timeout.
  const env = preparedProfile.env

  const args = ['run', 'wrapper/main.nf', '-params-file', paramsFilePath, '-profile', profile]
  if (preparedProfile.config) {
    const configPath = join(tmpDir, 'conda.config')
    writeFileSync(configPath, preparedProfile.config)
    args.push('-c', configPath)
  }
  const resourceConfig = buildResourceConfig(options.resources)
  if (resourceConfig) {
    const configPath = join(tmpDir, 'resources.config')
    writeFileSync(configPath, resourceConfig)
    args.push('-c', configPath)
  }

  installExitHook()
  const child = spawn(launch.command, args, {
    cwd: componentDir,
    env,
    detached: process.platform !== 'win32'
  })
  const pid = child.pid
  if (pid !== undefined) activeGroups.add(pid)

  let combined = ''
  let cancelled = false
  let killTimer: NodeJS.Timeout | undefined

  const cancel = (): void => {
    if (cancelled) return
    cancelled = true
    if (pid === undefined) return
    signalGroup(pid, 'SIGTERM')
    killTimer = setTimeout(
      () => signalGroup(pid, 'SIGKILL'),
      options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    )
    killTimer.unref()
  }
  signal?.addEventListener('abort', cancel, { once: true })

  const done = new Promise<WrapperRunResult>((resolve) => {
    const settle = (exitCode: number): void => {
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', cancel)
      if (pid !== undefined) activeGroups.delete(pid)
      rmSync(tmpDir, { recursive: true, force: true })
      resolve({
        success: exitCode === 0 && !cancelled,
        ...(cancelled ? { cancelled: true } : {}),
        exitCode,
        output: combined.length > 4000 ? combined.slice(-4000) : combined
      })
    }
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf-8')
      combined = (combined + text).slice(-MAX_BUFFERED_OUTPUT)
      options.onOutput?.(text)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('close', (code) => settle(code ?? -1))
    child.on('error', (error) => {
      combined += String(error)
      settle(-1)
    })
  })

  return { pid, done, cancel }
}

/** Blocking form of {@link startWrapperComposition}: resolves when Nextflow exits. */
export async function runWrapperComposition(
  wrapperDir: string,
  overrides: Record<string, unknown>,
  profile: WrapperExecutionProfile = 'docker',
  options: RunWrapperCompositionOptions = {}
): Promise<WrapperRunResult> {
  if (options.signal?.aborted) {
    return { success: false, cancelled: true, exitCode: -1, output: '' }
  }
  let launch = options.launch
  if (!launch) {
    const resolved = await resolveNextflowLaunch({
      ...options.launchContext,
      profile,
      ...(options.signal ? { signal: options.signal } : {})
    })
    if (!resolved.ok) return { success: false, exitCode: -1, output: resolved.error }
    launch = resolved.launch
  }
  const { signal, killGraceMs } = options
  return startWrapperComposition(wrapperDir, overrides, profile, {
    launch,
    ...(signal ? { signal } : {}),
    ...(killGraceMs !== undefined ? { killGraceMs } : {})
  }).done
}
