const REMOTE_METHOD_ERROR_PREFIX = /^Error invoking remote method '[^']+': Error:\s*/u
const ERROR_PREFIX = /^Error:\s*/u

export function readableErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback
  const trimmed = raw.trim()
  return (trimmed || fallback)
    .replace(REMOTE_METHOD_ERROR_PREFIX, '')
    .replace(ERROR_PREFIX, '')
    .trim()
}
