import { getPhiAgentDir } from '../runtime-paths'
import { findWrapperCatalogEntry } from './catalog'
import { joinRemote, type ConnectImpl, type RemoteJobHandle } from './executor-remote'
import {
  collectRemoteOutputs,
  pollUntilTerminal,
  readRemoteRunSnapshot,
  transition,
  writeRemoteRunSnapshot
} from './executor-remote-run'
import { SshExecRunner } from './executor-remote'
import { SbatchRunner } from './executor-slurm'
import { observeRemoteLaunch } from './remote-launch-claim'
import { cancelRemoteController } from './remote-cancel'
import { connectRemoteSshSession, type RemoteSshSession } from './remote-ssh-session'
import { resolveRemoteSubmitOptions } from './runs'
import { appendWrapperAuditEvent, listWrapperRuns } from './store'
import type { WrapperRun, WrapperRunState } from './types'

/**
 * Startup reconciliation for remote controller runs — see the technical
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
 * Both `slurm-controller` and detached SSH controllers use the same durable
 * run ID and remote snapshot; no submit path is invoked during reconciliation.
 */
const RECONCILABLE_STATES: WrapperRunState[] = [
  'provisioning',
  'queued',
  'running',
  'collecting',
  'cancelling',
  'lost'
]

export interface ReconcileRemoteWrapperRunsOptions {
  agentDir?: string
  /** Injectable so tests can fake the SSH session — mirrors every other remote entry point's `connectImpl`. */
  connectImpl?: ConnectImpl
  pollIntervalMs?: number
}

function markLost(run: WrapperRun, agentDir: string, reason: string): void {
  const lost = transition(run, agentDir, 'lost', {
    completedAt: new Date().toISOString(),
    launchDiagnostic: reason
  })
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
  const storedSnapshot = readRemoteRunSnapshot(run.runId, agentDir)
  const remoteRunDir = storedSnapshot?.remoteRunDir ?? run.remote?.runDir
  if (!remoteRunDir) {
    markLost(run, agentDir, '重启后未找到远程运行快照，无法确认远程作业状态')
    return
  }
  const snapshot = { ...storedSnapshot, remoteRunDir }
  const remote = resolveRemoteSubmitOptions(run, undefined, agentDir)
  if ('reason' in remote) {
    markLost(run, agentDir, `重启后无法重新连接远程主机：${remote.reason}`)
    return
  }
  const expectedDir = joinRemote(remote.remoteWorkspaceRoot, 'wrappers', 'runs', run.runId)
  if (
    snapshot.remoteRunDir !== expectedDir ||
    (run.remote && remote.connection.host !== run.remote.host)
  ) {
    markLost(run, agentDir, '远程快照目录与绑定的 run ID 不一致，拒绝改投其他位置')
    return
  }
  const slurmHead = run.executor === 'slurm-controller'
  const wasCancelling = run.state === 'cancelling'
  const runnerConnectImpl = remote.connectImpl ?? connectImpl
  const runner = slurmHead
    ? new SbatchRunner({ connection: remote.connection, connectImpl: runnerConnectImpl })
    : new SshExecRunner({ connection: remote.connection, connectImpl: runnerConnectImpl })
  let probe: RemoteSshSession | undefined
  let outputSession: RemoteSshSession | undefined
  try {
    probe = await runnerConnectImpl(remote.connection)
    const observation = await observeRemoteLaunch(
      probe,
      snapshot.remoteRunDir,
      run.runId,
      slurmHead ? 'sbatch' : 'detached'
    )
    if (observation.kind === 'rejected') {
      transition(run, agentDir, 'failed', {
        completedAt: new Date().toISOString(),
        launchUnknown: undefined,
        launchDiagnostic: observation.reason
      })
      return
    }
    if (observation.kind === 'unknown' && /run ID 不一致/.test(observation.reason)) {
      markLost(run, agentDir, observation.reason)
      return
    }
    const handle: RemoteJobHandle = {
      runId: run.runId,
      remoteRunDir: snapshot.remoteRunDir,
      pid: observation.kind === 'started' ? (observation.pid ?? snapshot.pid) : snapshot.pid,
      jobId: observation.kind === 'started' ? (observation.jobId ?? snapshot.jobId) : snapshot.jobId
    }
    if (handle.pid === undefined && handle.jobId === undefined && observation.kind !== 'started') {
      markLost(
        run,
        agentDir,
        observation.kind === 'unknown'
          ? observation.reason
          : '远端没有 PID、作业号或退出码，无法确认运行状态'
      )
      return
    }
    if (observation.kind === 'started') {
      writeRemoteRunSnapshot(run.runId, agentDir, {
        remoteRunDir: snapshot.remoteRunDir,
        ...(handle.pid !== undefined ? { pid: handle.pid } : {}),
        ...(handle.jobId !== undefined ? { jobId: handle.jobId } : {})
      })
    }
    const firstStatus = await runner.status(handle)
    let cancelDelivered = false
    if (wasCancelling && firstStatus.outcome === 'running') {
      // The previous process may have exited before its signal was sent.
      // Both controllers verify the run ID and receipt before signalling.
      const cancellation = await cancelRemoteController(probe, handle)
      if (cancellation.kind === 'unknown') {
        markLost(run, agentDir, '远程取消请求后无法确认进程或作业已停止')
        return
      }
      cancelDelivered = cancellation.kind === 'confirmed'
    }
    let currentRun = run
    if (firstStatus.outcome === 'running' && run.state === 'lost') {
      currentRun = transition(run, agentDir, 'running', {
        completedAt: undefined,
        launchUnknown: undefined,
        launchDiagnostic: undefined
      })
    }
    const status =
      firstStatus.outcome === 'running'
        ? await pollUntilTerminal(runner, handle, remote.pollIntervalMs ?? pollIntervalMs)
        : firstStatus

    if (status.outcome === 'completed') {
      const entry = findWrapperCatalogEntry(
        currentRun.wrapper.canonicalId,
        currentRun.wrapper.version,
        agentDir
      )
      if (!entry) {
        markLost(
          currentRun,
          agentDir,
          `找不到已安装的 wrapper，无法收集远程输出: ${currentRun.wrapper.canonicalId}@${currentRun.wrapper.version}`
        )
        return
      }
      outputSession = await runnerConnectImpl(remote.connection)
      const remoteOutDir =
        currentRun.remote?.outputRoot ?? joinRemote(snapshot.remoteRunDir, 'output')
      const collecting = transition(currentRun, agentDir, 'collecting')
      const outputs = await collectRemoteOutputs(outputSession, entry.manifest, remoteOutDir)
      transition(collecting, agentDir, 'completed', {
        completedAt: new Date().toISOString(),
        exitCode: status.exitCode,
        outputs,
        launchUnknown: undefined,
        launchDiagnostic: undefined
      })
      return
    }

    if (status.outcome === 'lost') {
      if (wasCancelling && cancelDelivered && !slurmHead) {
        transition(currentRun, agentDir, 'cancelled', {
          completedAt: new Date().toISOString(),
          launchUnknown: undefined,
          launchDiagnostic: undefined,
          cancelConfirmedAt: new Date().toISOString()
        })
        return
      }
      markLost(currentRun, agentDir, '远端进程或调度器未提供可确认的结束状态')
      return
    }
    const cancellationEvidence =
      cancelDelivered ||
      status.detail?.startsWith('CANCELLED') === true ||
      (wasCancelling && (status.exitCode === 143 || status.exitCode === 137))
    transition(
      currentRun,
      agentDir,
      wasCancelling && cancellationEvidence ? 'cancelled' : 'failed',
      {
        completedAt: new Date().toISOString(),
        exitCode: status.exitCode,
        launchUnknown: undefined,
        launchDiagnostic: undefined
      }
    )
  } finally {
    await runner.close().catch(() => undefined)
    await probe?.close().catch(() => undefined)
    await outputSession?.close().catch(() => undefined)
  }
}

/**
 * Resumes old-plan Slurm and detached runs left mid-flight by the previous app
 * session. This module retains its original file name but handles both
 * controller types. Called fire-and-forget at startup (see
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
    (run) =>
      run.origin !== 'composition' &&
      (run.executor === 'slurm-controller' ||
        run.executor === 'slurm' ||
        run.executor === 'remote-background') &&
      RECONCILABLE_STATES.includes(run.state) &&
      (run.state !== 'lost' ||
        readRemoteRunSnapshot(run.runId, agentDir) !== undefined ||
        run.remote?.runDir !== undefined)
  )
  await Promise.all(
    runs.map(async (run) => {
      try {
        await reconcileOneRun(run, agentDir, connectImpl, pollIntervalMs)
      } catch (error) {
        markLost(run, agentDir, error instanceof Error ? error.message : String(error))
      }
    })
  )
}
