import type { TeamPackIpcErrorCode } from '../../../../../shared/teamPackTypes'

import { teamCopy } from './teamCopy'

export type TeamUiErrorCode = TeamPackIpcErrorCode | 'UNKNOWN'

export function teamErrorText(code: TeamUiErrorCode | string | null): string | null {
  if (!code) return null
  if (code in teamCopy.error) return teamCopy.error[code as TeamUiErrorCode]
  return teamCopy.error.UNKNOWN
}
