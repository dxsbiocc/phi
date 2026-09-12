import type { Project } from '../types'

export type WorkspaceScopeProject = Pick<Project, 'name' | 'workingDirectory'>

export function workspaceScopeLabelForCwd(cwd: string, projects: WorkspaceScopeProject[]): string {
  return projects.find((project) => project.workingDirectory === cwd)?.name ?? '普通'
}
