import { randomUUID } from 'node:crypto'

import { getProject, getProjectByCwd } from '../projects'
import { getPhiAgentDir } from '../runtime-paths'
import { findWrapperCatalogEntry } from './catalog'
import { runLocalWrapperExecution, type RunLocalWrapperOptions } from './executor-local'
import { joinRemote, type RemoteJobHandle } from './executor-remote'
import { runRemoteBackgroundWrapperExecution } from './executor-remote-background-submit'
import { readRemoteRunSnapshot, transition } from './executor-remote-run'
import { cancelRemoteController } from './remote-cancel'
import { observeRemoteLaunch } from './remote-launch-claim'
import { connectRemoteSshSession } from './remote-ssh-session'
import { resolveRemoteOutputRoot } from './remote-result-paths'
import { runSlurmWrapperExecution } from './executor-slurm-submit'
import {
  resolveProjectRemoteSubmitOptions,
  resolveProjectRemoteTarget,
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
import { chooseWrapperTarget } from './target-policy'
import type { WrapperRun, WrapperRunPlan } from './types'

export type { RemoteSubmitOptions }

function sameProjectLocation(
  saved: NonNullable<WrapperRunPlan['targetSelection']>['projectLocation'],
  current: NonNullable<WrapperRunPlan['targetSelection']>['projectLocation']
): boolean {
  if (saved.kind !== current.kind) return false
  if (saved.kind === 'ssh' && current.kind === 'ssh') {
    return (
      saved.hostProfileId === current.hostProfileId &&
      saved.remoteRoot === current.remoteRoot &&
      saved.canonicalRoot === current.canonicalRoot
    )
  }
  return (
    saved.kind === 'local' &&
    current.kind === 'local' &&
    saved.path === current.path &&
    saved.realPath === current.realPath
  )
}

/** Re-check the saved project/host/path before a plan can create any run record. */
function validatedPlanRemote(
  plan: WrapperRunPlan,
  explicit: RemoteSubmitOptions | undefined,
  agentDir: string
): RemoteSubmitOptions | undefined {
  const saved = plan.targetSelection
  if (!saved) {
    if (plan.executor !== 'local') {
      throw new Error('旧远程计划缺少项目和服务器快照，请重新创建计划。')
    }
    return explicit
  }
  const project = getProject(saved.projectId)
  if (!project || !sameProjectLocation(saved.projectLocation, project.location)) {
    throw new Error('计划所属项目的位置或主机已变化，请重新创建计划。')
  }
  const entry = findWrapperCatalogEntry(plan.wrapper.canonicalId, plan.wrapper.version, agentDir)
  if (!entry) throw new Error('计划对应的 Wrapper 已不可用，请重新创建计划。')
  const policyBase = {
    projectLocation: project.location,
    explicitTarget: saved.target,
    selectedProfileId: plan.profile,
    resourceClass: plan.resourceClass,
    profiles: entry.manifest.engine.profiles,
    heavyLocalAcknowledged: true,
    deferDoctorToExecution: true
  } as const
  if (saved.target === 'local') {
    if (project.location.kind === 'ssh' || plan.executor !== 'local') {
      throw new Error('远程项目不能将 Wrapper 计划提交到本机。')
    }
    if (explicit) throw new Error('本地计划不能在提交时改为远程目标，请重新创建计划。')
    const decision = chooseWrapperTarget(policyBase)
    if (
      decision.kind !== 'selected' ||
      decision.target !== 'local' ||
      decision.profileId !== plan.profile
    ) {
      throw new Error('本地执行 Profile 与计划快照不一致，请重新创建计划。')
    }
    return undefined
  }
  if (
    plan.executor === 'local' ||
    !saved.hostProfileId ||
    !saved.hostAlias ||
    !saved.remoteRoot ||
    !saved.connectionId
  ) {
    throw new Error('远程计划缺少固定目标，请重新创建计划。')
  }
  const resolved = resolveProjectRemoteTarget(project, saved.connectionId, agentDir)
  if ('reason' in resolved) throw new Error(resolved.reason)
  const hostProfileId =
    project.location.kind === 'ssh'
      ? project.location.hostProfileId
      : project.remoteConnections?.find((item) => item.id === resolved.connectionId)?.hostProfileId
  const hpc = resolved.target.hpc ?? { scheduler: 'local' as const }
  if (
    hostProfileId !== saved.hostProfileId ||
    resolved.target.connection.host !== saved.hostAlias ||
    resolved.target.workspaceRoot !== saved.remoteRoot ||
    hpc.scheduler !== saved.scheduler ||
    (hpc.controller ?? 'login') !== saved.controller ||
    (hpc.runtime ?? 'singularity') !== saved.runtime
  ) {
    throw new Error('服务器、远程目录或运行方式与计划快照不一致，请重新创建计划。')
  }
  const decision = chooseWrapperTarget({
    ...policyBase,
    remote: {
      hostProfileId,
      hostAlias: resolved.target.connection.host,
      connectionId: resolved.connectionId,
      workspaceRoot: resolved.target.workspaceRoot,
      hpc
    }
  })
  if (
    decision.kind !== 'selected' ||
    decision.target !== 'remote' ||
    decision.executor !== plan.executor ||
    decision.profileId !== plan.profile ||
    decision.hostProfileId !== saved.hostProfileId ||
    decision.remoteRoot !== saved.remoteRoot
  ) {
    throw new Error('远程执行 Profile 与计划快照不一致，请重新创建计划。')
  }
  if (
    explicit &&
    (explicit.connection.host !== saved.hostAlias ||
      explicit.remoteWorkspaceRoot !== saved.remoteRoot)
  ) {
    throw new Error('提交目标与计划快照不一致，请重新创建计划。')
  }
  return {
    ...(explicit ?? {
      connection: resolved.target.connection,
      remoteWorkspaceRoot: resolved.target.workspaceRoot
    }),
    hpc
  }
}

/**
 * A snapshotted remote run reconnects to its saved project and connection ID.
 * Older records without that binding retain the explicit/project fallback.
 */
export function resolveRemoteSubmitOptions(
  run: WrapperRun,
  explicit: RemoteSubmitOptions | undefined,
  agentDir: string
): RemoteSubmitOptions | { reason: string } {
  if (run.remote?.projectId && run.remote.connectionId) {
    const project = getProject(run.remote.projectId)
    const resolved = resolveProjectRemoteTarget(project, run.remote.connectionId, agentDir)
    if ('reason' in resolved) return resolved
    const expectedRunDir = joinRemote(resolved.target.workspaceRoot, 'wrappers', 'runs', run.runId)
    if (
      resolved.target.connection.host !== run.remote.host ||
      expectedRunDir !== run.remote.runDir
    ) {
      return { reason: '运行记录绑定的服务器或目录已变化，拒绝改投其他目标。' }
    }
    if (
      explicit &&
      (explicit.connection.host !== run.remote.host ||
        explicit.remoteWorkspaceRoot !== resolved.target.workspaceRoot)
    ) {
      return { reason: '显式远程连接与运行记录的目标不一致。' }
    }
    return (
      explicit ?? {
        connection: resolved.target.connection,
        remoteWorkspaceRoot: resolved.target.workspaceRoot
      }
    )
  }
  if (explicit) return explicit
  try {
    const project = getProjectByCwd(run.cwd)
    const resolved = project ? resolveProjectRemoteSubmitOptions(project, agentDir) : undefined
    if (!resolved) {
      return {
        reason: '缺少远程计算目标：请先在该项目的 Wrapper 页面设置服务器和工作目录'
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

/** An exception after remote dispatch cannot prove the remote job failed. */
function markRemoteRunLost(run: WrapperRun, agentDir: string, reason: string): void {
  const current = readWrapperRun(run.runId, agentDir) ?? run
  if (['completed', 'failed', 'cancelled'].includes(current.state)) return
  transition(current, agentDir, 'lost', {
    completedAt: new Date().toISOString(),
    launchDiagnostic: reason
  })
}

/**
 * Revalidates the target snapshot, creates a durable run, then dispatches its
 * executor in the background. Invalid targets never create a run record.
 */
export function submitWrapperRunPlan(
  planId: string,
  options: {
    heavyWorkloadAcknowledged?: boolean
    externalOutputRoot?: string
    agentDir?: string
    /** Set false in tests that only want to check the durable run record, not spawn anything. */
    autoExecute?: boolean
    /**
     * Optional test/runtime transport override. A snapshotted plan only accepts
     * an override for the same host and remote root.
     */
    remote?: RemoteSubmitOptions
    /**
     * Local Nextflow resolution (build registry, runtime root). A plan submitted from the
     * wrapper panel has no chat session, so a missing environment is joined if a build is
     * already running and otherwise fails the run with the not-ready message.
     */
    nextflowLaunch?: RunLocalWrapperOptions['nextflowLaunch']
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
    throw new Error('该 wrapper 是重量级任务，需要先确认本地资源后才能在本机运行')
  }

  const selectedRemote = validatedPlanRemote(plan, options.remote, agentDir)

  const now = new Date().toISOString()
  const runId = `wrun_${randomUUID()}`
  const remoteRunDir =
    plan.targetSelection?.target === 'remote'
      ? joinRemote(plan.targetSelection.remoteRoot!, 'wrappers', 'runs', runId)
      : undefined
  const remoteOutput = remoteRunDir
    ? resolveRemoteOutputRoot(
        remoteRunDir,
        selectedRemote?.remoteWorkspaceRoot ?? plan.targetSelection!.remoteRoot!,
        plan.params.outdir,
        true
      )
    : undefined
  if (
    remoteOutput?.external &&
    (!options.externalOutputRoot ||
      resolveRemoteOutputRoot(
        remoteRunDir!,
        selectedRemote?.remoteWorkspaceRoot ?? plan.targetSelection!.remoteRoot!,
        options.externalOutputRoot,
        true
      ).path !== remoteOutput.path)
  ) {
    throw new Error('外部输出目录需要在计划卡明确显示并按该路径确认后才能提交')
  }
  const run: WrapperRun = {
    runId,
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
    outDir: remoteOutput?.path ?? plan.outputDir,
    steps: plan.steps,
    inputReferences: plan.inputs,
    ...(plan.targetSelection?.reason ? { targetReason: plan.targetSelection.reason } : {}),
    ...(plan.targetSelection?.target === 'remote' && remoteRunDir
      ? {
          remote: {
            host: plan.targetSelection.hostAlias!,
            runDir: remoteRunDir,
            connectionId: plan.targetSelection.connectionId,
            projectId: plan.targetSelection.projectId,
            hostProfileId: plan.targetSelection.hostProfileId,
            workspaceRoot: selectedRemote?.remoteWorkspaceRoot ?? plan.targetSelection.remoteRoot,
            outputRoot: remoteOutput?.path,
            externalOutputAuthorized: remoteOutput?.external || undefined
          }
        }
      : {}),
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
    void runLocalWrapperExecution(run, submittedPlan, {
      agentDir,
      ...(options.nextflowLaunch ? { nextflowLaunch: options.nextflowLaunch } : {})
    }).catch((error: unknown) => {
      markRunFailed(run, agentDir, error instanceof Error ? error.message : String(error))
    })
  } else if (options.autoExecute !== false && run.executor === 'slurm-controller') {
    // Remote startup errors settle the already-created run; target identity
    // was verified before creation and is checked again when resolving it.
    const remote = resolveRemoteSubmitOptions(run, selectedRemote, agentDir)
    if ('reason' in remote) {
      markRunFailed(run, agentDir, remote.reason)
    } else {
      void runSlurmWrapperExecution(run, submittedPlan, {
        agentDir,
        remoteRunDir: joinRemote(remote.remoteWorkspaceRoot, 'wrappers', 'runs', run.runId),
        connection: remote.connection,
        hpc: remote.hpc,
        connectImpl: remote.connectImpl,
        pollIntervalMs: remote.pollIntervalMs
      }).catch((error: unknown) => {
        markRemoteRunLost(run, agentDir, error instanceof Error ? error.message : String(error))
      })
    }
  } else if (
    options.autoExecute !== false &&
    (run.executor === 'remote-background' || run.executor === 'slurm')
  ) {
    // Login-node Nextflow uses the existing detached SSH controller. `slurm`
    // uses that controller while its Nextflow profile schedules process jobs.
    const remote = resolveRemoteSubmitOptions(run, selectedRemote, agentDir)
    if ('reason' in remote) {
      markRunFailed(run, agentDir, remote.reason)
    } else {
      void runRemoteBackgroundWrapperExecution(run, submittedPlan, {
        agentDir,
        remoteRunDir: joinRemote(remote.remoteWorkspaceRoot, 'wrappers', 'runs', run.runId),
        connection: remote.connection,
        hpc: remote.hpc,
        connectImpl: remote.connectImpl,
        pollIntervalMs: remote.pollIntervalMs
      }).catch((error: unknown) => {
        markRemoteRunLost(run, agentDir, error instanceof Error ? error.message : String(error))
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

/** Remote controllers retain a stable run ID and can be cancelled after a reconnect. */
const REMOTE_CANCELLABLE_RUN_STATES: WrapperRun['state'][] = ['running', 'collecting', 'lost']

function isRemoteController(run: WrapperRun): boolean {
  return (
    run.executor === 'slurm-controller' ||
    run.executor === 'slurm' ||
    run.executor === 'remote-background'
  )
}

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
 * The controller is chosen from the run's saved executor, never from current
 * project settings. The verified receipt ensures a stale snapshot cannot
 * signal another run's process group or scheduler job.
 */
async function dispatchRemoteCancel(
  run: WrapperRun,
  agentDir: string,
  explicitRemote: RemoteSubmitOptions | undefined
): Promise<void> {
  let snapshot = readRemoteRunSnapshot(run.runId, agentDir)
  // The submit path records `running` just before it writes the first snapshot.
  for (let attempt = 0; !snapshot && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    snapshot = readRemoteRunSnapshot(run.runId, agentDir)
  }
  if (!snapshot) throw new Error('远程运行尚无可核对的启动快照')

  const remote = resolveRemoteSubmitOptions(run, explicitRemote, agentDir)
  if ('reason' in remote) throw new Error(remote.reason)
  const expectedDir = joinRemote(remote.remoteWorkspaceRoot, 'wrappers', 'runs', run.runId)
  if (
    snapshot.remoteRunDir !== expectedDir ||
    (run.remote && run.remote.host !== remote.connection.host)
  ) {
    throw new Error('远程取消目标与运行记录绑定的主机或目录不一致')
  }
  const connect = remote.connectImpl ?? connectRemoteSshSession
  const session = await connect(remote.connection)
  try {
    const slurmHead = run.executor === 'slurm-controller'
    const observed = await observeRemoteLaunch(
      session,
      snapshot.remoteRunDir,
      run.runId,
      slurmHead ? 'sbatch' : 'detached'
    )
    if (observed.kind !== 'started') {
      throw new Error('远程启动结果尚不明确，取消信号未发送')
    }
    if (slurmHead ? !observed.jobId : observed.pid === undefined) {
      throw new Error('远程回执没有可核对的作业号或进程号')
    }
    const handle: RemoteJobHandle = {
      runId: run.runId,
      remoteRunDir: snapshot.remoteRunDir,
      ...(slurmHead ? { jobId: observed.jobId } : { pid: observed.pid })
    }
    const result = await cancelRemoteController(session, handle)
    if (result.kind === 'unknown') {
      throw new Error('取消后远端状态仍未知，保留运行记录等待对账')
    }
    if (result.kind === 'already-ended') {
      const current = readWrapperRun(run.runId, agentDir)
      if (current?.state === 'cancelling') {
        transition(current, agentDir, 'lost', {
          completedAt: new Date().toISOString(),
          launchDiagnostic: '取消前远端任务已结束；等待输出和最终状态对账'
        })
      }
      return
    }
    if (result.kind === 'confirmed') {
      const current = readWrapperRun(run.runId, agentDir)
      if (current && !['completed', 'cancelled'].includes(current.state)) {
        const confirmedAt = new Date().toISOString()
        transition(current, agentDir, 'cancelled', {
          completedAt: confirmedAt,
          cancelConfirmedAt: confirmedAt,
          launchDiagnostic: undefined
        })
      }
    }
  } finally {
    await session.close()
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

  void dispatchRemoteCancel(cancelling, agentDir, explicitRemote).catch((error: unknown) => {
    const current = readWrapperRun(run.runId, agentDir)
    if (current?.state !== 'cancelling') return
    transition(current, agentDir, 'lost', {
      completedAt: new Date().toISOString(),
      launchDiagnostic: `取消结果未知：${error instanceof Error ? error.message : String(error)}`
    })
  })

  return cancelling
}

/**
 * Cancels a run. Two cases:
 *
 *  - The run hasn't started executing anywhere yet (`created`/`validating`/
 *    `provisioning`/`queued`) — cancelling just marks the record `cancelled`
 *    immediately, matching the original Phase 1 behavior.
 *  - A remote controller run moves to `cancelling` and signals the verified
 *    process group or Slurm job. Its final state comes from remote evidence.
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

  if (isRemoteController(run) && ['completed', 'failed', 'cancelled'].includes(run.state)) {
    return run
  }
  if (isRemoteController(run) && run.state === 'cancelling') return run

  if (isRemoteController(run) && REMOTE_CANCELLABLE_RUN_STATES.includes(run.state)) {
    return requestRemoteCancel(run, agentDir, remote)
  }

  throw new Error(`run 当前状态为 "${run.state}"，取消正在执行的进程需要对应执行器支持`)
}
