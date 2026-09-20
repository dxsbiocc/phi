import { relative, sep } from 'node:path'

import type { RemoteHpcSettings } from '../../../../shared/wrapperRemoteTypes'
import {
  joinRemote,
  LOG_STDERR,
  LOG_STDOUT,
  type ConnectImpl,
  type RemoteJobHandle,
  type RemoteRunStatus
} from '../executor-remote'
import {
  connectRemoteSshSession,
  shellQuote,
  type RemoteConnectionConfig,
  type RemoteSshSession
} from '../remote-ssh-session'
import type { WrapperOutputRecord } from '../types'
import type { WrapperCompositionEntry } from './discovery'
import type { WrapperProcess, WrapperRunResult } from './executor'
import { ensureRemoteBundle } from './remote-bundle'
import { controllerFor, controllerForHandle } from './remote-controller'
import {
  buildRemoteLaunchScript,
  buildRemoteNextflowConfig,
  buildRemotePreflightScript,
  remoteRunLayout,
  resolveRemoteOutDir,
  type RemoteRunLayout
} from './remote-config'
import { resolveOutputPaths } from './validate'

/**
 * Runs one composition wrapper on an HPC login host and exposes it as the same
 * `WrapperProcess` the local runner returns, so the job manager treats both alike.
 *
 * The controller is `detached_ssh` (design doc "Slurm"): Nextflow starts on the
 * login node under `setsid`, and — with a `slurm` scheduler — itself submits every
 * task to the cluster. Phi only polls over SSH, so a dropped link or a closed app
 * never kills the run; an unreachable host ends the local view as `lost`, not `failed`.
 */

export interface RemoteTarget {
  connection: RemoteConnectionConfig
  /** Absolute remote directory Phi keeps bundles and run directories under. */
  workspaceRoot: string
  hpc?: RemoteHpcSettings
  /** Skip the pre-launch check that Nextflow, `sbatch` and the container runtime exist on the host. */
  skipPreflight?: boolean
  /** Injectable so tests can hand back a fake session. */
  connectImpl?: ConnectImpl
  pollIntervalMs?: number
}

/** Enough to resume watching a run after the app restarted. Holds no credentials. */
export interface RemoteJobSnapshot {
  runId: string
  remoteRunDir: string
  /** Set when the head process is a login-node process (`controller: login`). */
  pid: number | undefined
  /** Set when the head process is a Slurm job (`controller: sbatch`). */
  jobId?: string
  /** Merged params as actually sent (outdir already resolved to a remote path). */
  params: Record<string, unknown>
  componentDir: string
  /** Bytes of `logs/stdout.log` already delivered to `onOutput`. */
  logOffset: number
}

interface CommonOptions {
  entry: WrapperCompositionEntry
  target: RemoteTarget
  onOutput?: (chunk: string) => void
  /** Called after launch and whenever more log has been delivered; persist it to survive a restart. */
  onSnapshot?: (snapshot: RemoteJobSnapshot) => void
  /** Consecutive failed polls (after reconnect attempts) before the run is reported `lost`. Default 12. */
  maxConsecutivePollFailures?: number
  /** Time between SIGTERM and SIGKILL on cancel. Default 10s. */
  killGraceMs?: number
}

export interface StartRemoteOptions extends CommonOptions {
  runId: string
  /** Defaults merged with the caller's overrides. */
  params: Record<string, unknown>
  profile: string
  /** Local `resources/wrappers` root the bundle is built from. */
  wrappersRoot: string
}

export interface AttachRemoteOptions extends CommonOptions {
  snapshot: RemoteJobSnapshot
}

const DEFAULT_POLL_MS = 5000
const DEFAULT_MAX_POLL_FAILURES = 12
const DEFAULT_KILL_GRACE_MS = 10_000
const GLOB_CHARS = /[*?{[]/
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const failure = (output: string, extra: Partial<WrapperRunResult> = {}): WrapperRunResult => ({
  success: false,
  exitCode: -1,
  output,
  ...extra
})

/** A failure result whose reason also goes to the run log, where `wrapper_status` shows it. */
function reported(
  options: CommonOptions,
  output: string,
  extra: Partial<WrapperRunResult> = {}
): WrapperRunResult {
  options.onOutput?.(`${output}\n`)
  return failure(output, extra)
}

class Control {
  cancelled = false
  detached = false
  private wake: (() => void) | undefined
  /** Set once the run is launched; called when cancel is requested. */
  onCancel: (() => void) | undefined

  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    this.onCancel?.()
    this.wake?.()
  }

  detach(): void {
    this.detached = true
    this.wake?.()
  }

  get stopped(): boolean {
    return this.cancelled || this.detached
  }

  /** Waits `ms`, or less if cancel/detach arrives. */
  async pause(ms: number): Promise<void> {
    await Promise.race([sleep(ms), new Promise<void>((resolve) => (this.wake = resolve))])
    this.wake = undefined
  }
}

function toProcess(control: Control, done: Promise<WrapperRunResult>): WrapperProcess {
  return {
    pid: undefined,
    done,
    cancel: () => control.cancel(),
    detach: () => control.detach()
  }
}

function componentRelPath(entry: WrapperCompositionEntry, wrappersRoot: string): string {
  return relative(wrappersRoot, entry.componentDir).split(sep).join('/')
}

/** Makes `outdir` a remote path; see `resolveRemoteOutDir`. */
function resolveRemoteParams(
  entry: WrapperCompositionEntry,
  params: Record<string, unknown>,
  layout: RemoteRunLayout
): Record<string, unknown> {
  if (entry.manifest.params.outdir?.kind !== 'output') return { ...params }
  return { ...params, outdir: resolveRemoteOutDir(params.outdir, layout.runDir) }
}

/**
 * `kind: input` files must exist on the cluster. URLs are left to Nextflow, and a glob
 * is checked by its fixed directory prefix, since expanding one over SSH is not worth it.
 */
async function findMissingRemoteInputs(
  session: RemoteSshSession,
  entry: WrapperCompositionEntry,
  params: Record<string, unknown>,
  layout: RemoteRunLayout
): Promise<string[]> {
  const missing: string[] = []
  for (const [key, spec] of Object.entries(entry.manifest.params)) {
    const value = params[key]
    if (spec.kind !== 'input' || typeof value !== 'string' || value === '') continue
    if (URL_SCHEME.test(value) || value.includes('${')) continue
    const absolute = value.startsWith('/') ? value : joinRemote(layout.componentDir, value)
    const globAt = absolute.search(GLOB_CHARS)
    const target = globAt >= 0 ? absolute.slice(0, absolute.lastIndexOf('/', globAt) + 1) : absolute
    if (!(await session.exists(target || '/'))) missing.push(`${key}: ${absolute}`)
  }
  return missing
}

async function collectOutputs(
  session: RemoteSshSession,
  entry: WrapperCompositionEntry,
  params: Record<string, unknown>,
  componentDir: string
): Promise<{ outputs: WrapperOutputRecord[]; missingOutputs: string[] }> {
  const outputs: WrapperOutputRecord[] = []
  const missingOutputs: string[] = []
  for (const output of resolveOutputPaths(entry.manifest, params, componentDir)) {
    const exists = await session.exists(output.absolutePath)
    outputs.push({
      id: output.id,
      path: output.absolutePath,
      exists,
      primary: output.primary,
      location: 'remote'
    })
    if (output.primary && !exists) missingOutputs.push(`${output.id} (${output.path})`)
  }
  return { outputs, missingOutputs }
}

/** Reads what Nextflow wrote since `offset`, consuming whole lines only so a partial line is read again. */
async function readNewLog(
  session: RemoteSshSession,
  runDir: string,
  offset: number
): Promise<{ text: string; offset: number }> {
  const file = joinRemote(runDir, LOG_STDOUT)
  const result = await session.exec(
    `tail -c +${offset + 1} ${shellQuote(file)} 2>/dev/null || true`
  )
  const end = result.stdout.lastIndexOf('\n')
  if (end < 0) return { text: '', offset }
  const text = result.stdout.slice(0, end + 1)
  return { text, offset: offset + Buffer.byteLength(text) }
}

async function readStderrTail(session: RemoteSshSession, runDir: string): Promise<string> {
  const file = joinRemote(runDir, LOG_STDERR)
  const result = await session.exec(`tail -c 4000 ${shellQuote(file)} 2>/dev/null || true`)
  return result.stdout
}

interface WatchContext {
  entry: WrapperCompositionEntry
  target: RemoteTarget
  options: CommonOptions
  control: Control
  snapshot: RemoteJobSnapshot
  layout: Pick<RemoteRunLayout, 'runDir'>
}

/** Polls the run to the end, riding out connection drops; the shared tail of start and attach. */
async function watch(ctx: WatchContext, initial: RemoteSshSession): Promise<WrapperRunResult> {
  const { control, snapshot, options, target } = ctx
  const pollMs = target.pollIntervalMs ?? DEFAULT_POLL_MS
  const maxFailures = options.maxConsecutivePollFailures ?? DEFAULT_MAX_POLL_FAILURES
  const connect = target.connectImpl ?? connectRemoteSshSession
  const handle: RemoteJobHandle = {
    runId: snapshot.runId,
    remoteRunDir: snapshot.remoteRunDir,
    pid: snapshot.pid,
    ...(snapshot.jobId !== undefined ? { jobId: snapshot.jobId } : {})
  }
  const controller = controllerForHandle(handle)

  let session = initial
  let offset = snapshot.logOffset
  let failures = 0
  let lastError = ''
  let cancelSent = false

  const deliver = async (): Promise<void> => {
    const chunk = await readNewLog(session, snapshot.remoteRunDir, offset)
    if (chunk.text) {
      offset = chunk.offset
      options.onOutput?.(chunk.text)
      options.onSnapshot?.({ ...snapshot, logOffset: offset })
    }
  }

  const stopRemote = async (): Promise<void> => {
    if (cancelSent) return
    cancelSent = true
    try {
      await controller.signal(session, handle, 'TERM')
      const grace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
      const deadline = Date.now() + grace
      while (Date.now() < deadline) {
        if ((await controller.status(session, handle)).outcome !== 'running') return
        await sleep(Math.min(100, grace))
      }
      await controller.signal(session, handle, 'KILL')
    } catch {
      // Best effort: the poll loop reports whatever the run really did.
    }
  }
  control.onCancel = () => void stopRemote()
  if (control.cancelled) await stopRemote()

  for (;;) {
    if (control.detached) return failure('', { detached: true })
    try {
      const status = await controller.status(session, handle)
      failures = 0
      await deliver()
      if (control.cancelled && status.outcome !== 'running') {
        return failure('', { cancelled: true })
      }
      if (status.outcome !== 'running') {
        return await finish(ctx, session, status)
      }
    } catch (error) {
      failures += 1
      lastError = error instanceof Error ? error.message : String(error)
      if (failures >= maxFailures) {
        return reported(
          options,
          `Lost contact with ${target.connection.host}: ${lastError}. The run may still be going there.`,
          { lost: true }
        )
      }
      try {
        await session.close().catch(() => undefined)
        session = await connect(target.connection)
      } catch (reconnectError) {
        lastError =
          reconnectError instanceof Error ? reconnectError.message : String(reconnectError)
      }
    }
    await control.pause(pollMs)
  }
}

/** Why Slurm ended the head job, and what to change, for the states that have a usual fix. */
function describeSlurmEnd(state: string): string {
  const hint = state.startsWith('TIMEOUT')
    ? ' It reached its time limit; raise it with e.g. "--time=7-00:00:00" in the connection\'s head-job options.'
    : state.startsWith('OUT_OF_MEMORY')
      ? ' Raise its memory with e.g. "--mem=8G" in the connection\'s head-job options.'
      : ''
  return `Slurm ended the Nextflow head job in state ${state}.${hint}`
}

async function finish(
  ctx: WatchContext,
  session: RemoteSshSession,
  status: RemoteRunStatus
): Promise<WrapperRunResult> {
  const { entry, snapshot, options } = ctx
  if (status.outcome === 'lost') {
    return reported(
      options,
      'The remote process is gone and left no exit code (the host may have restarted).',
      { lost: true }
    )
  }
  if (status.outcome === 'failed') {
    const stderr = await readStderrTail(session, snapshot.remoteRunDir)
    if (stderr.trim()) options.onOutput?.(stderr)
    const why = status.detail ? describeSlurmEnd(status.detail) : ''
    if (why) options.onOutput?.(`${why}\n`)
    return failure([stderr.trim(), why].filter(Boolean).join('\n'), {
      exitCode: status.exitCode ?? 1
    })
  }
  const remote = await collectOutputs(session, entry, snapshot.params, snapshot.componentDir)
  return { success: true, exitCode: 0, output: '', remote }
}

/**
 * Checks the host can run the wrapper at all. Returns a failure result to stop the launch, or
 * undefined to go on (delivering any warnings to the run log).
 */
async function runPreflight(
  session: RemoteSshSession,
  options: StartRemoteOptions
): Promise<WrapperRunResult | undefined> {
  const script = buildRemotePreflightScript({ hpc: options.target.hpc, profile: options.profile })
  const result = await session.exec(`bash -c ${shellQuote(script)}`)
  if (result.code !== 0) {
    const reason = (result.stderr || result.stdout).trim()
    return reported(
      options,
      `The cluster check failed on ${options.target.connection.host}: ${reason}`
    )
  }
  if (result.stdout.trim()) options.onOutput?.(`${result.stdout.trimEnd()}\n`)
  return undefined
}

/** Launches the run remotely: connect, ship the bundle, check inputs, write files, start detached. */
async function launch(options: StartRemoteOptions, control: Control): Promise<WrapperRunResult> {
  const { entry, target } = options
  const connect = target.connectImpl ?? connectRemoteSshSession
  const session = await connect(target.connection)
  try {
    if (control.cancelled) return failure('', { cancelled: true })
    if (!target.skipPreflight) {
      const failed = await runPreflight(session, options)
      if (failed) return failed
    }
    const bundle = await ensureRemoteBundle(session, {
      localRoot: options.wrappersRoot,
      workspaceRoot: target.workspaceRoot
    })
    const layout = remoteRunLayout({
      workspaceRoot: target.workspaceRoot,
      runId: options.runId,
      bundleHash: bundle.hash,
      componentRelPath: componentRelPath(entry, options.wrappersRoot)
    })
    const params = resolveRemoteParams(entry, options.params, layout)

    const missing = await findMissingRemoteInputs(session, entry, params, layout)
    if (missing.length > 0) {
      return reported(
        options,
        `These input paths do not exist on ${target.connection.host}:\n${missing.map((line) => `- ${line}`).join('\n')}\nGive paths as they appear on the cluster.`
      )
    }
    if (control.cancelled) return failure('', { cancelled: true })

    await session.mkdirp(joinRemote(layout.runDir, 'logs'))
    await session.writeTextFile(layout.paramsFile, JSON.stringify(params, null, 2))
    await session.writeTextFile(
      layout.configFile,
      buildRemoteNextflowConfig(target.hpc ?? { scheduler: 'local' })
    )
    await session.writeTextFile(
      joinRemote(layout.runDir, 'launch.sh'),
      buildRemoteLaunchScript({ layout, profile: options.profile, hpc: target.hpc })
    )
    const controller = controllerFor(target.hpc)
    const started = await controller
      .start(session, { layout, runId: options.runId, hpc: target.hpc })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        return `Could not start the run on ${target.connection.host}: ${reason}`
      })
    if (typeof started === 'string') return reported(options, started)
    if (started.note) options.onOutput?.(`${started.note}\n`)
    const snapshot: RemoteJobSnapshot = {
      runId: options.runId,
      remoteRunDir: layout.runDir,
      pid: started.pid,
      ...(started.jobId !== undefined ? { jobId: started.jobId } : {}),
      params,
      componentDir: layout.componentDir,
      logOffset: 0
    }
    options.onSnapshot?.(snapshot)
    return await watch({ entry, target, options, control, snapshot, layout }, session)
  } finally {
    await session.close().catch(() => undefined)
  }
}

export function startRemoteWrapperComposition(options: StartRemoteOptions): WrapperProcess {
  const control = new Control()
  const done = launch(options, control).catch((error: unknown) =>
    reported(
      options,
      `Remote run could not be started: ${error instanceof Error ? error.message : String(error)}`
    )
  )
  return toProcess(control, done)
}

/** Resumes watching a run that an earlier app session launched. */
export function attachRemoteWrapperComposition(options: AttachRemoteOptions): WrapperProcess {
  const control = new Control()
  const { snapshot, target, entry } = options
  const connect = target.connectImpl ?? connectRemoteSshSession
  const layout = { runDir: snapshot.remoteRunDir }
  const done = (async () => {
    const session = await connect(target.connection)
    try {
      return await watch({ entry, target, options, control, snapshot, layout }, session)
    } finally {
      await session.close().catch(() => undefined)
    }
  })().catch((error: unknown) =>
    reported(
      options,
      `Could not reach ${target.connection.host}: ${error instanceof Error ? error.message : String(error)}`,
      {
        lost: true
      }
    )
  )
  return toProcess(control, done)
}
