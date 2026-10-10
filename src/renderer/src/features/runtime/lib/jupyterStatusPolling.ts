import type { JupyterServerStatus } from '../../../types'

export type JupyterStatusDelay = (ms: number) => Promise<void>
export type JupyterStatusReader = (cwd: string) => Promise<JupyterServerStatus>
export type JupyterStatusListener = (status: JupyterServerStatus) => void

export const JUPYTER_STARTUP_POLL_ATTEMPTS = 40
export const REMOTE_JUPYTER_STARTUP_POLL_ATTEMPTS = 2_400
export const JUPYTER_STARTUP_POLL_INTERVAL_MS = 250

export function jupyterServerIsStarting(status: JupyterServerStatus): boolean {
  return [
    'starting',
    'preparing_environment',
    'allocating_ports',
    'starting_lease',
    'probing_through_tunnel',
    'cleaning'
  ].includes(status.state)
}

export async function pollJupyterServerStartupStatus(input: {
  cwd: string
  initialStatus: JupyterServerStatus
  readStatus: JupyterStatusReader
  onStatus: JupyterStatusListener
  delay: JupyterStatusDelay
  shouldContinue: () => boolean
  attempts?: number
  intervalMs?: number
}): Promise<JupyterServerStatus> {
  let status = input.initialStatus
  const attempts =
    input.attempts ??
    (input.initialStatus.runtimeKind === 'ssh'
      ? REMOTE_JUPYTER_STARTUP_POLL_ATTEMPTS
      : JUPYTER_STARTUP_POLL_ATTEMPTS)
  const intervalMs = input.intervalMs ?? JUPYTER_STARTUP_POLL_INTERVAL_MS

  for (let attempt = 0; attempt < attempts && jupyterServerIsStarting(status); attempt += 1) {
    await input.delay(intervalMs)
    if (!input.shouldContinue()) return status

    status = await input.readStatus(input.cwd)
    if (!input.shouldContinue()) return status
    input.onStatus(status)
  }

  return status
}
