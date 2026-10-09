import type {
  RemoteDoctorCheck,
  RemoteDoctorStatus,
  RemoteHostCapability,
  RemoteHostCapabilityProfile
} from '../../../shared/remoteDoctorTypes'

export interface CapabilityDoctorCheckInput {
  id: string
  success: string
  missing: string
  missingStatus: RemoteDoctorStatus
  suggestion: string
}

export function doctorCheckFromCapability(
  capability: RemoteHostCapability,
  input: CapabilityDoctorCheckInput
): RemoteDoctorCheck {
  if (capability.state === 'unavailable') {
    return {
      id: input.id,
      status: input.missingStatus,
      message: input.missing,
      suggestion: input.suggestion
    }
  }
  if (capability.state === 'degraded') {
    return {
      id: input.id,
      status: 'warning',
      message: capability.reason ?? '能力检测未完成',
      suggestion: '重新检测服务器能力后，再判断工具是否已安装。'
    }
  }
  return { id: input.id, status: 'ok', message: input.success }
}

export function selectedRuntimeCapability(
  profile: RemoteHostCapabilityProfile,
  runtime: 'singularity' | 'conda' | 'docker'
): RemoteHostCapability | undefined {
  if (runtime === 'conda') return profile.toolchain.conda
  const runtimes = profile.toolchain.containerRuntimes
  if (runtimes) {
    if (runtime === 'docker') return runtimes.docker
    return runtimes.singularity.state !== 'unavailable' ? runtimes.singularity : runtimes.apptainer
  }
  const container = profile.toolchain.containerRuntime
  const detected = container.version?.split(/\s+/, 1)[0]?.toLowerCase()
  if (detected === runtime || (runtime === 'singularity' && detected === 'apptainer')) {
    return container
  }
  return undefined
}
