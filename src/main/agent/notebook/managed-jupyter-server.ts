// The notebook's Jupyter server defaults to `phi:jupyter@1` (roadmap 5.3). An explicitly
// configured host Jupyter path may override it; automatic PATH detection never does.

import { mkdirSync } from 'node:fs'

import type { ConfirmBuildRequest } from '../content/environment-gate'
import { ensureEnvironmentReady } from '../content/environment-gate'
import type { EnvironmentBuilds } from '../content/environment-builds'
import {
  environmentVariables,
  getRuntimeRoot,
  prefixExecutable,
  sanitizeHostEnvironment,
  type EnvHandle
} from '../envs'
import { normalizeWindowsEnvironment, windowsSystemPath } from '../envs/runtime'
import { DEFAULT_KERNEL_NAME, JUPYTER_ENVIRONMENT_REF } from './analysis-kernels'
import {
  describeManagedEnvironment,
  jupyterDirectoryVariables,
  managedKernelsDir,
  syncManagedKernels,
  type ManagedEnvironmentContext
} from './managed-kernels'

/** Same shape as `JupyterServerLaunch` in `analysis-jupyter-server.ts`. */
export interface ManagedJupyterLaunch {
  port: number
  command?: string
  /** The base `jupyter` arguments (`jupyterServerArgs`); the kernel arguments are appended. */
  args?: string[]
  env?: Record<string, string>
}

export interface ManagedJupyterOptions extends Partial<ManagedEnvironmentContext> {
  builds?: EnvironmentBuilds
  confirmBuild?: (request: ConfirmBuildRequest) => Promise<boolean>
  /** Needed for the build prompt; without it only an already running build is joined. */
  runtimeSessionId?: string
  signal?: AbortSignal
  /** Explicit user-selected host Jupyter. Automatic detection remains informational only. */
  hostJupyterPath?: () => string | undefined
}

/** The gate said no: not built, declined, failed, or aborted. The message is the gate's. */
export class JupyterEnvironmentNotReadyError extends Error {
  readonly envId?: string

  constructor(message: string, envId?: string) {
    super(message)
    this.name = 'JupyterEnvironmentNotReadyError'
    if (envId) this.envId = envId
  }
}

/** Arguments that confine kernel discovery to Phi's kernel directory. */
export function managedKernelArgs(root: string): string[] {
  return [
    `--KernelSpecManager.kernel_dirs=${managedKernelsDir(root)}`,
    '--KernelSpecManager.ensure_native_kernel=False',
    `--MultiKernelManager.default_kernel_name=${DEFAULT_KERNEL_NAME}`
  ]
}

/** The launch for a ready `phi:jupyter@1`: its own `jupyter`, its variables, Phi's kernels. */
export function managedJupyterLaunch(
  handle: EnvHandle,
  launch: ManagedJupyterLaunch,
  ctx: ManagedEnvironmentContext
): Required<ManagedJupyterLaunch> {
  const directories = jupyterDirectoryVariables(ctx.root)
  for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true })
  const platform = ctx.hostPlatform ?? process.platform
  const env = environmentVariables(handle, {
    ...(ctx.baseEnv ? { baseEnv: ctx.baseEnv } : {}),
    platform,
    extraEnv: directories
  })
  const args = launch.args ?? []
  const kernelArgs = managedKernelArgs(ctx.root)
  if (platform === 'win32') {
    // Own the actual server process. The jupyter.exe dispatcher can leave its server running
    // after Windows terminates the dispatcher.
    const serverArgs = args[0] === 'server' ? args.slice(1) : args
    return {
      port: launch.port,
      command: prefixExecutable(handle.prefix, 'python', platform),
      args: ['-m', 'jupyter_server', ...serverArgs, ...kernelArgs],
      env
    }
  }
  return {
    port: launch.port,
    command: prefixExecutable(handle.prefix, 'jupyter', platform),
    args: [...args, ...kernelArgs],
    env
  }
}

/** A user-selected host Jupyter with Phi-owned state directories and kernel discovery. */
export function hostJupyterLaunch(
  command: string,
  launch: ManagedJupyterLaunch,
  ctx: ManagedEnvironmentContext
): Required<ManagedJupyterLaunch> {
  const directories = jupyterDirectoryVariables(ctx.root)
  for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true })
  const platform = ctx.hostPlatform ?? process.platform
  const host = ctx.baseEnv ?? process.env
  const baseEnv = platform === 'win32' ? normalizeWindowsEnvironment(host) : host
  const env = { ...sanitizeHostEnvironment(baseEnv, platform), ...directories }
  const systemPath =
    platform === 'win32' ? windowsSystemPath(baseEnv).join(';') : '/usr/bin:/bin:/usr/sbin:/sbin'
  env.PATH = baseEnv.PATH ?? systemPath
  return {
    port: launch.port,
    command,
    args: [...(launch.args ?? []), ...managedKernelArgs(ctx.root)],
    env
  }
}

/**
 * Resolves `phi:jupyter@1` through `ensureEnvironmentReady`, writes the managed kernelspecs,
 * and returns the launch. Throws `JupyterEnvironmentNotReadyError` when the gate says no.
 */
export async function resolveManagedJupyterLaunch(
  launch: ManagedJupyterLaunch,
  options: ManagedJupyterOptions = {}
): Promise<Required<ManagedJupyterLaunch>> {
  const ctx: ManagedEnvironmentContext = { ...options, root: options.root ?? getRuntimeRoot() }
  const hostJupyterPath = options.hostJupyterPath?.()
  if (hostJupyterPath) {
    syncManagedKernels(ctx)
    return hostJupyterLaunch(hostJupyterPath, launch, ctx)
  }
  const descriptor = describeManagedEnvironment(JUPYTER_ENVIRONMENT_REF, ctx)
  const outcome = await ensureEnvironmentReady({
    root: ctx.root,
    descriptor,
    ref: JUPYTER_ENVIRONMENT_REF,
    requester: {},
    ...(options.runtimeSessionId ? { runtimeSessionId: options.runtimeSessionId } : {}),
    ...(options.builds ? { builds: options.builds } : {}),
    ...(options.confirmBuild ? { confirmBuild: options.confirmBuild } : {}),
    signal: options.signal ?? new AbortController().signal
  })
  if (outcome.status === 'aborted') {
    throw new JupyterEnvironmentNotReadyError(
      `environment ${JUPYTER_ENVIRONMENT_REF} is not ready; aborted`,
      outcome.envId
    )
  }
  if (outcome.status === 'notReady') {
    const selectedHostPath = options.hostJupyterPath?.()
    if (selectedHostPath) {
      syncManagedKernels(ctx)
      return hostJupyterLaunch(selectedHostPath, launch, ctx)
    }
    throw new JupyterEnvironmentNotReadyError(outcome.message, outcome.envId)
  }
  syncManagedKernels(ctx)
  return managedJupyterLaunch(outcome.handle, launch, ctx)
}
