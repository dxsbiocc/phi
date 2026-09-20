import type { RemoteHpcSettings } from '../../../../shared/wrapperRemoteTypes'
import {
  buildDetachedLaunchCommand,
  EXIT_CODE_FILE,
  joinRemote,
  readDetachedStatus,
  signalDetachedRun,
  type RemoteJobHandle,
  type RemoteRunStatus
} from '../executor-remote'
import { parseSbatchJobId, readSlurmJobStatus, signalSlurmJob } from '../executor-slurm'
import { shellQuote, type RemoteSshSession } from '../remote-ssh-session'
import { buildRemoteSbatchScript, type RemoteRunLayout } from './remote-config'

/**
 * Where the Nextflow head process runs, and how Phi starts, watches and stops it. Everything
 * after the launch (log streaming, outputs, reconnecting) is the same for both.
 *
 * - `login`: `setsid` on the login node, identified by its pid (`detached_ssh`).
 * - `sbatch`: a Slurm job of its own, identified by its job id, for sites that do not allow
 *   long-lived processes on login nodes (`slurm-controller`).
 */
export interface RunController {
  /** Starts the run. Throws with the reason when the host or scheduler refuses. */
  start(
    session: RemoteSshSession,
    input: { layout: RemoteRunLayout; runId: string; hpc: RemoteHpcSettings | undefined }
  ): Promise<{ pid?: number; jobId?: string; note?: string }>
  status(session: RemoteSshSession, handle: RemoteJobHandle): Promise<RemoteRunStatus>
  signal(session: RemoteSshSession, handle: RemoteJobHandle, signal: 'TERM' | 'KILL'): Promise<void>
}

const loginNodeController: RunController = {
  async start(session, { layout }) {
    const started = await session.exec(buildDetachedLaunchCommand(layout.runDir))
    if (started.code !== 0) throw new Error(started.stderr || started.stdout)
    const pid = Number.parseInt(started.stdout.trim(), 10)
    return { pid: Number.isFinite(pid) ? pid : undefined }
  },
  status: readDetachedStatus,
  signal: signalDetachedRun
}

/**
 * The exit code the launch script recorded is Nextflow's own result, so it outranks the
 * scheduler's view once the job is over (and survives the scheduler forgetting the job). Only
 * when the job died without recording one (time limit, out of memory, cancelled) does the
 * scheduler's state decide.
 */
async function sbatchStatus(
  session: RemoteSshSession,
  handle: RemoteJobHandle
): Promise<RemoteRunStatus> {
  const scheduler = await readSlurmJobStatus(session, handle.jobId)
  if (scheduler.outcome === 'running') return scheduler

  const file = joinRemote(handle.remoteRunDir, EXIT_CODE_FILE)
  if (await session.exists(file)) {
    const code = Number.parseInt((await session.readTextFile(file)).trim(), 10)
    if (Number.isFinite(code)) {
      return { outcome: code === 0 ? 'completed' : 'failed', exitCode: code }
    }
  }
  return scheduler
}

const sbatchController: RunController = {
  async start(session, { layout, runId, hpc }) {
    const script = joinRemote(layout.runDir, 'job.sbatch')
    await session.writeTextFile(script, buildRemoteSbatchScript({ layout, runId, hpc }))
    const result = await session.exec(`sbatch ${shellQuote(script)}`)
    if (result.code !== 0) {
      throw new Error(`sbatch refused the job: ${(result.stderr || result.stdout).trim()}`)
    }
    const jobId = parseSbatchJobId(result.stdout)
    if (jobId === undefined) {
      throw new Error(`could not read the job id from sbatch's reply: ${result.stdout.trim()}`)
    }
    return {
      jobId,
      note: `Submitted Slurm controller job ${jobId}; Nextflow starts when the scheduler has room for it.`
    }
  },
  status: sbatchStatus,
  signal: (session, handle, signal) => signalSlurmJob(session, handle.jobId, signal)
}

export function controllerFor(hpc: RemoteHpcSettings | undefined): RunController {
  return hpc?.controller === 'sbatch' ? sbatchController : loginNodeController
}

/** A run already launched is watched the way it was launched, whatever the setting says now. */
export function controllerForHandle(handle: RemoteJobHandle): RunController {
  return handle.jobId !== undefined ? sbatchController : loginNodeController
}
