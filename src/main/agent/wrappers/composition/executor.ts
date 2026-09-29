import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import type { WrapperOutputRecord } from '../types'
import { buildResourceConfig, type WrapperRunResources } from './resources'
import { getActiveToolPath } from '../../environment'

/** Execution profile a wrapper can run under — see each `wrapper/nextflow.config`'s `profiles {}` block. */
export const WRAPPER_EXECUTION_PROFILES = ['docker', 'singularity', 'conda'] as const
export type WrapperExecutionProfile = (typeof WRAPPER_EXECUTION_PROFILES)[number]

/**
 * Runs the fixed smoke command from
 * docs/design/phi-wrapper-agent-composition-design.md section 5/7:
 * `nextflow run wrapper/main.nf -params-file wrapper/params.json`, with
 * agent-supplied overrides merged into the wrapper's own default params.
 */

function findExecutable(dir: string, name: string): string | undefined {
  const candidate = join(dir, name)
  return existsSync(candidate) ? candidate : undefined
}

function condaEnvBinCandidates(name: string): string[] {
  const envRoots = ['miniconda3', 'anaconda3', 'miniforge3'].map((d) => join(homedir(), d, 'envs'))
  const found: string[] = []
  for (const root of envRoots) {
    if (!existsSync(root)) continue
    let envNames: string[]
    try {
      envNames = readdirSync(root)
    } catch {
      continue
    }
    for (const envName of envNames) {
      const bin = findExecutable(join(root, envName, 'bin'), name)
      if (bin) found.push(bin)
    }
  }
  return found
}

/**
 * Electron apps don't reliably inherit a dev shell's PATH (conda-activated
 * envs in particular), so beyond `process.env.PATH` this also checks common
 * conda env locations. Preference order:
 * 1. `NEXTFLOW_BIN`
 * 2. Phi environment settings (`~/.phi/environment.json` active path)
 * 3. `which nextflow` / conda env bins
 */
export function findNextflowBinary(): string {
  if (process.env.NEXTFLOW_BIN && existsSync(process.env.NEXTFLOW_BIN)) {
    return process.env.NEXTFLOW_BIN
  }
  const configured = getActiveToolPath('nextflow')
  if (configured && existsSync(configured)) return configured
  try {
    const found = execFileSync('which', ['nextflow'], { encoding: 'utf-8' }).trim()
    if (found) return found
  } catch {
    // fall through to conda env search
  }
  const candidates = condaEnvBinCandidates('nextflow')
  if (candidates.length > 0) return candidates[0]
  throw new Error('未找到 Nextflow。请在设置 → 环境中指定路径，或设置 NEXTFLOW_BIN 环境变量。')
}

/**
 * If `binPath` lives inside a conda env (`.../<condaRoot>/envs/<name>/bin/<exe>`),
 * returns `<condaRoot>` — so callers can also put `<condaRoot>/condabin` and
 * `<condaRoot>/bin` on PATH. The `conda` executable itself lives there, not
 * inside the env's own `bin/`, which is where `-profile conda` needs it:
 * Nextflow shells out to `conda`/`mamba` to build/reuse each process's
 * `conda "${moduleDir}/environment.yml"` environment.
 */
function condaRootFromEnvBin(binPath: string): string | undefined {
  const parts = binPath.split(sep)
  const binIndex = parts.lastIndexOf('bin')
  if (binIndex >= 2 && parts[binIndex - 2] === 'envs') {
    return parts.slice(0, binIndex - 2).join(sep)
  }
  return undefined
}

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
 * Throws synchronously for an unknown profile or when no Nextflow can be found.
 */
export function startWrapperComposition(
  wrapperDir: string,
  overrides: Record<string, unknown>,
  profile: WrapperExecutionProfile = 'docker',
  options: StartWrapperOptions = {}
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

  const nextflowBin = findNextflowBinary()
  const defaultParams = JSON.parse(
    readFileSync(join(wrapperDir, 'params.json'), 'utf-8')
  ) as Record<string, unknown>
  const mergedParams = { ...defaultParams, ...overrides }

  const tmpDir = mkdtempSync(join(tmpdir(), 'phi-wrapper-run-'))
  const paramsFilePath = join(tmpDir, 'params.json')
  writeFileSync(paramsFilePath, JSON.stringify(mergedParams, null, 2))

  const componentDir = dirname(wrapperDir)
  const condaRoot = condaRootFromEnvBin(nextflowBin)
  const pathDirs = [
    dirname(nextflowBin),
    ...(condaRoot ? [join(condaRoot, 'condabin'), join(condaRoot, 'bin')] : [])
  ]
  const env = {
    ...process.env,
    PATH: `${pathDirs.join(':')}:${process.env.PATH ?? ''}`,
    // The launcher otherwise curls nextflow.io for a newer version, with no timeout.
    NXF_DISABLE_CHECK_LATEST: 'true'
  }

  const args = ['run', 'wrapper/main.nf', '-params-file', paramsFilePath, '-profile', profile]
  const resourceConfig = buildResourceConfig(options.resources)
  if (resourceConfig) {
    const configPath = join(tmpDir, 'resources.config')
    writeFileSync(configPath, resourceConfig)
    args.push('-c', configPath)
  }

  installExitHook()
  const child = spawn(nextflowBin, args, {
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
  options: RunWrapperOptions = {}
): Promise<WrapperRunResult> {
  return startWrapperComposition(wrapperDir, overrides, profile, options).done
}
