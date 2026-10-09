import {
  connectRemoteSshSession,
  shellQuote,
  type RemoteConnectionConfig,
  type RemoteSshSession
} from './remote-ssh-session'
import type { WrapperRun, WrapperRunPlan } from './types'
import type { RemoteHpcSettings } from '../../../shared/wrapperRemoteTypes'
import { setTimeout as delay } from 'node:timers/promises'
import {
  claimRemoteLaunch,
  observeRemoteLaunch,
  RemoteLaunchRejectedError,
  RemoteLaunchUnknownError,
  verifyRemoteCancelTarget,
  type RemoteLaunchObservation
} from './remote-launch-claim'
import { readRemoteLogTail } from './remote-log'

/**
 * Remote execution, per docs/design/phi-wrapper-technical-design.md
 * ("Executor Model" / "Remote Background" / "Slurm"). Two controller
 * mechanisms are described there:
 *
 *  - `detached_ssh` — a `setsid`-launched background script Phi polls over
 *    SSH. Used by BOTH the `remote-background` executor and the *default*
 *    `slurm` profile (Nextflow itself submits per-process jobs to Slurm;
 *    the top-level Nextflow process is still just a detached SSH launch).
 *  - `sbatch` — the top-level Nextflow process is itself submitted as a
 *    Slurm job. Named `slurm-controller`, used when login nodes can't host
 *    a long-lived detached process.
 *
 * `SshExecRunner` below implements only `detached_ssh` — it covers
 * `remote-background` and default-profile `slurm` unchanged. The
 * `sbatch`-based runner for `slurm-controller` is `executor-slurm.ts`'s
 * `SbatchRunner` — a separate `RemoteRunner` implementation sharing this
 * module's types and log-reading helper. Other schedulers (PBS, LSF) get
 * their own dialect-specific runner later, once there's a real target
 * cluster to verify commands/output-parsing against.
 */

export interface RemoteJobHandle {
  runId: string
  remoteRunDir: string
  /** PID of the detached process — set by the `detached_ssh` controller (SshExecRunner). */
  pid?: number
  /** Scheduler job id — set by scheduler controllers (e.g. SbatchRunner). Exactly one of pid/jobId is set. */
  jobId?: string
}

export type RemoteRunOutcome = 'running' | 'completed' | 'failed' | 'lost'

export interface RemoteRunStatus {
  outcome: RemoteRunOutcome
  /** Present once the process has exited and recorded its exit code. */
  exitCode?: number
  /** Scheduler-reported signal component, e.g. 15 from Slurm `ExitCode=0:15`. */
  exitSignal?: number
  /** The scheduler's own state name when it ended badly (e.g. `TIMEOUT`, `OUT_OF_MEMORY`). */
  detail?: string
}

export interface RemoteLaunchSpec {
  /** Absolute remote path the run executes in — created if missing. */
  remoteRunDir: string
  /**
   * Written as `launch.sh` and run via `setsid bash launch.sh`. Must record
   * its own exit code to the `exit_code` file in `remoteRunDir` on
   * completion; the shared configured launch script and `wrapWithExitCodeTrap`
   * both provide this for detached runs.
   * Building the actual Nextflow invocation (the remote counterpart to
   * executor-nextflow.ts's `buildNextflowInvocation`) is a separate concern,
   * not this module's.
   */
  launchScript: string
  /** Written as `params.json` alongside the launch script. */
  paramsJson: string
  /** Written as `nextflow.config`, when the plan's profile needs one (e.g. `-profile slurm`). */
  nextflowConfig?: string
  /** The selected run settings used for the head job's sbatch directives. */
  hpc?: RemoteHpcSettings
}

/**
 * A controller that can launch a wrapper run on a remote host, and later
 * poll/tail/cancel it — independent of whether the local Phi process that
 * submitted it is still running (a reconnect must be able to rebuild a
 * `RemoteJobHandle` from a persisted run record and pick up polling again).
 */
export interface RemoteRunner {
  submit(run: WrapperRun, plan: WrapperRunPlan, launch: RemoteLaunchSpec): Promise<RemoteJobHandle>
  status(handle: RemoteJobHandle): Promise<RemoteRunStatus>
  tailLog(handle: RemoteJobHandle, stream?: 'stdout' | 'stderr'): Promise<string>
  /** Best-effort. Never throws for "already gone" — cancelling a finished run is a no-op. */
  cancel(handle: RemoteJobHandle): Promise<void>
  close(): Promise<void>
}

export type ConnectImpl = (config: RemoteConnectionConfig) => Promise<RemoteSshSession>

export interface RemoteControllerOptions {
  connection: RemoteConnectionConfig
  /**
   * Injectable so tests can fake the SSH session without a real network
   * connection — mirrors `executor-local.ts`'s `spawnImpl`/`doctorImpl`
   * pattern, called out in the design doc as worth repeating here
   * ("What Phase 2 Needs From Phase 1").
   */
  connectImpl?: ConnectImpl
}

export const LOG_STDOUT = 'logs/stdout.log'
export const LOG_STDERR = 'logs/stderr.log'
export const EXIT_CODE_FILE = 'exit_code'
const PID_FILE = 'pid'

export function joinRemote(dir: string, ...parts: string[]): string {
  return [dir, ...parts].join('/')
}

/**
 * Shared by every `RemoteRunner` — regardless of controller, logs always
 * land at the same relative path under `remoteRunDir` (either via shell
 * redirection in `buildDetachedLaunchCommand`, or via `#SBATCH --output`/
 * `--error` in `executor-slurm.ts`'s sbatch script).
 */
export async function readRemoteLog(
  session: RemoteSshSession,
  remoteRunDir: string,
  stream: 'stdout' | 'stderr' = 'stdout'
): Promise<string> {
  const path = joinRemote(remoteRunDir, stream === 'stdout' ? LOG_STDOUT : LOG_STDERR)
  return readRemoteLogTail(session, path)
}

/**
 * Wraps a command so it always records its exit code, even on signal
 * termination — `SshExecRunner.status()` depends on this file existing
 * once the process is gone to tell "completed"/"failed" apart from "lost".
 * Whatever builds `launch.sh`'s real command should wrap it with this.
 */
export function wrapWithExitCodeTrap(command: string): string {
  return `${command}\necho $? > ${shellQuote(EXIT_CODE_FILE)}\n`
}

/**
 * Pure command builder — kept separate from `SshExecRunner` so it's
 * testable without a connection, matching `executor-nextflow.ts`'s split
 * between "build the command" (`buildNextflowInvocation`) and "actually run
 * it" (`executor-local.ts`).
 */
export function buildDetachedLaunchCommand(remoteRunDir: string): string {
  const logsDir = joinRemote(remoteRunDir, 'logs')
  const stdout = joinRemote(remoteRunDir, LOG_STDOUT)
  const stderr = joinRemote(remoteRunDir, LOG_STDERR)
  const launchScript = joinRemote(remoteRunDir, 'launch.sh')
  const pidFile = joinRemote(remoteRunDir, PID_FILE)
  // `&` already terminates a command the way `;`/`&&` do — chaining `&&`
  // straight after it (`cmd & && next`) is a bash syntax error, not merely
  // "runs everything sequentially anyway". This was caught by actually
  // running the generated string through a real `bash -c`, not by the
  // regex-based tests that previously covered this function (they matched
  // substrings and never executed the result). The parenthesized subshell
  // backgrounds `setsid` and captures `$!` inside it, in sequence, so the
  // `&&` chain around it stays valid and $! still refers to the right pid.
  const launchAndCapturePid = [
    `setsid bash ${shellQuote(launchScript)} > ${shellQuote(stdout)} 2> ${shellQuote(stderr)} < /dev/null &`,
    `echo $! > ${shellQuote(pidFile)}`
  ].join(' ')
  return [
    `mkdir -p ${shellQuote(logsDir)}`,
    `cd ${shellQuote(remoteRunDir)}`,
    `( ${launchAndCapturePid} )`,
    `cat ${shellQuote(pidFile)}`
  ].join(' && ')
}

/**
 * State of a `detached_ssh` run from the remote's own evidence: a recorded
 * exit code outranks a lingering process-table entry; otherwise check the PID. Free functions (not just `SshExecRunner`
 * methods) so a caller that manages its own session, e.g. to reconnect after a dropped
 * link, can use them.
 */
export async function readDetachedStatus(
  session: RemoteSshSession,
  handle: RemoteJobHandle
): Promise<RemoteRunStatus> {
  const exitCodePath = joinRemote(handle.remoteRunDir, EXIT_CODE_FILE)
  const recordedExit = async (): Promise<RemoteRunStatus | undefined> => {
    if (await session.exists(exitCodePath)) {
      const raw = (await session.readTextFile(exitCodePath)).trim()
      const exitCode = Number(raw)
      if (/^[0-9]+$/.test(raw) && Number.isSafeInteger(exitCode)) {
        return { outcome: exitCode === 0 ? 'completed' : 'failed', exitCode }
      }
    }
    return undefined
  }
  const saved = await recordedExit()
  if (saved) return saved
  if (handle.pid !== undefined) {
    const alive = await session.exec(`kill -0 ${handle.pid} 2>/dev/null && echo alive || echo dead`)
    if (alive.stdout.trim() === 'alive') return { outcome: 'running' }
    // The shell writes exit_code just before exiting. A dead PID can briefly precede that write.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await delay(100)
      const late = await recordedExit()
      if (late) return late
    }
  }
  // No process or durable exit code: the host may have rebooted. Never infer failure.
  return { outcome: 'lost' }
}

/**
 * Signals the whole process group of a `detached_ssh` run. `setsid` made the launched
 * process its own session/group leader, so its pid doubles as the process group id:
 * `kill -<pid>` takes the whole Nextflow + child job tree with it, not just the top shell.
 * Never throws for a run that is already gone.
 */
export async function signalDetachedRun(
  session: RemoteSshSession,
  handle: RemoteJobHandle,
  signal: 'TERM' | 'KILL'
): Promise<void> {
  if (handle.pid === undefined) return
  if (!Number.isSafeInteger(handle.pid) || handle.pid <= 1) {
    throw new Error('远程进程号无效，拒绝发送取消信号')
  }
  await verifyRemoteCancelTarget(session, handle.remoteRunDir, handle.runId, 'detached', handle.pid)
  const process = await session.exec(`ps -ww -o args= -p ${handle.pid}`)
  if (process.code !== 0 || !process.stdout.includes(`${handle.remoteRunDir}/launch.sh`)) {
    throw new Error(`远程进程 ${handle.pid} 不再属于运行 ${handle.runId}，拒绝发送取消信号`)
  }
  // The detached launch command records $! before `setsid` has necessarily made that PID a
  // process-group leader. Signal the group, the verified launcher, then the group again: this
  // covers either side of that transition while still stopping an established Nextflow tree.
  await session.exec(
    `kill -${signal} -${handle.pid} 2>/dev/null || true; kill -${signal} ${handle.pid} 2>/dev/null || true; kill -${signal} -${handle.pid} 2>/dev/null || true`
  )
}

/** The `detached_ssh` controller — see module doc comment above. */
export class SshExecRunner implements RemoteRunner {
  private readonly connection: RemoteConnectionConfig
  private readonly connectImpl: ConnectImpl
  private sessionPromise: Promise<RemoteSshSession> | undefined

  constructor(options: RemoteControllerOptions) {
    this.connection = options.connection
    this.connectImpl = options.connectImpl ?? connectRemoteSshSession
  }

  private getSession(): Promise<RemoteSshSession> {
    if (!this.sessionPromise) {
      this.sessionPromise = this.connectImpl(this.connection)
    }
    return this.sessionPromise
  }

  private handleFromObservation(
    run: WrapperRun,
    remoteRunDir: string,
    observation: RemoteLaunchObservation
  ): RemoteJobHandle | undefined {
    return observation.kind === 'started'
      ? { runId: run.runId, remoteRunDir, pid: observation.pid }
      : undefined
  }

  async submit(
    run: WrapperRun,
    _plan: WrapperRunPlan,
    launch: RemoteLaunchSpec
  ): Promise<RemoteJobHandle> {
    const session = await this.getSession()
    let claimAttempted = false
    try {
      const before = await observeRemoteLaunch(session, launch.remoteRunDir, run.runId, 'detached')
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
          'detached'
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
      const result = await session.exec(buildDetachedLaunchCommand(launch.remoteRunDir))
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || '启动命令未返回 PID')
      const rawPid = result.stdout.trim()
      const pid = Number(rawPid)
      if (!/^[1-9][0-9]*$/.test(rawPid) || !Number.isSafeInteger(pid)) {
        throw new Error('远程启动回执没有有效 PID')
      }
      return { runId: run.runId, remoteRunDir: launch.remoteRunDir, pid }
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
        fresh = await this.connectImpl(this.connection)
        const observed = await observeRemoteLaunch(
          fresh,
          launch.remoteRunDir,
          run.runId,
          'detached'
        )
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
    return readDetachedStatus(await this.getSession(), handle)
  }

  async tailLog(handle: RemoteJobHandle, stream: 'stdout' | 'stderr' = 'stdout'): Promise<string> {
    const session = await this.getSession()
    return readRemoteLog(session, handle.remoteRunDir, stream)
  }

  async cancel(handle: RemoteJobHandle): Promise<void> {
    if (handle.pid === undefined || (await this.status(handle)).outcome !== 'running') return
    await signalDetachedRun(await this.getSession(), handle, 'TERM')
  }

  async close(): Promise<void> {
    if (!this.sessionPromise) return
    const session = await this.sessionPromise
    await session.close()
  }
}
