import type { AgentEventSummary, Project } from '../types'

const RUN_TERMINAL_EVENTS = new Set(['run_completed', 'run_failed', 'run_interrupted'])

export function shouldRefreshProjectGitStatusForAgentEvent(
  event: Pick<AgentEventSummary, 'type' | 'cwd'>,
  projects: (Pick<Project, 'workingDirectory'> & Partial<Pick<Project, 'location'>>)[]
): boolean {
  if (!RUN_TERMINAL_EVENTS.has(event.type)) return false
  if (!event.cwd) return false
  return projects.some(
    (project) => project.location?.kind !== 'ssh' && project.workingDirectory === event.cwd
  )
}
