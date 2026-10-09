import { setTimeout as delay } from 'node:timers/promises'

import type { RemoteJobHandle, RemoteRunStatus } from './executor-remote'
import { verifyRemoteCancelTarget } from './remote-launch-claim'
import { cleanupSlurmRunJobs } from './remote-slurm-cleanup'
import type { RemoteSshSession } from './remote-ssh-session'

/**
 * Signals the verified controller. TERM reaches the batch script and all of its children so
 * Nextflow can clean up its own jobs. KILL means cancelling the allocation, not merely sending
 * SIGKILL to active steps (which Slurm documents as leaving the job itself allocated).
 */
export async function signalSlurmJob(
  session: RemoteSshSession,
  handle: RemoteJobHandle,
  signal: 'TERM' | 'KILL'
): Promise<void> {
  const { jobId } = handle
  if (jobId === undefined) return
  if (!/^[1-9][0-9]*$/.test(jobId)) {
    throw new Error('Slurm 作业号无效，拒绝发送取消信号')
  }
  await verifyRemoteCancelTarget(session, handle.remoteRunDir, handle.runId, 'sbatch', jobId)
  const detail = await session.exec(`scontrol show job ${jobId}`)
  const expectedName = `phi-${handle.runId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const actualName = detail.stdout.match(/(?:^|\s)JobName=(\S+)/)?.[1]
  if (detail.code !== 0 || actualName !== expectedName) {
    throw new Error(`Slurm 作业 ${jobId} 不再属于运行 ${handle.runId}，拒绝发送取消信号`)
  }
  if (signal === 'TERM') {
    const term = await session.exec(`scancel ${jobId} --full --signal=TERM 2>/dev/null`)
    if (term.code === 0) return
    // Older/vendor Slurm clients may not support --full. The WorkDir sweep still cleans tasks.
  }
  const cancelled = await session.exec(`scancel ${jobId} 2>/dev/null`)
  if (cancelled.code !== 0) throw new Error(`Slurm 作业 ${jobId} 未能取消，请稍后重试`)
}

/** Complete the standalone RemoteRunner.cancel contract when it is called directly. */
export async function cancelSlurmControllerJob(
  session: RemoteSshSession,
  handle: RemoteJobHandle,
  status: () => Promise<RemoteRunStatus>,
  graceMs = 10_000
): Promise<void> {
  if (handle.jobId === undefined) return
  let current = await status()
  if (current.outcome === 'running') {
    await signalSlurmJob(session, handle, 'TERM')
    const deadline = Date.now() + Math.max(0, graceMs)
    current = await status()
    while (current.outcome === 'running' && Date.now() < deadline) {
      await delay(Math.min(100, Math.max(1, deadline - Date.now())))
      current = await status()
    }
    if (current.outcome === 'running') await signalSlurmJob(session, handle, 'KILL')
  }
  const cleanup = await cleanupSlurmRunJobs(session, handle.remoteRunDir)
  if (cleanup.confirmed) return
  const suffix = cleanup.remainingJobIds.length ? `：${cleanup.remainingJobIds.join('、')}` : ''
  throw new Error(`无法确认本次运行的 Slurm 任务已全部取消${suffix}`)
}
