import { connectRemoteSshSession, shellQuote, type RemoteSshSession } from './remote-ssh-session'
import type { RemoteHpcSettings } from '../../../shared/wrapperRemoteTypes'
import { sbatchFlags } from './composition/remote-config'
import {
  claimRemoteLaunch,
  observeRemoteLaunch,
  REMOTE_JOB_ID_FILE,
  REMOTE_LAUNCH_ERROR_FILE,
  RemoteLaunchRejectedError,
  RemoteLaunchUnknownError,
  type RemoteLaunchObservation
} from './remote-launch-claim'
import {
  joinRemote,
  readRemoteLog,
  LOG_STDOUT,
  LOG_STDERR,
  EXIT_CODE_FILE,
  type ConnectImpl,
  type RemoteJobHandle,
  type RemoteLaunchSpec,
  type RemoteRunner,
  type RemoteRunStatus,
  type RemoteControllerOptions
} from './executor-remote'
import type { WrapperRun, WrapperRunPlan } from './types'
import { cancelSlurmControllerJob } from './remote-slurm-controller-cancel'

export { signalSlurmJob } from './remote-slurm-controller-cancel'

/**
 * The `sbatch` controller (`slurm-controller` executor) from
 * docs/design/phi-wrapper-technical-design.md — the top-level Nextflow
 * process is itself submitted as a Slurm job, rather than launched as a
 * detached SSH process (see `executor-remote.ts`'s `SshExecRunner` for
 * that, the `detached_ssh` controller used by `remote-background` and
 * default-profile `slurm`). Used when login nodes can't host a long-lived
 * detached process and everything — including the controller — has to go
 * through the scheduler.
 *
 * Unlike `detached_ssh`, Slurm itself is the source of truth for job state
 * (`squeue` while queued/running, then `scontrol show job` and — only if
 * that comes up empty — `sacct`) — there's no self-written `pid`/`exit_code`
 * file to poll, `RemoteJobHandle.jobId` (the Slurm job id) is enough.
 */

const JOB_NAME_PREFIX = 'phi-'
/** Terminal sacct states that mean the job is not going to run again. */
const FAILED_STATES = [
  'FAILED',
  'CANCELLED',
  'TIMEOUT',
  'OUT_OF_MEMORY',
  'NODE_FAIL',
  'BOOT_FAIL',
  'DEADLINE'
]

function sanitizeJobName(runId: string): string {
  // Slurm job names accept most characters, but keep this conservative
  // (alnum, `-`, `_`) since it ends up unquoted-ish in squeue/sacct output
  // that gets parsed back.
  return `${JOB_NAME_PREFIX}${runId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

/**
 * `WrapperResourceRequest.memory` is a free-text label like "8 GB" (see
 * wrapper.yaml fixtures) — Slurm's `--mem` wants a compact form like "8G".
 * Returns undefined (meaning: omit the flag) rather than guessing on
 * anything it doesn't recognize — an omitted resource request is always
 * safer than a malformed `sbatch` flag that rejects the whole submission.
 */
export function normalizeSlurmMemory(memory: string): string | undefined {
  const match = memory.trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?$/i)
  if (!match) return undefined
  const [, amount, unit] = match
  return `${amount}${(unit || 'M').toUpperCase()}`
}

/**
 * `WrapperResourceRequest.time` is a free-text label like "2h" — Slurm's
 * `--time` wants `D-HH:MM:SS` (or `HH:MM:SS`). Same "omit over malform"
 * rule as `normalizeSlurmMemory`.
 */
export function normalizeSlurmTime(time: string): string | undefined {
  const match = time.trim().match(/^(\d+(?:\.\d+)?)\s*(d|h|m|min|s)$/i)
  if (!match) return undefined
  const amount = Number.parseFloat(match[1])
  const unit = match[2].toLowerCase()
  const totalSeconds = Math.ceil(
    amount * (unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit.startsWith('m') ? 60 : 1)
  )
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const clock = [hours, minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':')
  return days > 0 ? `${days}-${clock}` : clock
}

/**
 * Pure script builder — kept separate from `SbatchRunner` so it's testable
 * without a connection, matching `buildDetachedLaunchCommand`'s split in
 * `executor-remote.ts`. Assumes `remoteRunDir` has no spaces — `#SBATCH`
 * directive values aren't shell-quoted the way exec commands are.
 */
export function buildSbatchScript(
  run: WrapperRun,
  plan: WrapperRunPlan,
  remoteRunDir: string,
  hpc?: RemoteHpcSettings
): string {
  const lines = [
    '#!/bin/bash',
    `#SBATCH --job-name=${sanitizeJobName(run.runId)}`,
    `#SBATCH --chdir=${remoteRunDir}`,
    `#SBATCH --output=${joinRemote(remoteRunDir, LOG_STDOUT)}`,
    `#SBATCH --error=${joinRemote(remoteRunDir, LOG_STDERR)}`
  ]
  const { cpus, memory, time } = plan.resources
  if (cpus !== undefined) lines.push(`#SBATCH --cpus-per-task=${cpus}`)
  const mem = memory !== undefined ? normalizeSlurmMemory(memory) : undefined
  if (mem !== undefined) lines.push(`#SBATCH --mem=${mem}`)
  const wallTime = time !== undefined ? normalizeSlurmTime(time) : undefined
  if (wallTime !== undefined) lines.push(`#SBATCH --time=${wallTime}`)
  for (const [flag, value] of [
    ['--partition', hpc?.queue],
    ['--account', hpc?.account]
  ]) {
    if (value) {
      if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
        throw new Error(`${flag} 包含非法字符，请检查 Slurm 运行配置。`)
      }
      lines.push(`#SBATCH ${flag}=${value}`)
    }
  }
  lines.push(...sbatchFlags(hpc?.controllerOptions).map((flag) => `#SBATCH ${flag}`))
  lines.push('', 'bash launch.sh')
  return `${lines.join('\n')}\n`
}

/** Parses `sbatch`'s stdout — normally `Submitted batch job 12345`. */
export function parseSbatchJobId(stdout: string): string | undefined {
  const match = stdout.match(/Submitted batch job (\d+)/)
  return match?.[1]
}

type ParsedSlurmStatus = { state: string; exitCode?: number; exitSignal?: number }

/**
 * Parses one `sacct -n -P --format=JobID,State,ExitCode` line for the exact
 * job id (not its `.batch`/`.extern` sub-steps, which sacct also lists).
 */
function parseSacctLine(stdout: string, jobId: string): ParsedSlurmStatus | undefined {
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.split('|')[0] === jobId)
  if (!line) return undefined
  const [, state = '', exitCodeRaw = ''] = line.split('|')
  const [codeRaw, signalRaw] = exitCodeRaw.split(':')
  const exitCode = Number.parseInt(codeRaw, 10)
  const exitSignal = Number.parseInt(signalRaw, 10)
  return {
    state,
    exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
    ...(Number.isFinite(exitSignal) && exitSignal !== 0 ? { exitSignal } : {})
  }
}

/**
 * Parses `scontrol show job <id>`'s free-text `JobState`/`ExitCode` report.
 * `sacct` can be unavailable (`accounting_storage_slurmdbd.so` fails to load —
 * no working `slurmdbd`) while `squeue`/`sbatch`/`scancel`/`scontrol` all
 * work fine: `scontrol` only talks to `slurmctld`, which every Slurm
 * install runs, unlike the optional accounting daemon `sacct` depends on.
 * Its tradeoff is retention, not availability — `slurmctld` only remembers
 * a finished job for a limited, admin-configurable window (`MinJobAge`)
 * before purging it, so this can't replace `sacct` as a permanent record,
 * but for a poll loop checking every few seconds it's the more reliable
 * source in practice. `status()` below tries this first and falls back to
 * `sacct` only when `scontrol` doesn't have an answer either.
 */
function parseScontrolShowJob(stdout: string): ParsedSlurmStatus | undefined {
  const stateMatch = stdout.match(/JobState=(\S+)/)
  if (!stateMatch) return undefined
  const exitMatch = stdout.match(/ExitCode=(\d+):(\d+)/)
  const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : undefined
  const exitSignal = exitMatch ? Number.parseInt(exitMatch[2], 10) : undefined
  return { state: stateMatch[1], exitCode, ...(exitSignal ? { exitSignal } : {}) }
}

/**
 * State of a Slurm job from the scheduler's own evidence: `squeue` while it is queued or running,
 * then `scontrol show job`, then `sacct` (in that order; see `parseScontrolShowJob` for why).
 * Free functions (not just `SbatchRunner` methods) so a caller that manages its own session,
 * e.g. to reconnect after a dropped link, can use them.
 */
export async function readSlurmJobStatus(
  session: RemoteSshSession,
  jobId: string | undefined
): Promise<RemoteRunStatus> {
  if (jobId === undefined) return { outcome: 'lost' }

  // Still queued or running: squeue only lists active jobs, so any
  // output at all means "not finished yet" — the exact state
  // (PENDING/RUNNING/CONFIGURING/…) doesn't matter to our 4-state model.
  const queued = await session.exec(`squeue -h -j ${jobId} -o %T 2>/dev/null`)
  if (queued.stdout.trim().length > 0) {
    return { outcome: 'running' }
  }

  // Fallen out of the queue — ask for the final state. scontrol first:
  // it only needs slurmctld (always running), whereas sacct needs a
  // working slurmdbd connection that real clusters sometimes don't have
  // (see parseScontrolShowJob's doc comment). Only fall back to sacct
  // when scontrol's short retention window has already passed.
  const control = await session.exec(`scontrol show job ${jobId} 2>/dev/null`)
  let parsed = parseScontrolShowJob(control.stdout)
  if (!parsed) {
    // sacct lists the job plus `.batch`/`.extern` sub-steps;
    // parseSacctLine picks the exact job-id row.
    const acct = await session.exec(
      `sacct -n -P -j ${jobId} --format=JobID,State,ExitCode 2>/dev/null`
    )
    parsed = parseSacctLine(acct.stdout, jobId)
  }
  if (!parsed) {
    // Neither squeue, scontrol, nor sacct know this job — accounting may
    // not be enabled, scontrol's retention window already passed, or
    // both. Same "don't guess" rule as the design doc's reconciliation
    // guidance for detached_ssh.
    return { outcome: 'lost' }
  }
  const signal = parsed.exitSignal ? { exitSignal: parsed.exitSignal } : {}
  if (parsed.state.startsWith('COMPLETED'))
    return { outcome: 'completed', exitCode: parsed.exitCode ?? 0, ...signal }
  if (FAILED_STATES.some((state) => parsed.state.startsWith(state))) {
    return {
      outcome: 'failed',
      exitCode: parsed.exitCode,
      ...signal,
      detail: parsed.state
    }
  }
  // An sacct state we don't recognize, or a PENDING/RUNNING row that
  // raced ahead of squeue falling behind — treat as still running rather
  // than guessing a terminal outcome.
  return { outcome: 'running' }
}

/** The `sbatch` controller — see module doc comment above. */
export class SbatchRunner implements RemoteRunner {
  private readonly options: RemoteControllerOptions
  private readonly connectImpl: ConnectImpl
  private sessionPromise: Promise<RemoteSshSession> | undefined

  constructor(options: RemoteControllerOptions) {
    this.options = options
    this.connectImpl = options.connectImpl ?? connectRemoteSshSession
  }

  private getSession(): Promise<RemoteSshSession> {
    if (!this.sessionPromise) {
      this.sessionPromise = this.connectImpl(this.options.connection)
    }
    return this.sessionPromise
  }

  private handleFromObservation(
    run: WrapperRun,
    remoteRunDir: string,
    observation: RemoteLaunchObservation
  ): RemoteJobHandle | undefined {
    return observation.kind === 'started'
      ? { runId: run.runId, remoteRunDir, jobId: observation.jobId }
      : undefined
  }

  async submit(
    run: WrapperRun,
    plan: WrapperRunPlan,
    launch: RemoteLaunchSpec
  ): Promise<RemoteJobHandle> {
    const session = await this.getSession()
    let claimAttempted = false
    try {
      const before = await observeRemoteLaunch(session, launch.remoteRunDir, run.runId, 'sbatch')
      const prior = this.handleFromObservation(run, launch.remoteRunDir, before)
      if (prior) return prior
      if (before.kind === 'rejected') throw new RemoteLaunchRejectedError(before.reason)
      if (before.kind === 'unknown') {
        throw new RemoteLaunchUnknownError(run.runId, launch.remoteRunDir, before.reason)
      }
      claimAttempted = true
      if (!(await claimRemoteLaunch(session, launch.remoteRunDir, run.runId))) {
        const existing = await observeRemoteLaunch(
          session,
          launch.remoteRunDir,
          run.runId,
          'sbatch'
        )
        const found = this.handleFromObservation(run, launch.remoteRunDir, existing)
        if (found) return found
        if (existing.kind === 'rejected') throw new RemoteLaunchRejectedError(existing.reason)
        throw new RemoteLaunchUnknownError(run.runId, launch.remoteRunDir, '另一提交已声明该运行')
      }
      await session.mkdirp(joinRemote(launch.remoteRunDir, 'logs'))
      await session.writeTextFile(joinRemote(launch.remoteRunDir, 'launch.sh'), launch.launchScript)
      await session.writeTextFile(joinRemote(launch.remoteRunDir, 'params.json'), launch.paramsJson)
      if (launch.nextflowConfig !== undefined) {
        await session.writeTextFile(
          joinRemote(launch.remoteRunDir, 'nextflow.config'),
          launch.nextflowConfig
        )
      }
      const sbatchPath = joinRemote(launch.remoteRunDir, 'job.sbatch')
      await session.writeTextFile(
        sbatchPath,
        buildSbatchScript(run, plan, launch.remoteRunDir, launch.hpc)
      )
      const result = await session.exec(`sbatch ${shellQuote(sbatchPath)}`)
      if (result.code !== 0) {
        const reason = `sbatch 提交失败（run ${run.runId}）: ${result.stderr || result.stdout}`
        await session.writeTextFile(
          joinRemote(launch.remoteRunDir, REMOTE_LAUNCH_ERROR_FILE),
          `${reason}\n`
        )
        throw new RemoteLaunchRejectedError(reason)
      }
      const jobId = parseSbatchJobId(result.stdout)
      if (jobId === undefined) {
        throw new Error(`无法解析 sbatch 返回的作业号（run ${run.runId}）: ${result.stdout}`)
      }
      await session.writeTextFile(joinRemote(launch.remoteRunDir, REMOTE_JOB_ID_FILE), `${jobId}\n`)
      return { runId: run.runId, remoteRunDir: launch.remoteRunDir, jobId }
    } catch (error) {
      if (
        error instanceof RemoteLaunchUnknownError ||
        error instanceof RemoteLaunchRejectedError ||
        !claimAttempted
      )
        throw error
      let fresh: RemoteSshSession | undefined
      let rejected: string | undefined
      try {
        fresh = await this.connectImpl(this.options.connection)
        const observed = await observeRemoteLaunch(fresh, launch.remoteRunDir, run.runId, 'sbatch')
        const found = this.handleFromObservation(run, launch.remoteRunDir, observed)
        if (found) {
          await session.close().catch(() => undefined)
          this.sessionPromise = Promise.resolve(fresh)
          return found
        }
        if (observed.kind === 'rejected') rejected = observed.reason
      } catch {
        // The claim still prevents a replay; the run remains unknown until the host is reachable.
      }
      await fresh?.close().catch(() => undefined)
      this.sessionPromise = undefined
      if (rejected) throw new RemoteLaunchRejectedError(rejected)
      throw new RemoteLaunchUnknownError(
        run.runId,
        launch.remoteRunDir,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  async status(handle: RemoteJobHandle): Promise<RemoteRunStatus> {
    const session = await this.getSession()
    const scheduler = await readSlurmJobStatus(session, handle.jobId)
    if (scheduler.outcome === 'running') return scheduler
    const exitPath = joinRemote(handle.remoteRunDir, EXIT_CODE_FILE)
    if (!(await session.exists(exitPath))) return scheduler
    const raw = (await session.readTextFile(exitPath)).trim()
    if (!/^[0-9]+$/.test(raw)) return scheduler
    const code = Number(raw)
    return Number.isSafeInteger(code)
      ? { outcome: code === 0 ? 'completed' : 'failed', exitCode: code }
      : scheduler
  }

  async tailLog(handle: RemoteJobHandle, stream: 'stdout' | 'stderr' = 'stdout'): Promise<string> {
    const session = await this.getSession()
    return readRemoteLog(session, handle.remoteRunDir, stream)
  }

  async cancel(handle: RemoteJobHandle): Promise<void> {
    const session = await this.getSession()
    await cancelSlurmControllerJob(session, handle, () => this.status(handle))
  }

  async close(): Promise<void> {
    if (!this.sessionPromise) return
    const session = await this.sessionPromise
    await session.close()
  }
}
