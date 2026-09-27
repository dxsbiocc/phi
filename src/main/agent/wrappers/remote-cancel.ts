import type { RemoteJobHandle, RemoteRunStatus } from './executor-remote'
import { controllerForHandle } from './composition/remote-controller'
import type { RemoteSshSession } from './remote-ssh-session'

export type RemoteCancelResult =
  | { kind: 'confirmed'; status: RemoteRunStatus }
  | { kind: 'already-ended'; status: RemoteRunStatus }
  | { kind: 'unknown'; status: RemoteRunStatus }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Send a run-bound signal, then observe the remote before claiming cancellation. */
export async function cancelRemoteController(
  session: RemoteSshSession,
  handle: RemoteJobHandle,
  graceMs = 10_000
): Promise<RemoteCancelResult> {
  const controller = controllerForHandle(handle)
  const before = await controller.status(session, handle)
  if (before.outcome === 'completed' || before.outcome === 'failed') {
    return { kind: 'already-ended', status: before }
  }
  if (before.outcome === 'lost') return { kind: 'unknown', status: before }

  await controller.signal(session, handle, 'TERM')
  const observe = async (): Promise<RemoteCancelResult | undefined> => {
    const status = await controller.status(session, handle)
    if (status.outcome === 'completed') return { kind: 'already-ended', status }
    if (status.outcome === 'failed') {
      const signalled =
        handle.jobId !== undefined
          ? status.detail?.startsWith('CANCELLED') === true
          : status.exitCode === 143 || status.exitCode === 137
      return { kind: signalled ? 'confirmed' : 'already-ended', status }
    }
    // A detached process group that vanished after a delivered signal may
    // leave no exit file. Slurm losing its accounting record proves nothing.
    if (status.outcome === 'lost') {
      return { kind: handle.jobId === undefined ? 'confirmed' : 'unknown', status }
    }
    return undefined
  }
  const deadline = Date.now() + Math.max(0, graceMs)
  for (;;) {
    const result = await observe()
    if (result) return result
    if (Date.now() >= deadline) break
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())))
  }

  await controller.signal(session, handle, 'KILL')
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await observe()
    if (result) return result
    await sleep(100)
  }
  return { kind: 'unknown', status: await controller.status(session, handle) }
}
