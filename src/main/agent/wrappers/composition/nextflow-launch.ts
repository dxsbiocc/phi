import { existsSync } from 'node:fs'
import { delimiter, dirname } from 'node:path'

import type { EnvironmentBuilds } from '../../content/environment-builds'
import { ensureEnvironmentReady, type ConfirmBuildRequest } from '../../content/environment-gate'
import { describeEnvironment } from '../../content/environment-refs'
import { getCustomToolPath } from '../../environment/store'
import {
  environmentVariables,
  getRuntimeRoot,
  probeHostRequirements,
  resolveCommand,
  type EnvHandle,
  type HostRequirement,
  type PhiPlatform
} from '../../envs'
import {
  MIN_NEXTFLOW_VERSION,
  isNextflowVersionSupported,
  readLocalNextflowVersion
} from './nextflow-version'

/**
 * Which `nextflow` a local wrapper run uses (runtime foundation §5.2, §9 decision 5).
 *
 * - Default: `nextflow` from the managed `phi:nextflow@1` environment, readied through
 *   the shared environment gate. A missing environment fails the run; the host is never
 *   searched as a fallback.
 * - Opt-in: a host nextflow the user chose explicitly (`customPaths.nextflow` in
 *   `~/.phi/environment.json`, or `NEXTFLOW_BIN` for development and tests). It is used
 *   only when `nextflow -version` reports at least {@link MIN_NEXTFLOW_VERSION}, and is
 *   labelled {@link HOST_UNMANAGED_LABEL}. A path that is set but unusable is an error.
 *
 * Remote runs do not come here: they use the remote host's nextflow.
 */

export const NEXTFLOW_ENVIRONMENT_REF = 'phi:nextflow@1'
export const HOST_UNMANAGED_LABEL = 'host (unmanaged)'

/** Container runtimes a profile needs from the host; see `host:` in phi-nextflow's spec. */
const PROFILE_HOST_COMMANDS: Record<string, readonly string[]> = {
  docker: ['docker'],
  singularity: ['singularity', 'apptainer']
}

const SYSTEM_PATH_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

interface LaunchBase {
  /** Absolute path of the `nextflow` launcher that is spawned. */
  command: string
  /** The complete child environment. */
  env: Record<string, string>
  /** Runtime root: the conda profile's micromamba state and cache live under it. */
  runtimeRoot: string
}

export interface ManagedNextflowLaunch extends LaunchBase {
  source: 'managed'
  ref: string
  envId: string
}

export interface HostNextflowLaunch extends LaunchBase {
  source: 'host'
  label: typeof HOST_UNMANAGED_LABEL
  version: string
}

export type NextflowLaunch = ManagedNextflowLaunch | HostNextflowLaunch

export type NextflowLaunchResult =
  { ok: true; launch: NextflowLaunch } | { ok: false; error: string }

export interface NextflowLaunchContext {
  /** Profile of the run; `docker` / `singularity` add the container runtime's directory to PATH. */
  profile?: string
  /** The chat's runtime session, so a missing environment can be offered for building in chat. */
  runtimeSessionId?: string
  /** Wrapper id, named in the build prompt. */
  wrapperId?: string
  builds?: EnvironmentBuilds
  confirmBuild?: (request: ConfirmBuildRequest) => Promise<boolean>
  signal?: AbortSignal
  /** Defaults to `getRuntimeRoot()`. */
  runtimeRoot?: string
  /** Bundled environments directory; tests pass a fixture. */
  environmentsDir?: string
  platform?: PhiPlatform
  /** The host nextflow the user opted into. Defaults to `NEXTFLOW_BIN`, then `customPaths.nextflow`. */
  hostNextflowPath?: () => string | undefined
  readVersion?: (nextflowBin: string) => Promise<string | undefined>
  baseEnv?: NodeJS.ProcessEnv
}

/** The explicitly chosen host nextflow, if any. Detected-but-unchosen binaries do not count. */
export function configuredHostNextflow(): string | undefined {
  const fromEnv = process.env.NEXTFLOW_BIN
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return getCustomToolPath('nextflow')
}

export function hostNextflowRejection(path: string, version: string | undefined): string {
  if (!version) {
    return (
      `已设置的本机 Nextflow（${path}）无法报告版本（nextflow -version），Wrapper 需要 ` +
      `${MIN_NEXTFLOW_VERSION} 或更新的版本。请修正该路径，或在设置 → 环境中清除它以使用 Phi 管理的 ` +
      `${NEXTFLOW_ENVIRONMENT_REF}。`
    )
  }
  return (
    `已设置的本机 Nextflow（${path}）版本是 ${version}，Wrapper 需要 ${MIN_NEXTFLOW_VERSION} 或更新的版本。` +
    `请换成新版本的路径，或在设置 → 环境中清除它以使用 Phi 管理的 ${NEXTFLOW_ENVIRONMENT_REF}。`
  )
}

export async function resolveNextflowLaunch(
  context: NextflowLaunchContext = {}
): Promise<NextflowLaunchResult> {
  const runtimeRoot = context.runtimeRoot ?? getRuntimeRoot()
  const hostPath = (context.hostNextflowPath ?? configuredHostNextflow)()
  if (hostPath) return resolveHostLaunch(hostPath, runtimeRoot, context)
  return resolveManagedLaunch(runtimeRoot, context)
}

async function resolveHostLaunch(
  path: string,
  runtimeRoot: string,
  context: NextflowLaunchContext
): Promise<NextflowLaunchResult> {
  if (!existsSync(path)) {
    return { ok: false, error: `已设置的本机 Nextflow 路径不存在：${path}` }
  }
  const version = await (context.readVersion ?? readLocalNextflowVersion)(path)
  if (!version || !isNextflowVersionSupported(version)) {
    return { ok: false, error: hostNextflowRejection(path, version) }
  }
  const base = context.baseEnv ?? process.env
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (typeof value === 'string') env[name] = value
  }
  env.PATH = [dirname(path), ...(base.PATH ?? '').split(delimiter).filter(Boolean)].join(delimiter)
  env.NXF_DISABLE_CHECK_LATEST = 'true'
  return {
    ok: true,
    launch: {
      source: 'host',
      label: HOST_UNMANAGED_LABEL,
      version,
      command: path,
      env,
      runtimeRoot
    }
  }
}

async function resolveManagedLaunch(
  runtimeRoot: string,
  context: NextflowLaunchContext
): Promise<NextflowLaunchResult> {
  let descriptor: ReturnType<typeof describeEnvironment>
  try {
    descriptor = describeEnvironment(NEXTFLOW_ENVIRONMENT_REF, {
      ...(context.environmentsDir ? { environmentsDir: context.environmentsDir } : {}),
      ...(context.platform ? { platform: context.platform } : {})
    })
  } catch (error) {
    return {
      ok: false,
      error: `环境 ${NEXTFLOW_ENVIRONMENT_REF} 不可用：${error instanceof Error ? error.message : String(error)}`
    }
  }
  const outcome = await ensureEnvironmentReady({
    root: runtimeRoot,
    descriptor,
    ref: NEXTFLOW_ENVIRONMENT_REF,
    // The build prompt names a skill or an agent; the wrapper id stands in for the skill.
    requester: context.wrapperId ? { skill: context.wrapperId } : {},
    ...(context.runtimeSessionId ? { runtimeSessionId: context.runtimeSessionId } : {}),
    ...(context.builds ? { builds: context.builds } : {}),
    ...(context.confirmBuild ? { confirmBuild: context.confirmBuild } : {}),
    signal: context.signal ?? new AbortController().signal
  })
  if (outcome.status === 'aborted') {
    return { ok: false, error: `environment ${NEXTFLOW_ENVIRONMENT_REF} is not ready; aborted` }
  }
  if (outcome.status === 'notReady') return { ok: false, error: outcome.message }
  return managedLaunch(outcome.handle, runtimeRoot, descriptor.spec.host, context)
}

function managedLaunch(
  handle: EnvHandle,
  runtimeRoot: string,
  hostRequirements: readonly HostRequirement[] | undefined,
  context: NextflowLaunchContext
): NextflowLaunchResult {
  const env = environmentVariables(handle, context.baseEnv ? { baseEnv: context.baseEnv } : {})
  env.PATH = withContainerRuntime(env.PATH ?? '', hostRequirements, handle, context.profile)
  env.NXF_DISABLE_CHECK_LATEST = 'true'
  const command = resolveCommand('nextflow', env.PATH)
  if (!command) {
    return { ok: false, error: `command not found in environment ${handle.envId}: nextflow` }
  }
  return {
    ok: true,
    launch: {
      source: 'managed',
      ref: NEXTFLOW_ENVIRONMENT_REF,
      envId: handle.envId,
      command,
      env,
      runtimeRoot
    }
  }
}

/**
 * Docker and Singularity are host dependencies (§9 decision 4). The build records the
 * ones it found in `metadata.host`; one installed after the build is probed again here,
 * so the profile works without rebuilding. Only the profile's own runtime is added.
 */
function withContainerRuntime(
  pathValue: string,
  requirements: readonly HostRequirement[] | undefined,
  handle: EnvHandle,
  profile: string | undefined
): string {
  const names = profile ? PROFILE_HOST_COMMANDS[profile] : undefined
  if (!names) return pathValue
  const wanted = (requirements ?? []).filter((requirement) => names.includes(requirement.name))
  const found = probeHostRequirements(wanted, handle.metadata.platform).found
  const dirs = names
    .map((name) => handle.metadata.host[name] ?? found[name])
    .filter((path): path is string => typeof path === 'string')
    .map((path) => dirname(path))
  return insertBeforeSystemDirs(pathValue, dirs)
}

export function insertBeforeSystemDirs(pathValue: string, dirs: readonly string[]): string {
  const entries = pathValue.split(delimiter).filter(Boolean)
  const additions = dirs.filter(
    (dir, index) => !entries.includes(dir) && dirs.indexOf(dir) === index
  )
  if (additions.length === 0) return pathValue
  const at = entries.findIndex((entry) => SYSTEM_PATH_DIRS.includes(entry))
  const index = at === -1 ? entries.length : at
  return [...entries.slice(0, index), ...additions, ...entries.slice(index)].join(delimiter)
}

/** One line for the run log and the run record. */
export function describeNextflowLaunch(launch: NextflowLaunch): string {
  return launch.source === 'managed'
    ? `Nextflow: ${launch.ref} (${launch.envId})`
    : `Nextflow: ${launch.label} ${launch.version} at ${launch.command}`
}

/**
 * What the run record keeps about the launcher (execution contract: envId and the
 * resolved command; for a host nextflow, its version and path).
 */
export function nextflowLaunchRecord(launch: NextflowLaunch): Record<string, string> {
  return launch.source === 'managed'
    ? { source: 'managed', ref: launch.ref, envId: launch.envId, resolvedCommand: launch.command }
    : {
        source: 'host',
        label: launch.label,
        version: launch.version,
        resolvedCommand: launch.command
      }
}
