import type { SessionMode } from '../../../../../shared/sessionMode'

const ALL_SESSION_MODES: readonly SessionMode[] = ['auto', 'ask', 'plan', 'plan_execute', 'full']

export function availableSessionModes(remote: boolean): SessionMode[] {
  return ALL_SESSION_MODES.filter((mode) => !remote || (mode !== 'plan' && mode !== 'plan_execute'))
}
