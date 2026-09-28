import type { Project } from '../types'

export type WorkspaceScopeProject = Pick<Project, 'name' | 'workingDirectory'> &
  Partial<Pick<Project, 'location'>>

export function workspaceScopeLabelForCwd(cwd: string, projects: WorkspaceScopeProject[]): string {
  return (
    projects.find((project) => project.location?.kind !== 'ssh' && project.workingDirectory === cwd)
      ?.name ?? '普通'
  )
}
