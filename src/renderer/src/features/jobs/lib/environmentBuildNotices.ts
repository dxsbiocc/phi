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
      message: `正在构建环境 ${build.ref}，可在后台任务中查看进度`,
      severity: 'info'
    }
  }
  if (build.state === 'ready') {
    return { message: `环境 ${build.ref} 已就绪`, severity: 'success' }
  }
  if (build.state === 'failed') {
    return {
      message: `环境 ${build.ref} 构建失败：${build.error ?? ''}`,
      severity: 'error'
    }
  }
  return null
}
