import type { RemoteDoctorReport } from '../../../shared/remoteDoctorTypes'
import { DEFAULT_REMOTE_RUNTIME, type RemoteHpcSettings } from '../../../shared/wrapperRemoteTypes'
import { remoteDoctor } from '../remote-doctor'
import { buildRemotePreflightScript } from './composition/remote-config'
import type { RemoteSubmitOptions } from './remote-connection-resolver'
import type { WrapperManifest } from './manifest-types'
import { shellQuote, type RemoteSshSession } from './remote-ssh-session'
import { chooseWrapperTarget } from './target-policy'
import type { WrapperRun, WrapperRunPlan } from './types'

export interface RemoteSubmitPreflightResult {
  hpc: RemoteHpcSettings
  warnings: string[]
  error?: string
}

/** Doctor stays read-only; this isolated probe runs saved setup before upload or submission. */
export async function executeRemoteLaunchPreflight(
  session: RemoteSshSession,
  hpc: RemoteHpcSettings,
  workspaceRoot: string
): Promise<{ warnings: string[]; error?: string }> {
  const script = buildRemotePreflightScript({
    hpc,
    profile: hpc.runtime ?? DEFAULT_REMOTE_RUNTIME,
    workspaceRoot
  })
  const result = await session.exec(`bash -c ${shellQuote(script)}`)
  const warnings = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('WARN:'))
  return result.code === 0
    ? { warnings }
    : { warnings, error: (result.stderr || result.stdout).trim() || '服务器预检失败' }
}

/** Checks the saved host and runtime immediately before a legacy remote runner can submit. */
export async function checkRemoteSubmitPreflight(input: {
  run: WrapperRun
  plan: WrapperRunPlan
  manifest: WrapperManifest
  remote: RemoteSubmitOptions
  agentDir: string
  doctorImpl?: typeof remoteDoctor
}): Promise<RemoteSubmitPreflightResult> {
  const { run, plan, manifest, remote, agentDir } = input
  const saved = plan.targetSelection
  const hpc: RemoteHpcSettings = {
    ...remote.hpc,
    scheduler: saved?.scheduler ?? (run.executor === 'remote-background' ? 'local' : 'slurm'),
    controller: saved?.controller ?? (run.executor === 'slurm-controller' ? 'sbatch' : 'login'),
    runtime: saved?.runtime ?? remote.hpc?.runtime ?? DEFAULT_REMOTE_RUNTIME
  }
  if (!saved || saved.target !== 'remote' || !saved.hostProfileId) {
    // Direct executor tests may construct runs without a project snapshot. The public submit
    // entry rejects such plans; no app-created remote run reaches this branch.
    return { hpc, warnings: [] }
  }
  if (
    saved.hostAlias !== remote.connection.host ||
    saved.remoteRoot !== remote.remoteWorkspaceRoot ||
    (remote.hpc &&
      (remote.hpc.scheduler !== saved.scheduler ||
        (remote.hpc.controller ?? 'login') !== saved.controller))
  ) {
    return { hpc, warnings: [], error: '运行目标或调度方式与计划快照不一致，请重新创建计划。' }
  }
  const doctor = input.doctorImpl ?? remoteDoctor
  const report: RemoteDoctorReport = await doctor(
    saved.hostProfileId,
    saved.remoteRoot,
    {
      scope: 'full',
      scheduler: hpc.scheduler,
      controller: hpc.controller,
      runtime: hpc.runtime,
      ...(hpc.nextflowBin ? { nextflowBin: hpc.nextflowBin } : {})
    },
    {
      agentDir,
      connectImpl: remote.connectImpl,
      deferToolChecksToLaunch: Boolean(hpc.setupCommands?.length)
    }
  )
  const decision = chooseWrapperTarget({
    projectLocation: saved.projectLocation,
    explicitTarget: 'remote',
    selectedProfileId: plan.profile,
    resourceClass: plan.resourceClass,
    profiles: manifest.engine.profiles,
    remote: {
      hostProfileId: saved.hostProfileId,
      hostAlias: saved.hostAlias!,
      connectionId: saved.connectionId,
      workspaceRoot: saved.remoteRoot,
      hpc
    },
    doctor: {
      report,
      remotePath: saved.remoteRoot!,
      scheduler: hpc.scheduler,
      controller: hpc.controller ?? 'login',
      runtime: hpc.runtime ?? DEFAULT_REMOTE_RUNTIME,
      deferToolChecksToLaunch: Boolean(hpc.setupCommands?.length)
    }
  })
  const warnings = report.checks
    .filter(
      (check) =>
        check.status === 'warning' &&
        ['nextflow', 'java', 'runtime', 'login_controller'].includes(check.id)
    )
    .map((check) => `${check.message}${check.suggestion ? `；${check.suggestion}` : ''}`)
  if (
    decision.kind !== 'selected' ||
    decision.target !== 'remote' ||
    decision.executor !== run.executor ||
    decision.profileId !== plan.profile
  ) {
    return {
      hpc,
      warnings,
      error: decision.kind === 'blocked' ? decision.reason : '运行方式与计划快照不一致。'
    }
  }
  return { hpc, warnings }
}
