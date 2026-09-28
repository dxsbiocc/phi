import type { SessionSummary } from '../../../types'

type SearchProject = { id: string; workingDirectory: string }
type SearchResult = { sessions: SessionSummary[] } | { failed: true }

const MAX_CONCURRENT_PROJECT_READS = 4

export async function loadProjectSessionsForSearch(
  projects: readonly SearchProject[],
  fetchSessions: (workingDirectory: string, projectId: string) => Promise<SessionSummary[]>,
  onResult: (projectId: string, result: SearchResult) => void,
  shouldContinue: () => boolean
): Promise<void> {
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (shouldContinue() && nextIndex < projects.length) {
      const project = projects[nextIndex++]
      let result: SearchResult
      try {
        result = { sessions: await fetchSessions(project.workingDirectory, project.id) }
      } catch {
        result = { failed: true }
      }
      if (shouldContinue()) onResult(project.id, result)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_PROJECT_READS, projects.length) }, worker)
  )
}
