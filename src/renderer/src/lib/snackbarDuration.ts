import type { SnackbarNotice, SnackbarSeverity } from '../components/AppSnackbarCard'

const snackbarDurationMs: Record<SnackbarSeverity, number> = {
  success: 4000,
  info: 5000,
  warning: 8000,
  error: 10000
}

export function snackbarAutoHideDuration(notice: SnackbarNotice | null): number | null {
  if (!notice || notice.persistent) return null
  const duration = snackbarDurationMs[notice.severity]
  return notice.action ? Math.max(duration, 8000) : duration
}
