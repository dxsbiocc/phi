import { jobsCopy } from './jobsCopy'
import type { EnvironmentBuild } from '../../../../../shared/environmentBuildTypes'

export type EnvironmentBuildNotice = {
  message: string
  severity: 'info' | 'success' | 'error'
}

/** One snackbar per state transition. Repeated updates in the same state stay quiet. */
export function environmentBuildNotice(
  previous: EnvironmentBuild['state'] | undefined,
  build: EnvironmentBuild
): EnvironmentBuildNotice | null {
  if (previous === build.state) return null
  if (build.state === 'building') {
    return {
      message: jobsCopy.buildingEnvironmentValueViewProgressInBackgroundJobs(build.ref),
      severity: 'info'
    }
  }
  if (build.state === 'ready') {
    return { message: jobsCopy.environmentValueIsReady(build.ref), severity: 'success' }
  }
  if (build.state === 'failed') {
    return {
      message: jobsCopy.environmentValueBuildFailedValue(build.ref, build.error ?? ''),
      severity: 'error'
    }
  }
  return null
}
