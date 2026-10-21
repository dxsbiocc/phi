import { alpha, type Theme } from '@mui/material/styles'

import type { NotebookCellAccent } from '../lib/notebookViewModel'

/** Official R blue. R cells use this as a single color. */
export const NOTEBOOK_R_BLUE = '#276DC3'
/** Python logo blue and yellow. Python cells blend them as one gradient. */
export const NOTEBOOK_PYTHON_BLUE = '#3776AB'
export const NOTEBOOK_PYTHON_YELLOW = '#FFD43B'

export function notebookAccentColor(theme: Theme, accent: NotebookCellAccent): string {
  if (accent === 'python') return NOTEBOOK_PYTHON_BLUE
  if (accent === 'r') return NOTEBOOK_R_BLUE
  if (accent === 'markdown') return '#607D8B'
  if (accent === 'ai') return theme.palette.primary.main
  return '#546E7A'
}

export function notebookLanguageBorderGradient(amount: number): string {
  return `linear-gradient(105deg, ${alpha(NOTEBOOK_PYTHON_BLUE, amount)}, ${alpha(NOTEBOOK_PYTHON_YELLOW, amount)})`
}

/** Light language fill. Python is a blue-to-yellow gradient; R stays one blue. */
export function notebookLanguageSurface(
  accent: NotebookCellAccent,
  amount: number
): string | undefined {
  if (amount <= 0) return undefined
  if (accent === 'python') return notebookLanguageBorderGradient(amount)
  if (accent === 'r')
    return `linear-gradient(${alpha(NOTEBOOK_R_BLUE, amount)}, ${alpha(NOTEBOOK_R_BLUE, amount)})`
  return undefined
}

export function notebookCaretColor(theme: Theme): string {
  return theme.palette.mode === 'dark' ? theme.palette.primary.light : theme.palette.text.primary
}

/** Neutral output surface. It stays gray so it stays separate from the language-colored code cell. */
export function notebookOutputSurface(theme: Theme): string {
  return theme.palette.mode === 'dark'
    ? alpha(theme.palette.common.white, 0.06)
    : alpha(theme.palette.grey[500], 0.1)
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
