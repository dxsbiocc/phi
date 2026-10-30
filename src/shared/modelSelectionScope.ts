export type ModelSelectionScope = 'session' | 'new-session'

export const REMOTE_SELECTION_BUSY_CODE = '[PHI_MODEL_SELECTION:SESSION_BUSY]'

export function isNewSessionModelSelection(scope: unknown): boolean {
  return scope === 'new-session'
}
