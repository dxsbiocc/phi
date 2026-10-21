import type { SnackbarNotice, SnackbarSeverity } from '../components/AppSnackbarCard'

const snackbarDurationMs: Record<SnackbarSeverity, number> = {
  success: 2000,
  info: 2500,
  warning: 3000,
  error: 3500
}

export function snackbarAutoHideDuration(notice: SnackbarNotice | null): number | null {
  if (!notice || notice.persistent) return null
  return snackbarDurationMs[notice.severity]
}
