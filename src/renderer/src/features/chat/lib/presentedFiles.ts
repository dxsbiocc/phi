import { MAX_PRESENTED_FILES, type PresentedFile } from '../../../../../shared/presentedFileTypes'
import type { PresentedFilesItem } from '../../../types'

export function presentedFilesItemFromPhiTimelineEvent(event: {
  type?: string
  eventId?: string
  runId?: string
  createdAt?: string
  files?: unknown
}): PresentedFilesItem | null {
  if (event.type !== 'files_presented' || !Array.isArray(event.files)) return null
  if (event.files.length < 1 || event.files.length > MAX_PRESENTED_FILES) return null
  const files = event.files.flatMap((value): PresentedFile[] => {
    if (!value || typeof value !== 'object') return []
    const file = value as Record<string, unknown>
    if (
      typeof file.path !== 'string' ||
      !file.path ||
      typeof file.displayPath !== 'string' ||
      !file.displayPath ||
      typeof file.bytes !== 'number' ||
      !Number.isFinite(file.bytes) ||
      file.bytes < 0
    ) {
      return []
    }
    return [
      {
        path: file.path,
        displayPath: file.displayPath,
        bytes: file.bytes,
        ...(typeof file.description === 'string' && file.description
          ? { description: file.description }
          : {})
      }
    ]
  })
  if (files.length !== event.files.length) return null
  return {
    id: event.eventId ?? `presented-files-${event.runId ?? 'event'}`,
    role: 'presented_files',
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.createdAt ? { createdAt: event.createdAt } : {}),
    files
  }
}
