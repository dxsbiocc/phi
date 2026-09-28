import {
  MAX_WORKSPACE_CHANGE_FILES,
  MAX_WORKSPACE_DIFF_BYTES,
  type WorkspaceFileChange
} from '../../../../../shared/workspaceChangeTypes'
import type { WorkspaceChangeSummaryItem } from '../../../types'

export function workspaceChangesItemFromPhiTimelineEvent(event: {
  type?: string
  eventId?: string
  runId?: string
  createdAt?: string
  files?: unknown
  totalChanged?: unknown
  truncated?: unknown
}): WorkspaceChangeSummaryItem | null {
  if (event.type !== 'workspace_changes' || !Array.isArray(event.files)) return null
  const files = event.files
    .slice(0, MAX_WORKSPACE_CHANGE_FILES)
    .flatMap((value): WorkspaceFileChange[] => {
      if (!value || typeof value !== 'object') return []
      const file = value as Record<string, unknown>
      if (
        typeof file.path !== 'string' ||
        typeof file.displayPath !== 'string' ||
        (file.status !== 'added' && file.status !== 'modified' && file.status !== 'deleted')
      ) {
        return []
      }
      const count = (value: unknown): number | null =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
      const rawDiff =
        file.diff && typeof file.diff === 'object' ? (file.diff as Record<string, unknown>) : null
      const diff =
        rawDiff &&
        typeof rawDiff.sessionId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(rawDiff.sessionId) &&
        typeof rawDiff.id === 'string' &&
        /^[0-9a-f]{64}$/.test(rawDiff.id) &&
        typeof rawDiff.bytes === 'number' &&
        rawDiff.bytes > 0 &&
        rawDiff.bytes <= MAX_WORKSPACE_DIFF_BYTES
          ? { sessionId: rawDiff.sessionId, id: rawDiff.id, bytes: rawDiff.bytes }
          : null
      return [
        {
          path: file.path,
          displayPath: file.displayPath,
          status: file.status,
          added: count(file.added),
          deleted: count(file.deleted),
          ...(diff ? { diff } : {})
        }
      ]
    })
  return {
    id: event.eventId ?? `workspace-changes-${event.runId ?? 'event'}`,
    role: 'workspace_changes',
    ...(typeof event.runId === 'string' ? { runId: event.runId } : {}),
    ...(typeof event.createdAt === 'string' ? { createdAt: event.createdAt } : {}),
    files,
    totalChanged:
      typeof event.totalChanged === 'number' && Number.isFinite(event.totalChanged)
        ? Math.max(files.length, Math.trunc(event.totalChanged))
        : files.length,
    truncated: event.truncated === true || event.files.length > MAX_WORKSPACE_CHANGE_FILES
  }
}
