import { randomUUID } from 'node:crypto'

import { getProjectByCwd } from '../projects'
import { getPhiAgentDir } from '../runtime-paths'
import { runLocalWrapperExecution } from './executor-local'
import { joinRemote } from './executor-remote'
import { runRemoteBackgroundWrapperExecution } from './executor-remote-background-submit'
import { readRemoteRunSnapshot } from './executor-remote-run'
import { SbatchRunner } from './executor-slurm'
import { runSlurmWrapperExecution } from './executor-slurm-submit'
import {
  resolveProjectRemoteSubmitOptions,
  type RemoteSubmitOptions
} from './remote-connection-resolver'
import {
  readWrapperPlan,
  writeWrapperPlan,
  writeWrapperRun,
  appendWrapperAuditEvent,
  appendWrapperRunEvent,
  readWrapperRun
} from './store'
import { isWrapperPlanExpired } from './plans'
import type { WrapperRun, WrapperRunPlan } from './types'

export type { RemoteSubmitOptions }

/**
 * Resolves what `slurm-controller` should connect to: an explicit
 * `options.remote` wins, otherwise falls back to the run's project's saved
 * default connection (`projects.ts`'s `remoteConnections`/
 * `defaultRemoteConnectionId`/`remoteWorkspaceRoot`). Returns a `reason`
 * string instead of throwing so the caller can land it as the run's
 * failure reason via `markRunFailed` — both "nothing configured anywhere"
 * and "a saved connection exists but is broken" (bad key path, missing
 * keychain entry) end up here, the latter via `resolveProjectRemoteSubmitOptions`
 * re-throwing a specific message that gets caught below.
 */
export function resolveRemoteSubmitOptions(
  run: WrapperRun,
  explicit: RemoteSubmitOptions | undefined,
  agentDir: string
): RemoteSubmitOptions | { reason: string } {
  if (explicit) return explicit
  try {
    const project = getProjectByCwd(run.cwd)
    const resolved = project ? resolveProjectRemoteSubmitOptions(project, agentDir) : undefined
    if (!resolved) {
      return {
        reason: '缺少远程连接信息：提交时未指定，项目中也未配置远程工作目录/默认连接'
      }
    }
    return resolved
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Marks a run failed after it was already durably created — used when execution never even starts. */
function markRunFailed(run: WrapperRun, agentDir: string, reason: string): void {
  const failedAt = new Date().toISOString()
  writeWrapperRun({ ...run, state: 'failed', updatedAt: failedAt, completedAt: failedAt }, agentDir)
  appendWrapperRunEvent(
    run.runId,
    { type: 'run_state_changed', timestamp: failedAt, state: 'failed' },
    agentDir
  )
  appendWrapperAuditEvent(
    {
      type: 'run_state_changed',
      timestamp: failedAt,
      actor: run.actor,
      runId: run.runId,
      planId: run.planId,
      wrapperId: run.wrapper.canonicalId,
      wrapperVersion: run.wrapper.version,
      detail: { state: 'failed', reason }
    },
    agentDir
  )
}

/**
 * Submits a validated plan, creating a durable `WrapperRun` record. This
 * milestone (P1.5) only creates the record in state `created` — it does not
 * yet invoke Nextflow. Milestone P1.7's local executor picks up from here
 * and drives the run through `running` → `completed`/`failed`. Keeping
 * "submit creates a durable run" and "the executor actually runs it" as
 * separate steps matches the plan/submit split described in the PRD: submit
 * must succeed (and the run must exist, restart-safe) independent of
 * whether anything has executed yet.
 */
export function submitWrapperRunPlan(
  planId: string,
  options: {
    heavyWorkloadAcknowledged?: boolean
    agentDir?: string
    /** Set false in tests that only want to check the durable run record, not spawn anything. */
    autoExecute?: boolean
    /**
     * Overrides the run's project's saved remote config for a
     * `slurm-controller` submit — see `RemoteSubmitOptions`. Usually left
     * unset; `resolveRemoteSubmitOptions` falls back to
     * `getProjectByCwd(run.cwd)`'s `remoteConnections`/
     * `defaultRemoteConnectionId`/`remoteWorkspaceRoot` automatically.
     */
    remote?: RemoteSubmitOptions
  } = {}
): WrapperRun {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const plan = readWrapperPlan(planId, agentDir)
  if (!plan) {
    throw new Error(`计划不存在: ${planId}`)
  }
  if (isWrapperPlanExpired(plan)) {
    throw new Error(`计划已过期: ${planId}`)
  }
  if (plan.state !== 'valid') {
    throw new Error(`计划当前状态为 "${plan.state}"，无法提交`)
  }

  const heavyWorkloadAcknowledged =
    options.heavyWorkloadAcknowledged ?? plan.heavyWorkloadAcknowledged
  if (plan.requiresHeavyWorkloadAcknowledgement && !heavyWorkloadAcknowledged) {
    throw new Error('该 wrapper 是重量级任务，Phase 1 没有远程执行环境，需要先确认才能在本地运行')
  }

  const now = new Date().toISOString()
  const run: WrapperRun = {
    runId: `wrun_${randomUUID()}`,
    planId: plan.planId,
    revision: plan.revision,
    state: 'created',
    actor: plan.actor,
    wrapper: plan.wrapper,
    trustTier: plan.trustTier,
    executor: plan.executor,
    profile: plan.profile,
    nextflowProfile: plan.nextflowProfile,
    cwd: plan.cwd,
    outDir: plan.outputDir,
    steps: plan.steps,
    createdAt: now,
    updatedAt: now
  }
  writeWrapperRun(run, agentDir)
  appendWrapperRunEvent(run.runId, { type: 'run_created', timestamp: now }, agentDir)

  const submittedPlan: WrapperRunPlan = {
    ...plan,
    state: 'submitted',
    heavyWorkloadAcknowledged: heavyWorkloadAcknowledged ?? plan.heavyWorkloadAcknowledged,
    submittedRunId: run.runId,
    updatedAt: now
  }
  writeWrapperPlan(submittedPlan, agentDir)

  appendWrapperAuditEvent(
    {
      type: 'plan_submitted',
      timestamp: now,
      actor: plan.actor,
      planId: plan.planId,
      runId: run.runId,
      wrapperId: plan.wrapper.canonicalId,
      wrapperVersion: plan.wrapper.version
    },
    agentDir
  )

  if (options.autoExecute !== false && run.executor === 'local') {
    // Submit returns immediately; local execution proceeds in the background
    // and drives its own state transitions (see executor-local.ts). Any
    // failure to even start executing still needs to land as a terminal
    // run state — an unstarted run must never sit at "created" forever.
    void runLocalWrapperExecution(run, submittedPlan, { agentDir }).catch((error: unknown) => {
      markRunFailed(run, agentDir, error instanceof Error ? error.message : String(error))
    })
  } else if (options.autoExecute !== false && run.executor === 'slurm-controller') {
    // Same "submit must still land a terminal state" rule as local's catch
    // above. The "nothing configured" branch below guards against a run
    // whose executor promises a remote host nobody configured, explicitly
    // or via the project (plans.ts's resolver only ever produces
    // slurm-controller when a project's remote config is actually set).
    const remote = resolveRemoteSubmitOptions(run, options.remote, agentDir)
    if ('reason' in remote) {
      markRunFailed(run, agentDir, remote.reason)
    } else {
      void runSlurmWrapperExecution(run, submittedPlan, {
        agentDir,
        remoteRunDir: joinRemote(remote.remoteWorkspaceRoot, 'wrappers', 'runs', run.runId),
        connection: remote.connection,
        connectImpl: remote.connectImpl,
        pollIntervalMs: remote.pollIntervalMs
      }).catch((error: unknown) => {
        markRunFailed(run, agentDir, error instanceof Error ? error.message : String(error))
      })
    }
  } else if (options.autoExecute !== false && run.executor === 'remote-background') {
    // Mirrors the slurm-controller branch above, dispatching to the
    // `detached_ssh` controller instead of `sbatch`. A plan/run can be
    // `remote-background` today only via a hand-built plan — plans.ts's
    // resolver doesn't produce this executor yet (only slurm-controller),
    // so the "nothing configured" branch below mostly guards against a run
    // whose executor promises a remote host nobody configured.
    const remote = resolveRemoteSubmitOptions(run, options.remote, agentDir)
    if ('reason' in remote) {
      markRunFailed(run, agentDir, remote.reason)
    } else {
      void runRemoteBackgroundWrapperExecution(run, submittedPlan, {
        agentDir,
        remoteRunDir: joinRemote(remote.remoteWorkspaceRoot, 'wrappers', 'runs', run.runId),
        connection: remote.connection,
        connectImpl: remote.connectImpl,
        pollIntervalMs: remote.pollIntervalMs
      }).catch((error: unknown) => {
        markRunFailed(run, agentDir, error instanceof Error ? error.message : String(error))
      })
    }
  }

  return run
}

/** Cancels a plan that has not been submitted yet. Cancelling a submitted run is a separate operation (P1.7). */
export function cancelWrapperRunPlan(planId: string, agentDir = getPhiAgentDir()): WrapperRunPlan {
  const plan = readWrapperPlan(planId, agentDir)
  if (!plan) {
    throw new Error(`计划不存在: ${planId}`)
  }
  if (plan.state === 'submitted') {
    throw new Error('计划已提交为运行，请取消对应的 run，而不是这个计划')
  }

  const now = new Date().toISOString()
  const cancelled: WrapperRunPlan = { ...plan, state: 'cancelled', updatedAt: now }
  writeWrapperPlan(cancelled, agentDir)
  appendWrapperAuditEvent(
    {
      type: 'plan_cancelled',
      timestamp: now,
      actor: plan.actor,
      planId: plan.planId,
      wrapperId: plan.wrapper.canonicalId,
      wrapperVersion: plan.wrapper.version
    },
    agentDir
  )
  return cancelled
}

/** States that haven't started executing anything anywhere yet — cancelling just marks the record, nothing to tear down remotely or locally. */
const PRE_DISPATCH_CANCELLABLE_STATES: WrapperRun['state'][] = [
  'created',
  'validating',
  'provisioning',
  'queued'
]

/** `slurm-controller` states where the remote job is actually running (or wrapping up) and worth issuing a real `scancel` for. */
const REMOTE_CANCELLABLE_RUN_STATES: WrapperRun['state'][] = ['running', 'collecting']

function requestCancelAuditEvent(run: WrapperRun, agentDir: string, timestamp: string): void {
  appendWrapperAuditEvent(
    {
      type: 'run_cancel_requested',
      timestamp,
      actor: run.actor,
      runId: run.runId,
      planId: run.planId,
      wrapperId: run.wrapper.canonicalId,
      wrapperVersion: run.wrapper.version
    },
    agentDir
  )
}

/**
 * Best-effort `scancel` — fire-and-forget, matching submit's own
 * "background dispatch, catch and report separately" pattern. The run's
 * actual terminal state (`cancelled`/`failed`/`lost`) is decided by whoever
 * next observes the scheduler's state: the in-flight `runSlurmWrapperExecution`
 * poll loop from this same app session if it's still running (see its
 * `wasCancelling` check), or `executor-slurm-reconcile.ts`'s startup pass
 * after a restart. A missing snapshot (the job never made it to `sbatch`
 * before cancel was requested) means there's nothing to cancel yet — the
 * still-running submit will finalize the run on its own once it completes.
 */
async function dispatchRemoteCancel(
  run: WrapperRun,
  agentDir: string,
  explicitRemote: RemoteSubmitOptions | undefined
): Promise<void> {
  const snapshot = readRemoteRunSnapshot(run.runId, agentDir)
  if (!snapshot?.jobId) return

  const remote = resolveRemoteSubmitOptions(run, explicitRemote, agentDir)
  if ('reason' in remote) return

  const runner = new SbatchRunner({
    connection: remote.connection,
    connectImpl: remote.connectImpl
  })
  try {
    await runner.cancel({
      runId: run.runId,
      remoteRunDir: snapshot.remoteRunDir,
      jobId: snapshot.jobId
    })
  } finally {
    await runner.close()
  }
}

function requestRemoteCancel(
  run: WrapperRun,
  agentDir: string,
  explicitRemote: RemoteSubmitOptions | undefined
): WrapperRun {
  const now = new Date().toISOString()
  const cancelling: WrapperRun = { ...run, state: 'cancelling', updatedAt: now }
  writeWrapperRun(cancelling, agentDir)
  appendWrapperRunEvent(
    run.runId,
    { type: 'run_state_changed', timestamp: now, state: 'cancelling' },
    agentDir
  )
  requestCancelAuditEvent(run, agentDir, now)

  void dispatchRemoteCancel(cancelling, agentDir, explicitRemote)

  return cancelling
}

/**
 * Cancels a run. Two cases:
 *
 *  - The run hasn't started executing anywhere yet (`created`/`validating`/
 *    `provisioning`/`queued`) — cancelling just marks the record `cancelled`
 *    immediately, matching the original Phase 1 behavior.
 *  - A `slurm-controller` run whose remote job is actually `running`/
 *    `collecting` — moves the run to `cancelling` and issues a best-effort
 *    `scancel` in the background (see `dispatchRemoteCancel`); the run
 *    reaches its real terminal state (`cancelled`/`failed`/`lost`) once the
 *    scheduler confirms it, either from this session's own poll loop or a
 *    future reconciliation pass.
 *
 * Cancelling an actually-running *local* Nextflow process, or an
 * actually-running `remote-background` run (dispatched via
 * `runRemoteBackgroundWrapperExecution` now, but with no `scancel`-style
 * counterpart wired up here yet — a separate follow-up), remains out of
 * scope and throws.
 */
export function cancelWrapperRun(
  runId: string,
  agentDir = getPhiAgentDir(),
  remote?: RemoteSubmitOptions
): WrapperRun {
  const run = readWrapperRun(runId, agentDir)
  if (!run) {
    throw new Error(`run 不存在: ${runId}`)
  }

  if (PRE_DISPATCH_CANCELLABLE_STATES.includes(run.state)) {
    const now = new Date().toISOString()
    const cancelled: WrapperRun = { ...run, state: 'cancelled', updatedAt: now }
    writeWrapperRun(cancelled, agentDir)
    appendWrapperRunEvent(
      runId,
      { type: 'run_state_changed', timestamp: now, state: 'cancelled' },
      agentDir
    )
    requestCancelAuditEvent(run, agentDir, now)
    return cancelled
  }

  if (run.executor === 'slurm-controller' && REMOTE_CANCELLABLE_RUN_STATES.includes(run.state)) {
    return requestRemoteCancel(run, agentDir, remote)
  }

  throw new Error(`run 当前状态为 "${run.state}"，取消正在执行的进程需要对应执行器支持`)
}
