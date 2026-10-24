import type { SessionRun, SessionRunnerRegistry } from '../../session/session-runner-registry'

export function stopSubmittedFacadeRun(
  runners: SessionRunnerRegistry,
  phiSessionId: string,
  run: SessionRun | undefined
): void {
  if (run && runners.getActiveRun(phiSessionId) === run) runners.stopRun(phiSessionId)
}
