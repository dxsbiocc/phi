import type { RemoteContainerRuntime, RemoteController } from './wrapperRemoteTypes'

export interface RemoteDoctorOptions {
  scope?: 'connection' | 'workspace' | 'full'
  scheduler?: 'local' | 'slurm'
  controller?: RemoteController
  runtime?: RemoteContainerRuntime
  nextflowBin?: string
  refreshCapabilities?: boolean
}

export type RemoteDoctorStatus = 'ok' | 'warning' | 'error'

export interface RemoteDoctorCheck {
  id: string
  status: RemoteDoctorStatus
  message: string
  suggestion?: string
}

export type RemoteHostCapabilityState = 'available' | 'degraded' | 'unavailable'

export interface RemoteHostCapability {
  state: RemoteHostCapabilityState
  reason?: string
  version?: string
}

export interface RemoteHostCapabilityProfile {
  platform: {
    os: string
    arch: string
    libc?: {
      name: 'glibc' | 'musl' | 'unknown'
      version?: string
    }
  }
  helperVersion?: string
  helperCompatibility?: RemoteHostCapability
  probedAt: string
  fs: RemoteHostCapability
  exec: RemoteHostCapability
  background: RemoteHostCapability
  pty: RemoteHostCapability
  watch: RemoteHostCapability
  forwardPort: RemoteHostCapability
  probe?: RemoteHostCapability
  prerequisites?: {
    perl: RemoteHostCapability
    python3: RemoteHostCapability
    tar: RemoteHostCapability
    sha256sum: RemoteHostCapability
  }
  storage?: {
    homeWritable: RemoteHostCapability
    homeExecutable: RemoteHostCapability
    availableSpaceKiB: number | null
    availableSpace?: RemoteHostCapability
    sharedFileSystem: RemoteHostCapability
  }
  toolchain: {
    git: RemoteHostCapability
    nextflow: RemoteHostCapability
    java: RemoteHostCapability
    conda: RemoteHostCapability
    sbatch: RemoteHostCapability
    containerRuntime: RemoteHostCapability
    containerRuntimes?: {
      docker: RemoteHostCapability
      singularity: RemoteHostCapability
      apptainer: RemoteHostCapability
      podman: RemoteHostCapability
    }
    module: RemoteHostCapability
  }
}

export interface RemoteDoctorReport {
  hostProfileId: string
  checkedAt: string
  ok: boolean
  checks: RemoteDoctorCheck[]
  capabilityProfile?: RemoteHostCapabilityProfile
}

export interface RemoteNextflowInstallResult {
  path: string
  alreadyInstalled: boolean
}
