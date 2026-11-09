import { getPhiAgentDir } from '../runtime-paths'
import { listUnfinishedPlanRuns } from './persistence/plan-run-store'

/**
 * Kernel sessions load lazily on the first prompt. After a restart that hides a paused or
 * interrupted plan run, together with its recovery actions, until the user sends a message.
 * This loader lets plan-run listing load the open conversation's kernel session, but only
 * when its local runtime directory holds an unfinished plan run.
 */

interface PlanSessionRuntimeRef {
  kernelSessionId: string
  host: { kind: string }
}

export interface PlanSessionLoaderDeps {
  currentPhiSessionId(): string | null | undefined
  kernelRuntimeRef(phiSessionId: string): PlanSessionRuntimeRef | null | undefined
  /** Local plan runs live under the current data directory, never the recorded one. */
  currentAgentDir(): string
  unfinishedPlanRunCount(kernelSessionId: string, agentDir: string): number
  /** Creates the open conversation's runtime the same way its next prompt would. */
  loadCurrentSession(): Promise<void>
}

export function createPlanSessionLoader(
  deps: PlanSessionLoaderDeps
): (phiSessionId: string) => Promise<boolean> {
  const pending = new Map<string, Promise<boolean>>()
  const loadIfNeeded = async (phiSessionId: string): Promise<boolean> => {
    if (deps.currentPhiSessionId() !== phiSessionId) return false
    const ref = deps.kernelRuntimeRef(phiSessionId)
    // Remote kernels keep plan runs on the server; loading them here would open SSH.
    if (!ref || ref.host.kind !== 'local') return false
    if (deps.unfinishedPlanRunCount(ref.kernelSessionId, deps.currentAgentDir()) === 0) return false
    await deps.loadCurrentSession()
    return true
  }
  return (phiSessionId) => {
    const existing = pending.get(phiSessionId)
    if (existing) return existing
    const load = loadIfNeeded(phiSessionId).finally(() => pending.delete(phiSessionId))
    pending.set(phiSessionId, load)
    return load
  }
}

/** The loader over the on-disk plan-run store. */
export function createLocalPlanSessionLoader(
  deps: Omit<PlanSessionLoaderDeps, 'unfinishedPlanRunCount' | 'currentAgentDir'> & {
    currentAgentDir?: PlanSessionLoaderDeps['currentAgentDir']
  }
): (phiSessionId: string) => Promise<boolean> {
  return createPlanSessionLoader({
    ...deps,
    currentAgentDir: deps.currentAgentDir ?? getPhiAgentDir,
    unfinishedPlanRunCount: (id, agentDir) => listUnfinishedPlanRuns(id, agentDir).length
  })
}
