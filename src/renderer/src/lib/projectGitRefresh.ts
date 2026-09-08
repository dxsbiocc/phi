import type { AgentEventSummary, Project } from '../types'

const RUN_TERMINAL_EVENTS = new Set(['run_completed', 'run_failed', 'run_interrupted'])

export function shouldRefreshProjectGitStatusForAgentEvent(
  event: Pick<AgentEventSummary, 'type' | 'cwd'>,
  projects: Pick<Project, 'workingDirectory'>[]
): boolean {
  if (!RUN_TERMINAL_EVENTS.has(event.type)) return false
  if (!event.cwd) return false
  return projects.some((project) => project.workingDirectory === event.cwd)
}
