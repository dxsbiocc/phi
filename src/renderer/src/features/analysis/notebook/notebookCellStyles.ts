import { alpha, type Theme } from '@mui/material/styles'

import type { NotebookCellAccent } from '../lib/notebookViewModel'

export function notebookAccentColor(theme: Theme, accent: NotebookCellAccent): string {
  if (accent === 'python') return theme.palette.warning.main
  if (accent === 'r') return '#276DC3'
  if (accent === 'markdown') return '#607D8B'
  if (accent === 'ai') return theme.palette.primary.main
  return '#546E7A'
}

export function notebookCaretColor(theme: Theme): string {
  return theme.palette.mode === 'dark' ? theme.palette.primary.light : theme.palette.text.primary
}

export function notebookAccentBoxShadow(
  theme: Theme,
  accent: NotebookCellAccent,
  intensity = 0.08
): string {
  return `6px 6px 0 ${alpha(notebookAccentColor(theme, accent), intensity)}`
}

export function notebookAccentSelectionShadow(
  theme: Theme,
  accent: NotebookCellAccent,
  intensity = 0.07
): string {
  return notebookAccentBoxShadow(theme, accent, intensity)
}
