import type { RemoteJobHandle, RemoteRunStatus } from './executor-remote'
import { controllerForHandle } from './composition/remote-controller'
import type { RemoteSshSession } from './remote-ssh-session'
import { cleanupSlurmRunJobs, type SlurmRunCleanupOptions } from './remote-slurm-cleanup'

interface RemoteCancelDetail {
  message?: string
  remainingJobIds?: string[]
}

export type RemoteCancelResult =
  | ({ kind: 'confirmed'; status: RemoteRunStatus } & RemoteCancelDetail)
  | ({ kind: 'already-ended'; status: RemoteRunStatus } & RemoteCancelDetail)
  | ({ kind: 'unknown'; status: RemoteRunStatus } & RemoteCancelDetail)

export interface RemoteCancelOptions extends SlurmRunCleanupOptions {
  cleanupSlurmJobs?: boolean
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function cancellationObservation(
  handle: RemoteJobHandle,
  status: RemoteRunStatus
): RemoteCancelResult | undefined {
  if (status.outcome === 'completed') return { kind: 'already-ended', status }
  if (status.outcome === 'failed') {
    const signalled =
      status.detail?.startsWith('CANCELLED') === true ||
      status.exitCode === 143 ||
      status.exitCode === 137
    return { kind: signalled ? 'confirmed' : 'already-ended', status }
  }
  // A detached process group that vanished after a delivered signal may leave no exit file.
  // Slurm losing its accounting record proves nothing.
  if (status.outcome === 'lost') {
    return { kind: handle.jobId === undefined ? 'confirmed' : 'unknown', status }
  }
  return undefined
}

/** Send a run-bound signal, then observe the remote before claiming cancellation. */
export async function cancelRemoteController(
  session: RemoteSshSession,
  handle: RemoteJobHandle,
  graceMs = 10_000,
  options: RemoteCancelOptions = {}
): Promise<RemoteCancelResult> {
  const controller = controllerForHandle(handle)
  const before = await controller.status(session, handle)
  if (before.outcome === 'completed' || before.outcome === 'failed') {
    const schedulerCancelled =
      handle.jobId !== undefined && before.detail?.startsWith('CANCELLED') === true
    const kind = schedulerCancelled ? 'confirmed' : 'already-ended'
    return withSlurmCleanup(session, handle, { kind, status: before }, options)
  }
  if (before.outcome === 'lost') return { kind: 'unknown', status: before }

  await controller.signal(session, handle, 'TERM')
  const observe = async (): Promise<RemoteCancelResult | undefined> => {
    return cancellationObservation(handle, await controller.status(session, handle))
  }
  const deadline = Date.now() + Math.max(0, graceMs)
  for (;;) {
    const result = await observe()
    if (result) return await withSlurmCleanup(session, handle, result, options)
    if (Date.now() >= deadline) break
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())))
  }

  await controller.signal(session, handle, 'KILL')
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await observe()
    if (result) return await withSlurmCleanup(session, handle, result, options)
    await sleep(100)
  }
  return await withSlurmCleanup(
    session,
    handle,
    { kind: 'unknown', status: await controller.status(session, handle) },
    options
  )
}

async function withSlurmCleanup(
  session: RemoteSshSession,
  handle: RemoteJobHandle,
  result: RemoteCancelResult,
  options: RemoteCancelOptions
): Promise<RemoteCancelResult> {
  if (!options.cleanupSlurmJobs) return result
  const cleanup = await cleanupSlurmRunJobs(session, handle.remoteRunDir, options)
  if (cleanup.confirmed) return result
  const remaining = cleanup.remainingJobIds
  const message =
    remaining.length > 0
      ? `取消未完成：仍有属于本次运行的 Slurm 作业：${remaining.join('、')}。请在集群上核对后重试取消。`
      : '取消后无法确认本次运行的 Slurm 任务是否已清理，请稍后重试并核对队列。'
  return { kind: 'unknown', status: result.status, message, remainingJobIds: remaining }
}
