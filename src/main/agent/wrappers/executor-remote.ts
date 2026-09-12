import {
  connectRemoteSshSession,
  shellQuote,
  type RemoteConnectionConfig,
  type RemoteSshSession
} from './remote-ssh-session'
import type { WrapperRun, WrapperRunPlan } from './types'

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
}

export interface RemoteLaunchSpec {
  /** Absolute remote path the run executes in — created if missing. */
  remoteRunDir: string
  /**
   * Written as `launch.sh` and run via `setsid bash launch.sh`. Must record
   * its own exit code to the `exit_code` file in `remoteRunDir` on
   * completion (even on signal death) — wrap it with `wrapWithExitCodeTrap`.
   * Building the actual Nextflow invocation (the remote counterpart to
   * executor-nextflow.ts's `buildNextflowLaunch`) is a separate concern,
   * not this module's.
   */
  launchScript: string
  /** Written as `params.json` alongside the launch script. */
  paramsJson: string
  /** Written as `nextflow.config`, when the plan's profile needs one (e.g. `-profile slurm`). */
  nextflowConfig?: string
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
const EXIT_CODE_FILE = 'exit_code'
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
  if (!(await session.exists(path))) return ''
  // TODO: this re-reads the whole file every call. Fine for a skeleton; a
  // real UI polling loop will want an offset-based incremental tail
  // (`tail -c +<offset>`) once run logs get large.
  return session.readTextFile(path)
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
 * between "build the command" (`buildNextflowLaunch`) and "actually run
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

  async submit(
    run: WrapperRun,
    _plan: WrapperRunPlan,
    launch: RemoteLaunchSpec
  ): Promise<RemoteJobHandle> {
    const session = await this.getSession()
    await session.mkdirp(launch.remoteRunDir)
    await session.writeTextFile(joinRemote(launch.remoteRunDir, 'launch.sh'), launch.launchScript)
    await session.writeTextFile(joinRemote(launch.remoteRunDir, 'params.json'), launch.paramsJson)
    if (launch.nextflowConfig !== undefined) {
      await session.writeTextFile(
        joinRemote(launch.remoteRunDir, 'nextflow.config'),
        launch.nextflowConfig
      )
    }

    const result = await session.exec(buildDetachedLaunchCommand(launch.remoteRunDir))
    if (result.code !== 0) {
      throw new Error(`远程启动失败（run ${run.runId}）: ${result.stderr || result.stdout}`)
    }
    const pid = Number.parseInt(result.stdout.trim(), 10)
    return {
      runId: run.runId,
      remoteRunDir: launch.remoteRunDir,
      pid: Number.isFinite(pid) ? pid : undefined
    }
  }

  async status(handle: RemoteJobHandle): Promise<RemoteRunStatus> {
    if (handle.pid === undefined) return { outcome: 'lost' }
    const session = await this.getSession()
    const alive = await session.exec(`kill -0 ${handle.pid} 2>/dev/null && echo alive || echo dead`)
    if (alive.stdout.trim() === 'alive') {
      return { outcome: 'running' }
    }

    const exitCodePath = joinRemote(handle.remoteRunDir, EXIT_CODE_FILE)
    if (!(await session.exists(exitCodePath))) {
      // Process is gone but never recorded an exit code — e.g. the host
      // rebooted, or the SSH-visible process table doesn't match what we
      // launched. Matches the design doc: "if state cannot be confirmed,
      // mark the run lost, not failed".
      return { outcome: 'lost' }
    }
    const raw = (await session.readTextFile(exitCodePath)).trim()
    const exitCode = Number.parseInt(raw, 10)
    if (!Number.isFinite(exitCode)) return { outcome: 'lost' }
    return { outcome: exitCode === 0 ? 'completed' : 'failed', exitCode }
  }

  async tailLog(handle: RemoteJobHandle, stream: 'stdout' | 'stderr' = 'stdout'): Promise<string> {
    const session = await this.getSession()
    return readRemoteLog(session, handle.remoteRunDir, stream)
  }

  async cancel(handle: RemoteJobHandle): Promise<void> {
    if (handle.pid === undefined) return
    const session = await this.getSession()
    // setsid made the launched process its own session/group leader, so its
    // pid doubles as the process group id — `kill -<pid>` takes the whole
    // Nextflow + child job tree with it, not just the top shell wrapper.
    await session.exec(`kill -TERM -${handle.pid} 2>/dev/null || true`)
  }

  async close(): Promise<void> {
    if (!this.sessionPromise) return
    const session = await this.sessionPromise
    await session.close()
  }
}
