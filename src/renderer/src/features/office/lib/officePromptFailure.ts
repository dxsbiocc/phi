import type { OfficePromptTargetFailure } from '../../../../../shared/officeProtocol'

export function isOfficePromptTargetFailure(value: unknown): value is OfficePromptTargetFailure {
  if (!value || typeof value !== 'object') return false
  const record = value as { ok?: unknown; error?: { code?: unknown; message?: unknown } }
  return (
    record.ok === false &&
    (record.error?.code === 'target_not_found' ||
      record.error?.code === 'target_session_mismatch' ||
      record.error?.code === 'selection_unavailable' ||
      record.error?.code === 'selection_too_large') &&
    typeof record.error.message === 'string'
  )
}

export function officePromptFailureRecovery(
  value: unknown,
  draft: string
): { draft: string; error: OfficePromptTargetFailure['error'] } | null {
  return isOfficePromptTargetFailure(value) ? { draft, error: value.error } : null
}
