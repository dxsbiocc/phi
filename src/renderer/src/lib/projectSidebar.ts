import type { Project } from '../types'

export type ProjectExpansionOverrides = Record<string, boolean | undefined>

function isLocalProject(
  project: Pick<Project, 'workingDirectory'> & Partial<Pick<Project, 'location'>>
): boolean {
  return project.location?.kind !== 'ssh'
}

export function activeCwdBelongsToProject(
  projects: Pick<Project, 'workingDirectory'>[],
  activeCwd: string
): boolean {
  return projects.some(
    (project) => isLocalProject(project) && project.workingDirectory === activeCwd
  )
}

export function orderProjectsForSessionSelection<T extends Pick<Project, 'workingDirectory'>>(
  projects: T[],
  activeCwd: string
): T[] {
  const activeProject = projects.find(
    (project) => isLocalProject(project) && project.workingDirectory === activeCwd
  )
  return activeProject
    ? [activeProject, ...projects.filter((project) => project !== activeProject)]
    : projects
}

export function expandActiveProjectId(
  expandedProjectIds: Set<string>,
  mode: 'conversations' | 'projects',
  projects: Pick<Project, 'id' | 'workingDirectory'>[],
  activeCwd: string
): Set<string> {
  if (mode !== 'projects') return expandedProjectIds
  const activeProject = projects.find(
    (project) => isLocalProject(project) && project.workingDirectory === activeCwd
  )
  if (!activeProject || expandedProjectIds.has(activeProject.id)) return expandedProjectIds
  const next = new Set(expandedProjectIds)
  next.add(activeProject.id)
  return next
}

export function resolveProjectExpandedIds(
  expansionOverrides: ProjectExpansionOverrides,
  mode: 'conversations' | 'projects',
  projects: Pick<Project, 'id' | 'workingDirectory'>[],
  activeCwd: string,
  activeProjectId?: string | null
): Set<string> {
  const expandedProjectIds = new Set<string>()
  for (const [projectId, isExpanded] of Object.entries(expansionOverrides)) {
    if (isExpanded) expandedProjectIds.add(projectId)
  }

  if (mode !== 'projects') return expandedProjectIds

  const activeProject = activeProjectId
    ? projects.find((project) => project.id === activeProjectId)
    : projects.find((project) => isLocalProject(project) && project.workingDirectory === activeCwd)
  if (!activeProject || expansionOverrides[activeProject.id] === false) {
    return expandedProjectIds
  }

  expandedProjectIds.add(activeProject.id)
  return expandedProjectIds
}
