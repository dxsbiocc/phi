import { getPhiAgentDir } from '../runtime-paths'
import { findWrapperCatalogEntry } from './catalog'
import { joinRemote, type ConnectImpl, type RemoteJobHandle } from './executor-remote'
import {
  collectRemoteOutputs,
  pollUntilTerminal,
  readRemoteRunSnapshot,
  transition
} from './executor-remote-run'
import { SbatchRunner } from './executor-slurm'
import { connectRemoteSshSession, type RemoteSshSession } from './remote-ssh-session'
import { resolveRemoteSubmitOptions } from './runs'
import { appendWrapperAuditEvent, listWrapperRuns } from './store'
import type { WrapperRun, WrapperRunState } from './types'

/**
 * Startup reconciliation for `slurm-controller` runs — see the technical
 * design doc's "Monitoring And Recovery": "If the app closes or the network
 * disconnects, the remote job keeps running. On reconnect, Phi reconciles
 * status from run metadata and remote state." A run that was still
 * mid-flight when the app last closed (its persisted state is one of
 * `RECONCILABLE_STATES`) has nobody polling it anymore — the in-memory poll
 * loop that `runSlurmWrapperExecution` started died with the old process —
 * so it would otherwise sit at `running` forever even after the remote job
 * finished. This module reconnects, resumes polling to a terminal state,
 * and finalizes the run exactly like `runSlurmWrapperExecution` would have.
 *
 * A run whose state can't be confirmed (no snapshot, broken/removed remote
 * config) is marked `lost`, never `failed` — the design doc is explicit
 * that an unconfirmed state must not be reported as a definite failure.
 *
 * `remote-background`/`SshExecRunner` runs aren't covered here yet — that
 * executor is now dispatched from `runs.ts` (see
 * `executor-remote-background-submit.ts`), so a `remote-background` run CAN
 * be left mid-flight by a restart, but resuming it is a separate follow-up,
 * not yet built.
 */
const RECONCILABLE_STATES: WrapperRunState[] = [
  'provisioning',
  'queued',
  'running',
  'collecting',
  'cancelling'
]

export interface ReconcileRemoteWrapperRunsOptions {
  agentDir?: string
  /** Injectable so tests can fake the SSH session — mirrors every other remote entry point's `connectImpl`. */
  connectImpl?: ConnectImpl
  pollIntervalMs?: number
}

function markLost(run: WrapperRun, agentDir: string, reason: string): void {
  const lost = transition(run, agentDir, 'lost', { completedAt: new Date().toISOString() })
  appendWrapperAuditEvent(
    {
      type: 'run_state_changed',
      timestamp: lost.updatedAt,
      actor: run.actor,
      runId: run.runId,
      planId: run.planId,
      wrapperId: run.wrapper.canonicalId,
      wrapperVersion: run.wrapper.version,
      detail: { state: 'lost', reason }
    },
    agentDir
  )
}

async function reconcileOneRun(
  run: WrapperRun,
  agentDir: string,
  connectImpl: ConnectImpl,
  pollIntervalMs: number
): Promise<void> {
  const snapshot = readRemoteRunSnapshot(run.runId, agentDir)
  if (!snapshot?.jobId) {
    markLost(run, agentDir, '重启后未找到远程运行快照，无法确认远程作业状态')
    return
  }

  const remote = resolveRemoteSubmitOptions(run, undefined, agentDir)
  if ('reason' in remote) {
    markLost(run, agentDir, `重启后无法重新连接远程主机：${remote.reason}`)
    return
  }

  const wasCancelling = run.state === 'cancelling'
  const runnerConnectImpl = remote.connectImpl ?? connectImpl
  const runner = new SbatchRunner({ connection: remote.connection, connectImpl: runnerConnectImpl })
  const handle: RemoteJobHandle = {
    runId: run.runId,
    remoteRunDir: snapshot.remoteRunDir,
    jobId: snapshot.jobId
  }

  let session: RemoteSshSession | undefined
  try {
    if (wasCancelling) {
      // The cancel request may never have reached the scheduler before the
      // app closed — reissuing is safe, `RemoteRunner.cancel` is documented
      // as best-effort and a no-op for a job that's already gone.
      await runner.cancel(handle)
    }

    const status = await pollUntilTerminal(runner, handle, remote.pollIntervalMs ?? pollIntervalMs)

    if (status.outcome === 'completed') {
      const entry = findWrapperCatalogEntry(run.wrapper.canonicalId, run.wrapper.version, agentDir)
      if (!entry) {
        markLost(
          run,
          agentDir,
          `找不到已安装的 wrapper，无法收集远程输出: ${run.wrapper.canonicalId}@${run.wrapper.version}`
        )
        return
      }
      session = await runnerConnectImpl(remote.connection)
      const remoteOutDir = joinRemote(snapshot.remoteRunDir, 'output')
      const collecting = transition(run, agentDir, 'collecting')
      const outputs = await collectRemoteOutputs(session, entry.manifest, remoteOutDir)
      transition(collecting, agentDir, 'completed', {
        completedAt: new Date().toISOString(),
        exitCode: status.exitCode,
        outputs
      })
      return
    }

    if (status.outcome === 'lost') {
      transition(run, agentDir, 'lost', { completedAt: new Date().toISOString() })
      return
    }

    transition(run, agentDir, wasCancelling ? 'cancelled' : 'failed', {
      completedAt: new Date().toISOString(),
      exitCode: status.exitCode
    })
  } finally {
    await runner.close()
    if (session) await session.close()
  }
}

/**
 * Resumes every `slurm-controller` run left mid-flight by the previous app
 * session. Meant to be called once, fire-and-forget, at startup (see
 * `index.ts`'s `app.whenReady()` handler) — a failure reconciling one run
 * must never block the others, so each run's own errors are caught and
 * turned into a `lost` state rather than rejecting the whole pass.
 */
export async function reconcileRemoteWrapperRuns(
  options: ReconcileRemoteWrapperRunsOptions = {}
): Promise<void> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const connectImpl = options.connectImpl ?? connectRemoteSshSession
  const pollIntervalMs = options.pollIntervalMs ?? 15_000

  const runs = listWrapperRuns(agentDir).filter(
    (run) => run.executor === 'slurm-controller' && RECONCILABLE_STATES.includes(run.state)
  )

  for (const run of runs) {
    try {
      await reconcileOneRun(run, agentDir, connectImpl, pollIntervalMs)
    } catch (error) {
      markLost(run, agentDir, error instanceof Error ? error.message : String(error))
    }
  }
}
