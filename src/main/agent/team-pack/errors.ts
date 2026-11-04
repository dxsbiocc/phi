export type TeamPackErrorCode =
  | 'NOT_A_MEMBER'
  | 'BAD_SIGNATURE'
  | 'UNTRUSTED_TEAM_KEY'
  | 'ROLLBACK'
  | 'HASH_MISMATCH'
  | 'INNER_MISMATCH'
  | 'BAD_PASSPHRASE'
  | 'RELEASE_WITHDRAWN'
  | 'STORE_UNAVAILABLE'
  | 'INVALID_FORMAT'

export class TeamPackError extends Error {
  readonly code: TeamPackErrorCode

  constructor(code: TeamPackErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TeamPackError'
    this.code = code
  }
}

export function teamPackError(
  code: TeamPackErrorCode,
  message: string,
  cause?: unknown
): TeamPackError {
  return new TeamPackError(code, message, cause === undefined ? undefined : { cause })
}

export function isTeamPackError(error: unknown): error is TeamPackError {
  return error instanceof TeamPackError
}
