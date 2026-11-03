import type { SessionMode } from '../../../../../shared/sessionMode'

const ALL_SESSION_MODES: readonly SessionMode[] = ['auto', 'ask', 'plan', 'plan_execute', 'full']

/** Local and SSH sessions run on the same kernel, so both offer every mode. */
export function availableSessionModes(): SessionMode[] {
  return [...ALL_SESSION_MODES]
}
