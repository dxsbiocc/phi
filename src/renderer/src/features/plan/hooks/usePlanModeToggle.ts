import { useCallback, useState } from 'react'

export type PlanMode = 'off' | 'review' | 'execute'
export type PlanModeByDraft = Record<string, PlanMode>

export type PlanModePromptOptions = {
  planMode?: true
  planExecute?: true
}

export function setDraftPlanMode(
  modes: PlanModeByDraft,
  draftKey: string,
  mode: PlanMode
): PlanModeByDraft {
  if (mode === 'off') {
    if (!(draftKey in modes)) return modes
    const next = { ...modes }
    delete next[draftKey]
    return next
  }
  if (modes[draftKey] === mode) return modes
  return { ...modes, [draftKey]: mode }
}

export function planModeSendOptions(
  mode: PlanMode | undefined,
  disabled = false
): PlanModePromptOptions {
  if (disabled || !mode || mode === 'off') return {}
  return mode === 'review' ? { planMode: true } : { planExecute: true }
}

export function usePlanModeToggle(
  draftKey: string,
  disabled = false
): {
  mode: PlanMode
  selectMode: (mode: PlanMode) => void
  resetMode: () => void
  sendOptions: PlanModePromptOptions
} {
  const [modes, setModes] = useState<PlanModeByDraft>({})
  const mode = disabled ? 'off' : (modes[draftKey] ?? 'off')
  const selectMode = useCallback(
    (next: PlanMode): void => {
      if (disabled && next !== 'off') return
      setModes((current) => setDraftPlanMode(current, draftKey, next))
    },
    [disabled, draftKey]
  )
  const resetMode = useCallback(
    (): void => setModes((current) => setDraftPlanMode(current, draftKey, 'off')),
    [draftKey]
  )
  return { mode, selectMode, resetMode, sendOptions: planModeSendOptions(mode) }
}
