import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { RemoteHpcSettings } from '../../../../shared/wrapperRemoteTypes'
import type { WrapperManifestEngineProfile } from '../../../../shared/wrapperManifestTypes'
import type { Project } from '../../projects'
import { getPhiAgentDir } from '../../runtime-paths'
import { getBundledWrapperPackagesDir } from '../catalog'
import { resolveCompositionInputParams } from '../path-mapping'
import type { ResolvedRemoteTarget } from '../remote-connection-resolver'
import { chooseWrapperTarget, type WrapperTargetDoctorSnapshot } from '../target-policy'
import { getWrapperRunsDir, listWrapperRuns, readWrapperRun, writeWrapperRun } from '../store'
import type { WrapperExecutor, WrapperRun } from '../types'
import {
  findWrapperCompositionEntry,
  readWrapperCompositionDag,
  readWrapperDefaultParams,
  type WrapperCompositionEntry
} from './discovery'
import {
  WRAPPER_EXECUTION_PROFILES,
  killAllWrapperProcesses,
  startWrapperComposition,
  type WrapperExecutionProfile,
  type WrapperProcess,
  type WrapperRunResult
} from './executor'
import { DEFAULT_REMOTE_RUNTIME } from '../../../../shared/wrapperRemoteTypes'
import {
  TERMINAL_RUN_STATES,
  type CancelJobResult,
  type StartJobResult,
  type WrapperJobClient,
  type WrapperJobStatus,
  type WrapperJobSummary
} from './job-types'
import { countDagProcesses, createProgressTracker, type ProgressTracker } from './progress'
import {
  attachRemoteWrapperComposition,
  startRemoteWrapperComposition,
  type RemoteJobSnapshot
} from './remote-job'
import {
  finishCompositionRun,
  isResumableRemoteRun,
  markCompositionRunCancelling,
  markCompositionRunLost,
  markCompositionRunRunning,
  readCompositionRemoteSnapshot,
  startCompositionRun,
  writeCompositionRemoteSnapshot,
  type CompositionRunOutcome
} from './run-record'
import { findMissingPrimaryOutputs, validateWrapperParams } from './validate'

/**
 * Owns every background wrapper run. It lives in the main process on purpose:
 * a run has to outlive any chat session, and the agent worker is stopped when
 * idle. Agent tools reach it through `WrapperJobClient`.
 *
 * Each run is persisted in the run store as it happens (state, throttled
 * progress) and its full Nextflow log goes to `runs/<runId>/nextflow.log`, so
 * status can be answered from disk after a restart.
 */

const LOG_FILE = 'nextflow.log'
const LOG_TAIL_CHARS = 4000
const DEFAULT_MAX_CONCURRENT = 3
const DEFAULT_MAX_REMOTE_CONCURRENT = 10
const DEFAULT_PROGRESS_THROTTLE_MS = 2000

/** What a remote run needs to find its host: from the chat session that starts it, or (on resume) from the run record. */
export interface RemoteTargetRequest {
  originSessionId?: string
  projectId?: string
  connectionId?: string
}

export interface WrapperJobManagerOptions {
  agentDir?: () => string
  /** Resolves the saved HPC connection for a remote run. Without it, remote runs are refused. */
  resolveRemoteTarget?: (request: RemoteTargetRequest) => ResolvedRemoteTarget | { reason: string }
  /** `null` is a known ordinary session; `undefined` means its project identity cannot be proven. */
  resolveProjectForRun?: (originSessionId?: string) => Project | null | undefined
  checkRemoteEnvironment?: (input: {
    project: Project
    resolved: ResolvedRemoteTarget
    profile: WrapperExecutionProfile
  }) => Promise<WrapperTargetDoctorSnapshot>
  /** Local root the remote bundle is built from. Defaults to the bundled wrappers. */
  wrappersRoot?: () => string
  maxConcurrent?: number
  /** Cap on runs watched on remote hosts at once; they cost little locally. Default 10. */
  maxRemoteConcurrent?: number
  killGraceMs?: number
  progressThrottleMs?: number
}

interface LiveJob {
  run: WrapperRun
  entry: WrapperCompositionEntry
  params: Record<string, unknown>
  proc: WrapperProcess
  /** True for a run on a remote host. */
  remote: boolean
  tracker: ProgressTracker
  logPath: string
  startedMs: number
  lastPersistMs: number
  cancelRequested: boolean
  finalized: boolean
  finished: Promise<WrapperJobStatus>
}

function elapsedSeconds(run: WrapperRun, now = Date.now()): number {
  const start = Date.parse(run.startedAt ?? run.createdAt)
  const end = run.completedAt ? Date.parse(run.completedAt) : now
  return Math.max(0, Math.round((end - start) / 1000))
}

function readTail(path: string, maxChars: number): string {
  try {
    const text = readFileSync(path, 'utf-8')
    return text.length > maxChars ? text.slice(-maxChars) : text
  } catch {
    return ''
  }
}

function readSummary(runsDir: string, runId: string): { missingOutputs?: string[] } {
  try {
    return JSON.parse(readFileSync(join(runsDir, runId, 'summary.json'), 'utf-8')) as {
      missingOutputs?: string[]
    }
  } catch {
    return {}
  }
}

/** The head process as a Slurm job is `slurm-controller`; on the login node it is `slurm` or `remote-background`. */
function remoteExecutorName(hpc: RemoteHpcSettings | undefined): WrapperExecutor {
  if (hpc?.controller === 'sbatch') return 'slurm-controller'
  return hpc?.scheduler === 'slurm' ? 'slurm' : 'remote-background'
}

function compositionProfiles(
  remote: boolean,
  hpc?: RemoteHpcSettings
): WrapperManifestEngineProfile[] {
  return WRAPPER_EXECUTION_PROFILES.map((runtime) => ({
    id: runtime,
    executor: remote ? 'remote' : 'local',
    ...(remote
      ? {
          scheduler: hpc?.scheduler === 'slurm' ? ('slurm' as const) : ('none' as const),
          controller:
            hpc?.controller === 'sbatch' ? ('sbatch' as const) : ('detached_ssh' as const),
          containerRuntime: runtime
        }
      : {})
  }))
}

function remoteField(run: WrapperRun): { remote?: { host: string; runDir: string } } {
  return run.remote ? { remote: { host: run.remote.host, runDir: run.remote.runDir } } : {}
}

export class WrapperJobManager implements WrapperJobClient {
  private readonly live = new Map<string, LiveJob>()
  private readonly reported = new Set<string>()
  private readonly listeners = new Set<(runId: string) => void>()
  private readonly finishListeners = new Set<(run: WrapperRun, status: WrapperJobStatus) => void>()
  private readonly agentDir: () => string
  private readonly maxConcurrent: number
  private readonly maxRemoteConcurrent: number
  private readonly resolveRemote:
    NonNullable<WrapperJobManagerOptions['resolveRemoteTarget']> | undefined
  private readonly resolveProjectForRun: WrapperJobManagerOptions['resolveProjectForRun']
  private readonly checkRemoteEnvironment: WrapperJobManagerOptions['checkRemoteEnvironment']
  private readonly wrappersRoot: () => string
  private readonly killGraceMs: number | undefined
  private readonly progressThrottleMs: number

  constructor(options: WrapperJobManagerOptions = {}) {
    this.agentDir = options.agentDir ?? getPhiAgentDir
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
    this.maxRemoteConcurrent = options.maxRemoteConcurrent ?? DEFAULT_MAX_REMOTE_CONCURRENT
    this.resolveRemote = options.resolveRemoteTarget
    this.resolveProjectForRun = options.resolveProjectForRun
    this.checkRemoteEnvironment = options.checkRemoteEnvironment
    this.wrappersRoot = options.wrappersRoot ?? getBundledWrapperPackagesDir
    this.killGraceMs = options.killGraceMs
    this.progressThrottleMs = options.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS
  }

  onChange(listener: (runId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Called once when a run ends on its own (completed, failed or cancelled).
   * Not called when the app is shutting down: nobody is left to tell.
   */
  onFinish(listener: (run: WrapperRun, status: WrapperJobStatus) => void): () => void {
    this.finishListeners.add(listener)
    return () => this.finishListeners.delete(listener)
  }

  private emitFinish(runId: string): void {
    const run = readWrapperRun(runId, this.agentDir())
    const status = this.statusSync(runId)
    if (!run || !status) return
    for (const listener of this.finishListeners) {
      try {
        listener(run, status)
      } catch {
        // A broken listener must not disturb a run.
      }
    }
  }

  private emit(runId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(runId)
      } catch {
        // A broken listener must not disturb a run.
      }
    }
  }

  async start(input: {
    id: string
    overrides: Record<string, unknown>
    profile?: string
    target?: 'local' | 'remote'
    originSessionId?: string
    continueWhenDone?: boolean
  }): Promise<StartJobResult> {
    const { id, overrides } = input
    let targetReason: string | undefined
    const entry = findWrapperCompositionEntry(id)
    if (!entry) return { ok: false, error: `Wrapper not found: ${id}` }
    const projectContext = this.resolveProjectForRun?.(input.originSessionId)
    if (this.resolveProjectForRun && input.originSessionId && projectContext === undefined) {
      return { ok: false, error: '无法确认 Wrapper 请求所属的会话或项目，已拒绝本机执行。' }
    }
    const project = projectContext ?? undefined
    if (project?.location.kind === 'ssh' && input.target === 'local') {
      const decision = chooseWrapperTarget({
        projectLocation: project.location,
        explicitTarget: 'local',
        resourceClass: 'standard',
        profiles: compositionProfiles(false)
      })
      return { ok: false, error: decision.reason }
    }
    const shouldResolveRemote =
      input.target === 'remote' ||
      (input.target !== 'local' &&
        (project?.location.kind === 'ssh' ||
          Boolean(project?.defaultRemoteConnectionId && project.remoteWorkspaceRoot)))
    let resolved: ResolvedRemoteTarget | undefined
    if (shouldResolveRemote) {
      if (!this.resolveRemote) {
        return {
          ok: false,
          error: 'Remote runs are not available: no HPC connection support here.'
        }
      }
      const target = this.resolveRemote({ originSessionId: input.originSessionId })
      if ('reason' in target) return { ok: false, error: target.reason }
      resolved = target
    }
    const remote = resolved !== undefined
    let environmentWarnings: string[] = []
    const profile =
      input.profile ??
      (resolved ? (resolved.target.hpc?.runtime ?? DEFAULT_REMOTE_RUNTIME) : 'docker')
    if (!(WRAPPER_EXECUTION_PROFILES as readonly string[]).includes(profile)) {
      return {
        ok: false,
        error: `Invalid profile: ${profile}. Must be one of ${WRAPPER_EXECUTION_PROFILES.join(', ')}.`
      }
    }
    if (project) {
      const hostProfileId = resolved
        ? project.location.kind === 'ssh'
          ? project.location.hostProfileId
          : project.remoteConnections?.find((connection) => connection.id === resolved.connectionId)
              ?.hostProfileId
        : undefined
      const remoteCandidate =
        resolved && hostProfileId
          ? {
              hostProfileId,
              hostAlias: resolved.target.connection.host,
              connectionId: resolved.connectionId,
              workspaceRoot: resolved.target.workspaceRoot,
              hpc: {
                ...resolved.target.hpc,
                scheduler: resolved.target.hpc?.scheduler ?? 'local',
                runtime: profile as WrapperExecutionProfile
              }
            }
          : undefined
      const policyInput = {
        projectLocation: project.location,
        explicitTarget: input.target,
        selectedProfileId: profile,
        resourceClass: 'standard' as const,
        profiles: compositionProfiles(remote, resolved?.target.hpc),
        remote: remoteCandidate
      }
      const preliminary = chooseWrapperTarget(policyInput)
      if (preliminary.kind === 'blocked' && preliminary.code !== 'doctor_unavailable') {
        return { ok: false, error: preliminary.reason }
      }
      let doctor: WrapperTargetDoctorSnapshot | undefined
      if (resolved && this.checkRemoteEnvironment) {
        try {
          doctor = await this.checkRemoteEnvironment({
            project,
            resolved,
            profile: profile as WrapperExecutionProfile
          })
        } catch (error) {
          return {
            ok: false,
            error: `远程环境检查失败：${error instanceof Error ? error.message : String(error)}`
          }
        }
      }
      const decision = chooseWrapperTarget({ ...policyInput, doctor })
      if (decision.kind === 'blocked') return { ok: false, error: decision.reason }
      environmentWarnings =
        doctor?.report.checks
          .filter(
            (check) =>
              check.status === 'warning' &&
              ['nextflow', 'java', 'runtime', 'login_controller'].includes(check.id)
          )
          .map((check) => `${check.message}${check.suggestion ? `；${check.suggestion}` : ''}`) ??
        []
      targetReason = decision.reason
      if ((decision.target === 'remote') !== remote) {
        return { ok: false, error: 'Wrapper 执行目标与项目策略不一致，已停止提交。' }
      }
    }
    const defaults = readWrapperDefaultParams(entry.wrapperDir)
    const mapping =
      resolved && project?.location.kind === 'local'
        ? project.remoteConnections?.find((connection) => connection.id === resolved.connectionId)
            ?.inputPathMapping
        : undefined
    const mapped = resolveCompositionInputParams(
      entry.manifest,
      { ...defaults, ...overrides },
      {
        remote,
        projectLocation: project?.location,
        mapping
      }
    )
    if (mapped.errors.length > 0) {
      return {
        ok: false,
        error: `Invalid input paths for ${id}:\n${mapped.errors.map((error) => `- ${error}`).join('\n')}`
      }
    }
    // Input paths on a remote run live on the cluster; a local existence check would be wrong.
    const errors = validateWrapperParams(entry.manifest, {}, mapped.params, entry.componentDir, {
      checkInputPaths: !remote
    })
    if (errors.length > 0) {
      return {
        ok: false,
        error: `Invalid parameters for ${id}:\n${errors.map((error) => `- ${error}`).join('\n')}`
      }
    }
    const limit = remote ? this.maxRemoteConcurrent : this.maxConcurrent
    const running = [...this.live.values()].filter((job) => job.remote === remote).length
    if (running >= limit) {
      return {
        ok: false,
        error: `Too many ${remote ? 'remote ' : ''}wrapper runs are already running (limit ${limit}). Wait for one to finish or cancel it first.`
      }
    }

    const agentDir = this.agentDir()
    const params = mapped.params
    let run: WrapperRun
    try {
      run = startCompositionRun({
        entry,
        params,
        inputReferences: mapped.inputs,
        environmentWarnings,
        profile,
        targetReason,
        originSessionId: input.originSessionId,
        continueWhenDone: input.continueWhenDone,
        ...(resolved
          ? {
              remote: {
                host: resolved.target.connection.host,
                workspaceRoot: resolved.target.workspaceRoot,
                executor: remoteExecutorName(resolved.target.hpc),
                connectionId: resolved.connectionId,
                projectId: resolved.projectId,
                hostProfileId: resolved.hostProfileId
              }
            }
          : {}),
        agentDir
      })
    } catch (error) {
      return {
        ok: false,
        error: `Could not record the run: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    const logPath = join(getWrapperRunsDir(agentDir), run.runId, LOG_FILE)
    writeFileSync(logPath, '')
    const tracker = createProgressTracker({
      total: countDagProcesses(readWrapperCompositionDag(id))
    })

    const jobRef: { current?: LiveJob } = {}
    const onOutput = (chunk: string): void => {
      if (jobRef.current?.finalized) return
      appendFileSync(logPath, chunk)
      tracker.push(chunk)
      if (jobRef.current) this.persistProgress(jobRef.current)
    }
    for (const warning of environmentWarnings) onOutput(`警告：${warning}\n`)

    let proc: WrapperProcess
    try {
      proc = resolved
        ? startRemoteWrapperComposition({
            runId: run.runId,
            entry,
            params,
            inputReferences: mapped.inputs,
            profile,
            target: resolved.target,
            wrappersRoot: this.wrappersRoot(),
            onOutput,
            onSnapshot: (snapshot) => {
              if (!jobRef.current?.finalized) this.saveSnapshot(run.runId, snapshot)
            },
            killGraceMs: this.killGraceMs
          })
        : startWrapperComposition(entry.wrapperDir, params, profile as WrapperExecutionProfile, {
            onOutput,
            killGraceMs: this.killGraceMs
          })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      finishCompositionRun({
        run,
        entry,
        params,
        outcome: 'failed',
        exitCode: -1,
        output: message,
        missingOutputs: [],
        agentDir
      })
      this.emit(run.runId)
      return { ok: false, error: `Could not start Nextflow: ${message}` }
    }

    const started = this.trackJob({ run, entry, params, proc, remote, tracker, logPath })
    jobRef.current = started
    this.emit(run.runId)
    return { ok: true, status: this.liveStatus(started) }
  }

  private trackJob(input: {
    run: WrapperRun
    entry: WrapperCompositionEntry
    params: Record<string, unknown>
    proc: WrapperProcess
    remote: boolean
    tracker: ProgressTracker
    logPath: string
  }): LiveJob {
    const job: LiveJob = {
      ...input,
      startedMs: Date.now(),
      lastPersistMs: 0,
      cancelRequested: false,
      finalized: false,
      finished: Promise.resolve(undefined as never)
    }
    this.live.set(input.run.runId, job)
    job.finished = input.proc.done.then((result) => this.finalize(job, result))
    return job
  }

  private saveSnapshot(runId: string, snapshot: RemoteJobSnapshot): void {
    try {
      writeCompositionRemoteSnapshot(runId, snapshot, this.agentDir())
    } catch {
      // The snapshot only matters for resuming after a restart; never disturb the run for it.
    }
  }

  /**
   * Startup: picks up every remote run an earlier session left going and watches it to the
   * end. A run that cannot be reattached (connection removed, host unreachable at startup)
   * is recorded `lost` — its outcome is unknown, not a failure. Returns how many were adopted.
   */
  async adoptRemoteRuns(onlyRunId?: string): Promise<number> {
    const agentDir = this.agentDir()
    let adopted = 0
    for (const run of listWrapperRuns(agentDir)) {
      if (onlyRunId && run.runId !== onlyRunId) continue
      if (this.live.has(run.runId) || !isResumableRemoteRun(run, agentDir)) continue
      const entry = findWrapperCompositionEntry(run.wrapper.canonicalId)
      const snapshot = readCompositionRemoteSnapshot(run.runId, agentDir)
      const resolved = this.resolveRemote?.({
        projectId: run.remote?.projectId,
        connectionId: run.remote?.connectionId
      }) ?? { reason: 'Remote runs are not available.' }
      if (!entry || !snapshot || 'reason' in resolved) {
        const reason = !entry
          ? '重启后找不到 Wrapper 定义，无法核对远端运行'
          : !snapshot
            ? '重启后缺少远端运行快照'
            : 'reason' in resolved
              ? resolved.reason
              : '无法核对远端运行'
        markCompositionRunLost(run, agentDir, reason)
        this.emit(run.runId)
        continue
      }
      const expectedRunDir = `${resolved.target.workspaceRoot.replace(/\/+$/, '')}/wrappers/runs/${run.runId}`
      if (
        snapshot.runId !== run.runId ||
        snapshot.remoteRunDir !== expectedRunDir ||
        run.remote?.host !== resolved.target.connection.host ||
        run.remote?.runDir !== expectedRunDir
      ) {
        markCompositionRunLost(run, agentDir, '远端运行快照与项目绑定的主机或目录不一致')
        this.emit(run.runId)
        continue
      }

      const logPath = join(getWrapperRunsDir(agentDir), run.runId, LOG_FILE)
      const tracker = createProgressTracker({
        total: countDagProcesses(readWrapperCompositionDag(run.wrapper.canonicalId))
      })
      // The local log holds everything delivered before the restart; replay it so counts carry on.
      tracker.push(readTail(logPath, Number.MAX_SAFE_INTEGER))
      const proc = attachRemoteWrapperComposition({
        snapshot,
        entry,
        target: resolved.target,
        onOutput: (chunk) => {
          const job = this.live.get(run.runId)
          if (job?.finalized) return
          appendFileSync(logPath, chunk)
          tracker.push(chunk)
          if (job) this.persistProgress(job)
        },
        onSnapshot: (next) => {
          if (!this.live.get(run.runId)?.finalized) this.saveSnapshot(run.runId, next)
        },
        onStatus: (status) => {
          const job = this.live.get(run.runId)
          if (job?.finalized || status.outcome !== 'running') return
          if (!job || job.run.state !== 'lost' || job.cancelRequested) return
          try {
            job.run = markCompositionRunRunning(job.run, agentDir)
            this.emit(run.runId)
          } catch {
            // Reconciliation evidence remains valid even if local persistence fails.
          }
        },
        killGraceMs: this.killGraceMs
      })
      this.trackJob({
        run,
        entry,
        params: snapshot.params,
        proc,
        remote: true,
        tracker,
        logPath
      })
      this.emit(run.runId)
      adopted += 1
    }
    return adopted
  }

  private persistProgress(job: LiveJob): void {
    const now = Date.now()
    if (job.finalized || now - job.lastPersistMs < this.progressThrottleMs) return
    job.lastPersistMs = now
    try {
      job.run = {
        ...job.run,
        progress: job.tracker.snapshot(),
        updatedAt: new Date(now).toISOString()
      }
      writeWrapperRun(job.run, this.agentDir())
      this.emit(job.run.runId)
    } catch {
      // Progress is advisory; never disturb the run for it.
    }
  }

  private finalize(job: LiveJob, result: WrapperRunResult): WrapperJobStatus {
    const runId = job.run.runId
    if (job.finalized) return this.statusSync(runId) as WrapperJobStatus
    job.finalized = true
    // Phi let go of a remote run that carries on remotely; its record stays `running` so the
    // next start can pick it up again.
    if (result.detached) {
      this.live.delete(runId)
      return this.statusSync(runId) as WrapperJobStatus
    }

    const missing = result.remote
      ? result.remote.missingOutputs
      : result.success
        ? findMissingPrimaryOutputs(job.entry.manifest, job.params, job.entry.componentDir)
        : []
    const outcome: CompositionRunOutcome = result.cancelled
      ? 'cancelled'
      : result.lost
        ? 'lost'
        : result.success && missing.length === 0
          ? 'completed'
          : 'failed'
    try {
      finishCompositionRun({
        run: job.run,
        entry: job.entry,
        params: job.params,
        outcome,
        exitCode: result.exitCode,
        output: result.output || job.tracker.tail(),
        missingOutputs: missing,
        progress: job.tracker.snapshot(),
        // A remote run's outputs are on the cluster, out of reach of a local existsSync.
        ...(result.remote ? { outputs: result.remote.outputs } : job.remote ? { outputs: [] } : {}),
        agentDir: this.agentDir()
      })
    } catch {
      // The run itself is over; a store problem only costs the record.
    }
    this.live.delete(runId)
    this.emit(runId)
    this.emitFinish(runId)
    return this.statusSync(runId) as WrapperJobStatus
  }

  private liveStatus(job: LiveJob): WrapperJobStatus {
    return {
      runId: job.run.runId,
      wrapperId: job.run.wrapper.canonicalId,
      state: job.run.state,
      profile: job.run.profile,
      ...(job.run.targetReason ? { targetReason: job.run.targetReason } : {}),
      outDir: job.run.outDir,
      startedAt: job.run.startedAt,
      elapsedSeconds: Math.max(0, Math.round((Date.now() - job.startedMs) / 1000)),
      progress: job.tracker.snapshot(),
      logTail: job.tracker.tail(LOG_TAIL_CHARS),
      ...remoteField(job.run)
    }
  }

  /** Live snapshot when the run is in flight, otherwise what is on disk. */
  statusSync(runId: string): WrapperJobStatus | undefined {
    const job = this.live.get(runId)
    if (job) return this.liveStatus(job)

    const agentDir = this.agentDir()
    const run = readWrapperRun(runId, agentDir)
    if (!run) return undefined
    const runsDir = getWrapperRunsDir(agentDir)
    return {
      runId: run.runId,
      wrapperId: run.wrapper.canonicalId,
      state: run.state,
      profile: run.profile,
      ...(run.targetReason ? { targetReason: run.targetReason } : {}),
      outDir: run.outDir,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.completedAt ? { completedAt: run.completedAt } : {}),
      elapsedSeconds: elapsedSeconds(run),
      ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
      progress: run.progress ?? { started: 0 },
      logTail: readTail(join(runsDir, run.runId, LOG_FILE), LOG_TAIL_CHARS),
      ...(run.outputs ? { outputs: run.outputs } : {}),
      ...(TERMINAL_RUN_STATES.includes(run.state)
        ? { missingOutputs: readSummary(runsDir, run.runId).missingOutputs ?? [] }
        : {}),
      ...remoteField(run)
    }
  }

  async status(runId: string): Promise<WrapperJobStatus | undefined> {
    return this.noteReported(this.statusSync(runId))
  }

  /**
   * True once an agent has been handed this run's final outcome (through `wait` or
   * `status`). Finishing on its own does not count. Used so Phi does not wake a
   * conversation to announce a result the agent already reported in the same turn.
   */
  hasBeenReported(runId: string): boolean {
    return this.reported.has(runId)
  }

  private noteReported(status: WrapperJobStatus | undefined): WrapperJobStatus | undefined {
    if (status && TERMINAL_RUN_STATES.includes(status.state)) this.reported.add(status.runId)
    return status
  }

  async list(limit = 10): Promise<WrapperJobSummary[]> {
    const runs = listWrapperRuns(this.agentDir())
      .filter((run) => run.origin === 'composition')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, limit))
    return runs.map((stored) => {
      const run = this.live.get(stored.runId)?.run ?? stored
      return {
        runId: run.runId,
        wrapperId: run.wrapper.canonicalId,
        state: run.state,
        ...(run.startedAt ? { startedAt: run.startedAt } : {}),
        elapsedSeconds: elapsedSeconds(run)
      }
    })
  }

  async cancel(runId: string): Promise<CancelJobResult> {
    let job = this.live.get(runId)
    if (!job) {
      const stored = readWrapperRun(runId, this.agentDir())
      if (stored?.origin === 'composition' && stored.remote && stored.state === 'lost') {
        await this.adoptRemoteRuns(runId)
        job = this.live.get(runId)
      }
      if (!job && stored?.remote && ['completed', 'failed', 'cancelled'].includes(stored.state)) {
        const status = this.statusSync(runId)
        if (status) return { ok: true, status }
      }
    }
    if (!job) {
      const stored = readWrapperRun(runId, this.agentDir())
      return {
        ok: false,
        error: stored
          ? `Run ${runId} is not running (state: ${stored.state}); nothing to cancel.`
          : `Run not found: ${runId}`
      }
    }
    if (!job.cancelRequested) {
      job.cancelRequested = true
      try {
        job.run = markCompositionRunCancelling(job.run, this.agentDir())
      } catch {
        // The kill below is what matters.
      }
      job.proc.cancel()
      this.emit(runId)
    }
    return { ok: true, status: this.liveStatus(job) }
  }

  async wait(runId: string, timeoutMs: number): Promise<WrapperJobStatus | undefined> {
    const job = this.live.get(runId)
    if (!job) return this.noteReported(this.statusSync(runId))

    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs))
    })
    try {
      const outcome = await Promise.race([job.finished, timeout])
      return this.noteReported(outcome === 'timeout' ? this.statusSync(runId) : outcome)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * App is quitting: detach remote watchers without signalling their jobs;
   * stop only local child processes before the main process exits.
   */
  shutdown(): void {
    for (const job of [...this.live.values()]) {
      if (job.finalized) continue
      job.finalized = true
      if (job.remote && job.proc.detach) {
        // A remote run outlives the app: stop watching it, leave it running, and keep its
        // record as it is so the next start reattaches (see adoptRemoteRuns).
        job.proc.detach()
        this.live.delete(job.run.runId)
        continue
      }
      job.proc.cancel()
      try {
        finishCompositionRun({
          run: job.run,
          entry: job.entry,
          params: job.params,
          outcome: 'cancelled',
          exitCode: -1,
          output: job.tracker.tail(),
          missingOutputs: [],
          progress: job.tracker.snapshot(),
          agentDir: this.agentDir()
        })
      } catch {
        // Best effort: startup reconciliation marks anything left over as lost.
      }
      this.live.delete(job.run.runId)
    }
    killAllWrapperProcesses()
  }
}
