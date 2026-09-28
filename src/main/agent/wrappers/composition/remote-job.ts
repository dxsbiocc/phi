import { join, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

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
import { checkRemoteWrapperInputs } from '../remote-input-check'
import {
  claimRemoteLaunch,
  observeRemoteLaunch,
  RemoteLaunchRejectedError,
  type RemoteLaunchKind,
  type RemoteLaunchObservation
} from '../remote-launch-claim'
import type { WrapperInputResolution, WrapperOutputRecord } from '../types'
import { readRemoteLogDelta, type RemoteLogCursor } from '../remote-log'
import { cancelRemoteController, type RemoteCancelResult } from '../remote-cancel'
import type { WrapperCompositionEntry } from './discovery'
import type { WrapperProcess, WrapperRunResult } from './executor'
import { ensureRemoteBundle } from './remote-bundle'
import { collectWrapperSingularityImages, stageSingularityImages } from './remote-images'
import type { WrapperRunResources } from './resources'
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
  /** Injectable so tests need no registry; defaults to the real image staging. */
  stageImagesImpl?: typeof stageSingularityImages
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
  logFileIdentity?: string
  logPendingUtf8?: string
  /** A claim exists but the remote start receipt was not confirmed. */
  launchUnknown?: true
  launchKind?: RemoteLaunchKind
  profile?: string
}

interface RemoteLaunchMeta {
  runId: string
  wrapperId: string
  profile: string
  componentDir: string
  params: Record<string, unknown>
  launchKind: RemoteLaunchKind
}

interface CommonOptions {
  entry: WrapperCompositionEntry
  target: RemoteTarget
  onOutput?: (chunk: string) => void
  /** Fresh scheduler/process evidence from a watcher, before log delivery. */
  onStatus?: (status: RemoteRunStatus) => void
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
  /** Final server paths resolved from the selected project and input mappings. */
  inputReferences?: WrapperInputResolution[]
  profile: string
  /** Local `resources/wrappers` root the bundle is built from. */
  wrappersRoot: string
  /** Overrides the wrapper's own cpus/memory/time for every process of this run. */
  resources?: WrapperRunResources
}

export interface AttachRemoteOptions extends CommonOptions {
  snapshot: RemoteJobSnapshot
}

const DEFAULT_POLL_MS = 5000
const DEFAULT_MAX_POLL_FAILURES = 12
const DEFAULT_KILL_GRACE_MS = 10_000

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
  layout: Pick<RemoteRunLayout, 'runDir'>
): Record<string, unknown> {
  if (entry.manifest.params.outdir?.kind !== 'output') return { ...params }
  return { ...params, outdir: resolveRemoteOutDir(params.outdir, layout.runDir) }
}

const LAUNCH_META_FILE = 'launch-meta.json'

function launchKind(target: RemoteTarget): RemoteLaunchKind {
  return target.hpc?.controller === 'sbatch' ? 'sbatch' : 'detached'
}

function snapshotForObservation(
  runId: string,
  remoteRunDir: string,
  meta: RemoteLaunchMeta,
  observation: Extract<RemoteLaunchObservation, { kind: 'started' }>
): RemoteJobSnapshot {
  return {
    runId,
    remoteRunDir,
    pid: observation.pid,
    ...(observation.jobId ? { jobId: observation.jobId } : {}),
    params: meta.params,
    componentDir: meta.componentDir,
    logOffset: 0,
    launchKind: meta.launchKind,
    profile: meta.profile
  }
}

async function readMatchingLaunchMeta(
  session: RemoteSshSession,
  runDir: string,
  entry: WrapperCompositionEntry,
  runId: string,
  profile: string | undefined,
  params: Record<string, unknown>,
  kind: RemoteLaunchKind
): Promise<RemoteLaunchMeta | undefined> {
  const path = joinRemote(runDir, LAUNCH_META_FILE)
  if (!(await session.exists(path))) return undefined
  let parsed: Partial<RemoteLaunchMeta>
  try {
    parsed = JSON.parse(await session.readTextFile(path)) as Partial<RemoteLaunchMeta>
  } catch {
    return undefined
  }
  if (
    parsed.runId !== runId ||
    parsed.wrapperId !== entry.manifest.id ||
    typeof parsed.profile !== 'string' ||
    (profile !== undefined && parsed.profile !== profile) ||
    parsed.launchKind !== kind ||
    typeof parsed.componentDir !== 'string' ||
    !isDeepStrictEqual(parsed.params, params)
  )
    return undefined
  return parsed as RemoteLaunchMeta
}

function remoteInputs(
  entry: WrapperCompositionEntry,
  params: Record<string, unknown>,
  supplied?: WrapperInputResolution[]
): WrapperInputResolution[] {
  const inputs: WrapperInputResolution[] = []
  for (const [key, spec] of Object.entries(entry.manifest.params)) {
    const value = params[key]
    if (spec.kind !== 'input' || typeof value !== 'string' || value === '') continue
    const reference = supplied?.find((input) => input.id === key)
    if (reference) {
      if (!reference.remotePaths?.includes(value)) {
        throw new Error(`输入 "${key}" 的最终服务器路径与运行参数不一致: ${value}`)
      }
      inputs.push(reference)
      continue
    }
    inputs.push({
      id: key,
      kind: 'path',
      source: 'remote',
      userValue: value,
      localPaths: [],
      remotePaths: [value]
    })
  }
  return inputs
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
  let cursor: RemoteLogCursor = {
    offset: snapshot.logOffset,
    identity: snapshot.logFileIdentity,
    pendingUtf8: snapshot.logPendingUtf8
  }
  let failures = 0
  let inconclusiveStatuses = 0
  let lastError = ''
  let cancellation: Promise<RemoteCancelResult | undefined> | undefined

  const deliver = async (): Promise<number> => {
    const delta = await readRemoteLogDelta(
      session,
      joinRemote(snapshot.remoteRunDir, LOG_STDOUT),
      cursor
    )
    for (const diagnostic of delta.diagnostics) options.onOutput?.(`[Phi] ${diagnostic}\n`)
    if (delta.text) options.onOutput?.(delta.text)
    const changed =
      delta.cursor.offset !== cursor.offset ||
      delta.cursor.identity !== cursor.identity ||
      delta.cursor.pendingUtf8 !== cursor.pendingUtf8
    cursor = delta.cursor
    if (changed || delta.diagnostics.length > 0) {
      options.onSnapshot?.({
        ...snapshot,
        logOffset: cursor.offset,
        logFileIdentity: cursor.identity,
        logPendingUtf8: cursor.pendingUtf8
      })
    }
    return delta.bytesRead
  }

  const stopRemote = async (): Promise<RemoteCancelResult | undefined> => {
    try {
      return await cancelRemoteController(
        session,
        handle,
        options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
      )
    } catch (error) {
      options.onOutput?.(
        `[Phi] 取消信号未能确认送达：${error instanceof Error ? error.message : String(error)}\n`
      )
    }
    return undefined
  }
  const requestCancel = (): void => {
    cancellation ??= stopRemote()
  }
  control.onCancel = requestCancel
  if (control.cancelled) requestCancel()

  for (;;) {
    if (control.detached) return failure('', { detached: true })
    try {
      const status = await controller.status(session, handle)
      options.onStatus?.(status)
      failures = 0
      await deliver()
      if (status.outcome === 'lost' && inconclusiveStatuses < 2) {
        inconclusiveStatuses += 1
        await control.pause(150)
        continue
      }
      if (status.outcome !== 'lost') inconclusiveStatuses = 0
      if (control.cancelled && status.outcome !== 'running' && cancellation) {
        const outcome = await cancellation
        if (outcome?.kind === 'confirmed' && status.outcome !== 'completed') {
          return failure('', { cancelled: true })
        }
      }
      if (status.outcome !== 'running') {
        // A completed job can leave a large final log; drain it through repeated bounded pages.
        while ((await deliver()) > 0) {
          if (control.detached) return failure('', { detached: true })
        }
        if (cursor.pendingUtf8) {
          options.onOutput?.(Buffer.from(cursor.pendingUtf8, 'base64').toString('utf8'))
          cursor = { ...cursor, pendingUtf8: undefined }
          options.onSnapshot?.({
            ...snapshot,
            logOffset: cursor.offset,
            logFileIdentity: cursor.identity,
            logPendingUtf8: undefined
          })
        }
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
  const script = buildRemotePreflightScript({
    hpc: options.target.hpc,
    profile: options.profile,
    workspaceRoot: options.target.workspaceRoot
  })
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

/**
 * With Singularity and a cache directory, puts the wrapper's images into that
 * cache first, so offline compute nodes never have to pull. Images that cannot
 * be staged only warn: the nodes may be able to pull them after all.
 */
async function stageImagesForRun(
  session: RemoteSshSession,
  options: StartRemoteOptions
): Promise<void> {
  const cacheDir = options.target.hpc?.singularityCacheDir
  if (options.profile !== 'singularity' || !cacheDir) return
  const images = collectWrapperSingularityImages(join(options.entry.wrapperDir, 'main.nf'))
  if (images.length === 0) return
  const stage = options.target.stageImagesImpl ?? stageSingularityImages
  try {
    const { failed } = await stage(session, { images, cacheDir, onOutput: options.onOutput })
    for (const { fileName, reason } of failed) {
      options.onOutput?.(
        `警告：镜像 ${fileName} 未能放入缓存 ${cacheDir}（${reason}）。计算节点无法联网时运行会失败，可手动把该文件放入缓存目录后重试。\n`
      )
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    options.onOutput?.(`警告：检查镜像缓存 ${cacheDir} 失败（${reason}），将直接启动运行。\n`)
  }
}

/** Launches the run remotely: connect, ship the bundle, check inputs, write files, start detached. */
async function launch(options: StartRemoteOptions, control: Control): Promise<WrapperRunResult> {
  const { entry, target } = options
  const connect = target.connectImpl ?? connectRemoteSshSession
  let session = await connect(target.connection)
  const remoteRunDir = `${target.workspaceRoot.replace(/\/+$/, '')}/wrappers/runs/${options.runId}`
  const kind = launchKind(target)
  const expectedParams = resolveRemoteParams(entry, options.params, { runDir: remoteRunDir })
  let componentDir = ''
  const unknown = (reason: string): WrapperRunResult => {
    options.onSnapshot?.({
      runId: options.runId,
      remoteRunDir,
      pid: undefined,
      params: expectedParams,
      componentDir,
      logOffset: 0,
      launchUnknown: true,
      launchKind: kind,
      profile: options.profile
    })
    return reported(
      options,
      `远程运行 ${options.runId} 的启动结果未知：${reason}。已保留远程目录，请勿重复提交。`,
      { lost: true }
    )
  }
  const rejected = (reason: string): WrapperRunResult => {
    options.onSnapshot?.({
      runId: options.runId,
      remoteRunDir,
      pid: undefined,
      params: expectedParams,
      componentDir,
      logOffset: 0,
      launchKind: kind,
      profile: options.profile
    })
    return reported(options, reason)
  }
  const handleObserved = async (
    observation: RemoteLaunchObservation
  ): Promise<WrapperRunResult | undefined> => {
    if (observation.kind === 'unclaimed') return undefined
    if (observation.kind === 'rejected') return rejected(observation.reason)
    if (observation.kind === 'unknown') return unknown(observation.reason)
    const meta = await readMatchingLaunchMeta(
      session,
      remoteRunDir,
      entry,
      options.runId,
      options.profile,
      expectedParams,
      kind
    )
    if (!meta) return unknown('已找到远端回执，但启动参数记录缺失或不一致')
    const snapshot = snapshotForObservation(options.runId, remoteRunDir, meta, observation)
    options.onSnapshot?.(snapshot)
    return watch(
      { entry, target, options, control, snapshot, layout: { runDir: remoteRunDir } },
      session
    )
  }
  const recover = async (error: unknown): Promise<WrapperRunResult> => {
    const reason = error instanceof Error ? error.message : String(error)
    try {
      const fresh = await connect(target.connection)
      await session.close().catch(() => undefined)
      session = fresh
      const observation = await observeRemoteLaunch(session, remoteRunDir, options.runId, kind)
      return (await handleObserved(observation)) ?? unknown(`连接恢复后未找到启动回执：${reason}`)
    } catch {
      return unknown(`无法重新连接服务器核对启动回执：${reason}`)
    }
  }
  try {
    if (control.cancelled) return failure('', { cancelled: true })
    if (!target.skipPreflight) {
      const failed = await runPreflight(session, options)
      if (failed) return failed
    }
    const controller = controllerFor(target.hpc)
    const prior = await handleObserved(
      await observeRemoteLaunch(session, remoteRunDir, options.runId, kind)
    )
    if (prior) return prior
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
    componentDir = layout.componentDir

    const checked = await checkRemoteWrapperInputs(
      session,
      remoteInputs(entry, params, options.inputReferences),
      { relativeBase: layout.componentDir }
    )
    for (const warning of checked.warnings) options.onOutput?.(`警告：${warning}\n`)
    if (checked.errors.length > 0) {
      return reported(
        options,
        `服务器 ${target.connection.host} 的输入核验失败：\n${checked.errors.map((line) => `- ${line}`).join('\n')}`
      )
    }
    await stageImagesForRun(session, options)
    if (control.cancelled) return failure('', { cancelled: true })
    options.onSnapshot?.({
      runId: options.runId,
      remoteRunDir: layout.runDir,
      pid: undefined,
      params,
      componentDir,
      logOffset: 0,
      launchUnknown: true,
      launchKind: kind,
      profile: options.profile
    })
    let claimed: boolean
    try {
      claimed = await claimRemoteLaunch(session, layout.runDir, options.runId)
    } catch (error) {
      return recover(error)
    }
    if (!claimed) {
      const existing = await handleObserved(
        await observeRemoteLaunch(session, layout.runDir, options.runId, kind)
      )
      return existing ?? unknown('另一提交已声明该运行')
    }
    const meta: RemoteLaunchMeta = {
      runId: options.runId,
      wrapperId: entry.manifest.id,
      profile: options.profile,
      componentDir,
      params,
      launchKind: kind
    }
    let started: { pid?: number; jobId?: string; note?: string }
    try {
      await session.mkdirp(joinRemote(layout.runDir, 'logs'))
      await session.writeTextFile(joinRemote(layout.runDir, LAUNCH_META_FILE), JSON.stringify(meta))
      await session.writeTextFile(layout.paramsFile, JSON.stringify(params, null, 2))
      await session.writeTextFile(
        layout.configFile,
        buildRemoteNextflowConfig(target.hpc ?? { scheduler: 'local' }, options.resources)
      )
      await session.writeTextFile(
        joinRemote(layout.runDir, 'launch.sh'),
        buildRemoteLaunchScript({ layout, profile: options.profile, hpc: target.hpc })
      )
      started = await controller.start(session, { layout, runId: options.runId, hpc: target.hpc })
    } catch (error) {
      if (error instanceof RemoteLaunchRejectedError) return rejected(error.message)
      return recover(error)
    }
    if (started.note) options.onOutput?.(`${started.note}\n`)
    const snapshot: RemoteJobSnapshot = {
      runId: options.runId,
      remoteRunDir: layout.runDir,
      pid: started.pid,
      ...(started.jobId !== undefined ? { jobId: started.jobId } : {}),
      params,
      componentDir,
      logOffset: 0,
      launchKind: kind,
      profile: options.profile
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
      let current = snapshot
      if (snapshot.launchUnknown || (snapshot.pid === undefined && snapshot.jobId === undefined)) {
        const kind = snapshot.launchKind ?? launchKind(target)
        const observed = await observeRemoteLaunch(
          session,
          snapshot.remoteRunDir,
          snapshot.runId,
          kind
        )
        if (observed.kind === 'rejected') return reported(options, observed.reason)
        if (observed.kind !== 'started') {
          return reported(
            options,
            `远程运行 ${snapshot.runId} 状态仍未知：${observed.kind === 'unknown' ? observed.reason : '未找到启动声明'}。保留快照，稍后可再次对账。`,
            { lost: true }
          )
        }
        const meta = await readMatchingLaunchMeta(
          session,
          snapshot.remoteRunDir,
          entry,
          snapshot.runId,
          snapshot.profile,
          snapshot.params,
          kind
        )
        if (!meta) {
          return reported(options, '远程启动参数记录缺失或不一致，保留快照等待对账。', {
            lost: true
          })
        }
        current = {
          ...snapshot,
          pid: observed.pid,
          jobId: observed.jobId,
          params: meta.params,
          componentDir: meta.componentDir,
          launchKind: meta.launchKind,
          profile: meta.profile,
          launchUnknown: undefined
        }
        options.onSnapshot?.(current)
      }
      return await watch({ entry, target, options, control, snapshot: current, layout }, session)
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
