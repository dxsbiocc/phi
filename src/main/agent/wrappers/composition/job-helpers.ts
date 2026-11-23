import { errorMessage } from '../../../../shared/errorCodes'
import type { WrapperManifestEngineProfile } from '../../../../shared/wrapperManifestTypes'
import type { RemoteHpcSettings } from '../../../../shared/wrapperRemoteTypes'
import type { WrapperTargetDoctorSnapshot } from '../target-policy'
import type { WrapperExecutor } from '../types'
import { WRAPPER_EXECUTION_PROFILES } from './executor'
import type { NextflowLaunch } from './nextflow-launch'

/** The head process as a Slurm job is `slurm-controller`; on the login node it is `slurm` or `remote-background`. */
export function remoteExecutorName(hpc: RemoteHpcSettings | undefined): WrapperExecutor {
  if (hpc?.controller === 'sbatch') return 'slurm-controller'
  return hpc?.scheduler === 'slurm' ? 'slurm' : 'remote-background'
}

export function compositionProfiles(
  remote: boolean,
  hpc?: RemoteHpcSettings
): WrapperManifestEngineProfile[] {
  return WRAPPER_EXECUTION_PROFILES.map((runtime) => ({
    id: runtime,
    executor: remote ? 'remote' : 'local',
    ...(remote
      ? {
          scheduler: hpc?.scheduler === 'slurm' ? ('slurm' as const) : ('none' as const),
          controller:
            hpc?.controller === 'sbatch' ? ('sbatch' as const) : ('detached_ssh' as const),
          containerRuntime: runtime
        }
      : {})
  }))
}

export function requireLaunch(launch: NextflowLaunch | undefined): NextflowLaunch {
  if (!launch) throw new Error('Nextflow was not resolved for a local run')
  return launch
}

class WrapperEnvironmentBlockedError extends Error {}

export function checkedRemoteDoctor(
  value: WrapperTargetDoctorSnapshot | { blocked: string }
): WrapperTargetDoctorSnapshot {
  if ('blocked' in value) throw new WrapperEnvironmentBlockedError(value.blocked)
  return value
}

export function remoteEnvironmentCheckError(error: unknown): string {
  return error instanceof WrapperEnvironmentBlockedError
    ? error.message
    : `远程环境检查失败：${errorMessage(error)}`
}
