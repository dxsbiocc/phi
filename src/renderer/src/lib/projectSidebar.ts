import type { Project } from '../types'

export type ProjectExpansionOverrides = Record<string, boolean | undefined>

export function expandActiveProjectId(
  expandedProjectIds: Set<string>,
  mode: 'conversations' | 'projects',
  projects: Pick<Project, 'id' | 'workingDirectory'>[],
  activeCwd: string
): Set<string> {
  if (mode !== 'projects') return expandedProjectIds
  const activeProject = projects.find((project) => project.workingDirectory === activeCwd)
  if (!activeProject || expandedProjectIds.has(activeProject.id)) return expandedProjectIds
  const next = new Set(expandedProjectIds)
  next.add(activeProject.id)
  return next
}

export function resolveProjectExpandedIds(
  expansionOverrides: ProjectExpansionOverrides,
  mode: 'conversations' | 'projects',
  projects: Pick<Project, 'id' | 'workingDirectory'>[],
  activeCwd: string
): Set<string> {
  const expandedProjectIds = new Set<string>()
  for (const [projectId, isExpanded] of Object.entries(expansionOverrides)) {
    if (isExpanded) expandedProjectIds.add(projectId)
  }

  if (mode !== 'projects') return expandedProjectIds

  const activeProject = projects.find((project) => project.workingDirectory === activeCwd)
  if (!activeProject || expansionOverrides[activeProject.id] === false) {
    return expandedProjectIds
  }

  expandedProjectIds.add(activeProject.id)
  return expandedProjectIds
}
