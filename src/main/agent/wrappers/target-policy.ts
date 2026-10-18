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
    return blocked(
      'remote_project_local_target',
      'Wrappers in remote projects cannot run on this device.'
    )
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
      return blocked(
        'local_profile_unavailable',
        'This Wrapper has no available local execution profile.'
      )
    }
    if (
      requiresHeavyWorkloadAcknowledgement(input.resourceClass) &&
      !input.heavyLocalAcknowledged
    ) {
      return blocked(
        'heavy_local_confirmation_required',
        'Heavy Wrappers will not fall back to local execution automatically. Confirm local resources and risks before selecting this device.'
      )
    }
    return {
      kind: 'selected',
      target: 'local',
      executor: 'local',
      profileId: profile.id,
      reason:
        input.explicitTarget === 'local'
          ? 'Local execution was explicitly selected.'
          : 'The local project uses an available local profile.'
    }
  }

  const remote = input.remote
  if (!remote || !remote.hostProfileId || !remote.hostAlias) {
    return blocked(
      'remote_connection_unavailable',
      'No SSH server connection is available for remote execution.'
    )
  }
  if (
    input.projectLocation.kind === 'ssh' &&
    remote.hostProfileId !== input.projectLocation.hostProfileId
  ) {
    return blocked(
      'remote_configuration_invalid',
      'The remote connection does not match the server bound to this project.'
    )
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
    return blocked(
      'remote_configuration_invalid',
      'The remote directory or scheduler is not configured correctly.'
    )
  }

  const runtime = hpc.runtime ?? DEFAULT_REMOTE_RUNTIME
  const profile = input.selectedProfileId
    ? input.profiles.find((candidate) => candidate.id === input.selectedProfileId)
    : input.profiles.find((candidate) => remoteProfileMatches(candidate, hpc, runtime))
  if (!profile || !remoteProfileMatches(profile, hpc, runtime)) {
    return blocked(
      'remote_profile_unavailable',
      'This Wrapper has no remote profile for the selected server scheduler and runtime.'
    )
  }

  const doctor = input.doctor
  if (!doctor && !input.deferDoctorToExecution) {
    return blocked('doctor_unavailable', 'Check the remote runtime environment first.')
  }
  if (
    doctor &&
    (doctor.report.hostProfileId !== remote.hostProfileId ||
      doctor.remotePath !== remoteRoot ||
      doctor.scheduler !== hpc.scheduler ||
      doctor.controller !== (hpc.controller ?? 'login') ||
      doctor.runtime !== runtime)
  ) {
    return blocked(
      'doctor_mismatch',
      'The server, directory or execution mode has changed since the environment check. Check again.'
    )
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
        ? `${check.message}${check.suggestion ? `; ${check.suggestion}` : ''}`
        : 'The remote runtime environment has not passed all checks.'
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
        ? 'The remote project uses its bound server and project directory.'
        : input.explicitTarget === 'remote'
          ? 'The configured remote server was explicitly selected.'
          : 'The local project uses the configured and verified remote server.'
  }
}
