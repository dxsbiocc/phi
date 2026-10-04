import type { TerminalWorkspaceRef } from '../../../../../shared/terminalTypes'
import type { Project } from '../../../lib/projectTypes'

export type TerminalWorkspaceTarget = TerminalWorkspaceRef | 'remote'

/**
 * Terminal ownership follows the active project, not the active chat. A missing
 * project means the ordinary local workspace; SSH projects must never fall
 * back to a local shell.
 */
export function terminalWorkspaceRefFromActiveProject(
  project: Pick<Project, 'id' | 'location'> | null | undefined
): TerminalWorkspaceTarget {
  if (!project) return { kind: 'ordinary' }
  if (project.location.kind === 'ssh') return 'remote'
  return { kind: 'project', projectId: project.id }
}
