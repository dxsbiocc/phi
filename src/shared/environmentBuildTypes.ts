export interface EnvironmentBuildEstimate {
  packages: number
  cachedPackages: number
  downloadBytes?: number
  remainingBytes?: number
}

export interface EnvironmentBuildProgress {
  packagesDone: number
  packages: number
  bytesDone?: number
  bytesTotal?: number
}

export type EnvironmentBuildState = 'building' | 'ready' | 'failed' | 'cancelled'

export interface EnvironmentBuild {
  envId: string
  ref: string
  state: EnvironmentBuildState
  phase: string
  message: string
  startedAt: string
  finishedAt?: string
  error?: string
  estimate: EnvironmentBuildEstimate
  progress: EnvironmentBuildProgress
}
