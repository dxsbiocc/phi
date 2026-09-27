import type { RemoteContainerRuntime, RemoteController } from './wrapperRemoteTypes'

export interface RemoteDoctorOptions {
  scope?: 'workspace' | 'full'
  scheduler?: 'local' | 'slurm'
  controller?: RemoteController
  runtime?: RemoteContainerRuntime
  nextflowBin?: string
}

export type RemoteDoctorStatus = 'ok' | 'warning' | 'error'

export interface RemoteDoctorCheck {
  id: string
  status: RemoteDoctorStatus
  message: string
  suggestion?: string
}

export interface RemoteDoctorReport {
  hostProfileId: string
  checkedAt: string
  ok: boolean
  checks: RemoteDoctorCheck[]
}
