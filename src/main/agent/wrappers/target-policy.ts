import { posix } from 'node:path'

import type { ProjectLocation } from '../../../shared/projectLocation'
import type { RemoteDoctorReport } from '../../../shared/remoteDoctorTypes'
import {
  DEFAULT_REMOTE_RUNTIME,
  type RemoteContainerRuntime,
  type RemoteController,
  type RemoteHpcSettings
} from '../../../shared/wrapperRemoteTypes'
import type { WrapperManifestEngineProfile } from './manifest-types'
import { requiresHeavyWorkloadAcknowledgement } from './policy'
import type { WrapperExecutor, WrapperResourceClass } from './types'

export interface WrapperRemoteCandidate {
  hostProfileId: string
  hostAlias: string
  connectionId?: string
  /** Required for a local project that chooses a remote host. SSH projects use their canonical root. */
  workspaceRoot?: string
  hpc?: RemoteHpcSettings
}

/** The options used for this doctor report are kept beside it so another host/path cannot satisfy it. */
export interface WrapperTargetDoctorSnapshot {
  report: RemoteDoctorReport
  remotePath: string
  scheduler: RemoteHpcSettings['scheduler']
  controller: RemoteController
  runtime: RemoteContainerRuntime
  /** Startup preflight will validate tools after running saved setup once. */
  deferToolChecksToLaunch?: boolean
}

export interface WrapperTargetPolicyInput {
  projectLocation: ProjectLocation
  explicitTarget?: 'local' | 'remote'
  selectedProfileId?: string
  resourceClass: WrapperResourceClass
  profiles: readonly WrapperManifestEngineProfile[]
  remote?: WrapperRemoteCandidate
  doctor?: WrapperTargetDoctorSnapshot
  /** Legacy synchronous plans defer live host checks to execution; target identity is still selected now. */
  deferDoctorToExecution?: boolean
  /** Explicit acknowledgement from the existing heavy-local confirmation flow. */
  heavyLocalAcknowledged?: boolean
}

export type WrapperTargetDecision =
  | {
      kind: 'selected'
      target: 'local'
      executor: 'local'
      profileId: string
      reason: string
    }
  | {
      kind: 'selected'
      target: 'remote'
      executor: Exclude<WrapperExecutor, 'local'>
      profileId: string
      hostProfileId: string
      hostAlias: string
      remoteRoot: string
      connectionId?: string
      environmentCheckPending?: true
      reason: string
    }
  | {
      kind: 'blocked'
      code:
        | 'remote_project_local_target'
        | 'heavy_local_confirmation_required'
        | 'local_profile_unavailable'
        | 'remote_connection_unavailable'
        | 'remote_configuration_invalid'
        | 'remote_profile_unavailable'
        | 'doctor_unavailable'
        | 'doctor_mismatch'
        | 'doctor_not_ready'
      reason: string
    }

function blocked(
  code: Extract<WrapperTargetDecision, { kind: 'blocked' }>['code'],
  reason: string
): WrapperTargetDecision {
  return { kind: 'blocked', code, reason }
}

function remoteProfileMatches(
  profile: WrapperManifestEngineProfile,
  hpc: RemoteHpcSettings,
  runtime: RemoteContainerRuntime
): boolean {
  if (profile.executor !== 'remote') return false
  const scheduler = hpc.scheduler === 'slurm' ? 'slurm' : 'none'
  const controller = hpc.controller === 'sbatch' ? 'sbatch' : 'detached_ssh'
  return (
    (profile.scheduler ?? 'none') === scheduler &&
    (profile.controller ?? 'detached_ssh') === controller &&
    (profile.containerRuntime === undefined || profile.containerRuntime === runtime)
  )
}

function remoteExecutor(hpc: RemoteHpcSettings): Exclude<WrapperExecutor, 'local'> {
  if (hpc.controller === 'sbatch') return 'slurm-controller'
  return hpc.scheduler === 'slurm' ? 'slurm' : 'remote-background'
}

function requiredDoctorChecks(hpc: RemoteHpcSettings, deferTools = false): string[] {
  const checks = ['ssh', 'sftp', 'path', 'path_read', 'path_write', 'shell']
  if (deferTools) return checks
  if (hpc.controller !== 'sbatch') checks.push('nextflow', 'java')
  if (hpc.scheduler === 'slurm') {
    checks.push('slurm_submit', 'slurm_status', 'slurm_detail', 'slurm_cancel')
  } else {
    checks.push('runtime')
  }
  return checks
}

/** Pure policy. Callers provide saved host data and a full doctor snapshot; this function never opens SSH. */
export function chooseWrapperTarget(input: WrapperTargetPolicyInput): WrapperTargetDecision {
  if (input.projectLocation.kind === 'ssh' && input.explicitTarget === 'local') {
    return blocked('remote_project_local_target', '远程项目的 Wrapper 不能在本机执行。')
  }

  const wantsRemote =
    input.projectLocation.kind === 'ssh' ||
    input.explicitTarget === 'remote' ||
    (input.explicitTarget !== 'local' && input.remote !== undefined)

  if (!wantsRemote) {
    const profile = input.selectedProfileId
      ? input.profiles.find((candidate) => candidate.id === input.selectedProfileId)
      : (input.profiles.find(
          (candidate) => candidate.id === 'local' && candidate.executor === 'local'
        ) ?? input.profiles.find((candidate) => candidate.executor === 'local'))
    if (!profile || profile.executor !== 'local') {
      return blocked('local_profile_unavailable', '该 Wrapper 没有可用的本地执行 Profile。')
    }
    if (
      requiresHeavyWorkloadAcknowledgement(input.resourceClass) &&
      !input.heavyLocalAcknowledged
    ) {
      return blocked(
        'heavy_local_confirmation_required',
        '重负载 Wrapper 不会自动落到本机；确认本地资源和风险后才能明确选择本机。'
      )
    }
    return {
      kind: 'selected',
      target: 'local',
      executor: 'local',
      profileId: profile.id,
      reason:
        input.explicitTarget === 'local'
          ? '已明确选择本机执行。'
          : '本地项目使用可用的本地 Profile。'
    }
  }

  const remote = input.remote
  if (!remote || !remote.hostProfileId || !remote.hostAlias) {
    return blocked('remote_connection_unavailable', '没有可用的 SSH 服务器连接，无法选择远程执行。')
  }
  if (
    input.projectLocation.kind === 'ssh' &&
    remote.hostProfileId !== input.projectLocation.hostProfileId
  ) {
    return blocked('remote_configuration_invalid', '远程连接与项目绑定的服务器不一致。')
  }
  const remoteRoot =
    input.projectLocation.kind === 'ssh'
      ? input.projectLocation.canonicalRoot
      : remote.workspaceRoot
  const hpc = remote.hpc
  if (
    !remoteRoot ||
    !posix.isAbsolute(remoteRoot) ||
    remoteRoot.includes('\0') ||
    (input.projectLocation.kind === 'ssh' &&
      remote.workspaceRoot !== undefined &&
      remote.workspaceRoot !== remoteRoot) ||
    !hpc ||
    (hpc.controller === 'sbatch' && hpc.scheduler !== 'slurm')
  ) {
    return blocked('remote_configuration_invalid', '远程目录或调度方式尚未正确配置。')
  }

  const runtime = hpc.runtime ?? DEFAULT_REMOTE_RUNTIME
  const profile = input.selectedProfileId
    ? input.profiles.find((candidate) => candidate.id === input.selectedProfileId)
    : input.profiles.find((candidate) => remoteProfileMatches(candidate, hpc, runtime))
  if (!profile || !remoteProfileMatches(profile, hpc, runtime)) {
    return blocked(
      'remote_profile_unavailable',
      '该 Wrapper 没有适用于所选服务器调度方式和运行时的远程 Profile。'
    )
  }

  const doctor = input.doctor
  if (!doctor && !input.deferDoctorToExecution) {
    return blocked('doctor_unavailable', '请先检查远程运行环境。')
  }
  if (
    doctor &&
    (doctor.report.hostProfileId !== remote.hostProfileId ||
      doctor.remotePath !== remoteRoot ||
      doctor.scheduler !== hpc.scheduler ||
      doctor.controller !== (hpc.controller ?? 'login') ||
      doctor.runtime !== runtime)
  ) {
    return blocked('doctor_mismatch', '环境检查对应的服务器、目录或运行方式已变化，请重新检查。')
  }
  const failedCheck =
    doctor &&
    requiredDoctorChecks(hpc, doctor?.deferToolChecksToLaunch).find(
      (id) => doctor.report.checks.find((check) => check.id === id)?.status !== 'ok'
    )
  if (doctor && (!doctor.report.ok || failedCheck)) {
    const check =
      doctor.report.checks.find((candidate) => candidate.id === failedCheck) ??
      doctor.report.checks.find((candidate) => candidate.status === 'error')
    return blocked(
      'doctor_not_ready',
      check
        ? `${check.message}${check.suggestion ? `；${check.suggestion}` : ''}`
        : '远程运行环境尚未通过完整检查。'
    )
  }

  return {
    kind: 'selected',
    target: 'remote',
    executor: remoteExecutor(hpc),
    profileId: profile.id,
    hostProfileId: remote.hostProfileId,
    hostAlias: remote.hostAlias,
    remoteRoot,
    ...(remote.connectionId ? { connectionId: remote.connectionId } : {}),
    ...(!doctor ? { environmentCheckPending: true as const } : {}),
    reason:
      input.projectLocation.kind === 'ssh'
        ? '远程项目固定使用自身服务器和项目目录。'
        : input.explicitTarget === 'remote'
          ? '已明确选择项目配置的远程服务器。'
          : '本地项目使用已配置并通过检查的远程服务器。'
  }
}
