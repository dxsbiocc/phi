import { MAX_PRESENTED_FILES, type PresentedFile } from '../../../../../shared/presentedFileTypes'
import type { PresentedFilesItem, WorkspaceChangeSummaryItem } from '../../../types'

/** Merge delivery receipts for one turn without changing the stored timeline. */
export function mergeTurnFileItems(
  items: (PresentedFilesItem | WorkspaceChangeSummaryItem)[]
): (PresentedFilesItem | WorkspaceChangeSummaryItem)[] {
  const deliveries = new Map<string | undefined, PresentedFilesItem>()
  const merged: (PresentedFilesItem | WorkspaceChangeSummaryItem)[] = []
  for (const item of items) {
    if (item.role === 'workspace_changes') {
      merged.push(item)
      continue
    }
    const previous = deliveries.get(item.runId)
    if (!previous) {
      const delivery = { ...item, files: [...item.files] }
      deliveries.set(item.runId, delivery)
      merged.push(delivery)
      continue
    }
    // A later receipt can carry a newer Office revision or description.
    previous.files = [
      ...new Map([...previous.files, ...item.files].map((file) => [file.path, file])).values()
    ]
  }
  return merged
}

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
    const artifact = presentedArtifact(file.artifact)
    const office = presentedOfficeFile(file.office)
    if (Object.hasOwn(file, 'office') && !office) return []
    return [
      {
        path: file.path,
        displayPath: file.displayPath,
        bytes: file.bytes,
        ...(typeof file.description === 'string' && file.description
          ? { description: file.description }
          : {}),
        ...(artifact ? { artifact } : {}),
        ...(office ? { office } : {})
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

function presentedOfficeFile(value: unknown): PresentedFile['office'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const checks = record.checks
  if (
    !validOfficeFields(record) ||
    !checks ||
    typeof checks !== 'object' ||
    Array.isArray(checks)
  ) {
    return undefined
  }
  const checked = checks as Record<string, unknown>
  if (!validChecks(checked)) return undefined
  return {
    artifactId: record.artifactId as string,
    outputId: record.outputId as string,
    kind: record.kind as 'xlsx' | 'docx' | 'pptx',
    revision: record.revision as number,
    sha256: record.sha256 as string,
    warnings: [...(record.warnings as string[])],
    checks: {
      schema: 'passed',
      content: 'passed',
      samples: checked.samples as number,
      ...(typeof checked.pageCount === 'number' ? { pageCount: checked.pageCount } : {})
    }
  }
}

function validOfficeFields(value: Record<string, unknown>): boolean {
  return Boolean(
    validId(value.artifactId) &&
    validId(value.outputId) &&
    ['xlsx', 'docx', 'pptx'].includes(String(value.kind)) &&
    validInteger(value.revision) &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.sha256) &&
    Array.isArray(value.warnings) &&
    value.warnings.length <= 8 &&
    value.warnings.every((warning) => typeof warning === 'string' && warning.length <= 200)
  )
}

function validChecks(value: Record<string, unknown>): boolean {
  return Boolean(
    value.schema === 'passed' &&
    value.content === 'passed' &&
    validInteger(value.samples) &&
    (value.pageCount === undefined || validInteger(value.pageCount))
  )
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)
}

function validInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Unknown or invalid artifact metadata is dropped; it does not reject the file. */
function presentedArtifact(value: unknown): PresentedFile['artifact'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.kind !== 'string' || record.kind.length === 0) return undefined
  if (typeof record.title !== 'string' || record.title.length === 0) return undefined
  return {
    kind: record.kind,
    title: record.title,
    ...(typeof record.envId === 'string' && record.envId.length > 0 ? { envId: record.envId } : {})
  }
}
