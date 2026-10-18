import { createHash } from 'node:crypto'

/** Wait before retrying a server that failed to connect: first failure, second, then every later one. */
export const MCP_BACKOFF_STEPS_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 30 * 60_000]

interface BackoffEntry {
  readonly name: string
  readonly fingerprint: string
  readonly failures: number
  readonly until: number
}

const entries = new Map<string, BackoffEntry>()

/** Digest of a server's effective config. Only the digest is kept, so no secret is retained. */
export function mcpConfigFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex')
}

const keyOf = (scope: string, name: string): string => `${scope}\0${name}`

/** True while a server with this exact config is inside its back-off window. */
export function isMcpServerBackedOff(
  scope: string,
  name: string,
  fingerprint: string,
  now = Date.now()
): boolean {
  const entry = entries.get(keyOf(scope, name))
  return entry !== undefined && entry.fingerprint === fingerprint && now < entry.until
}

/** Records one failed start. A repeat failure of the same config lengthens the wait; a new config restarts it. */
export function recordMcpServerFailure(
  scope: string,
  name: string,
  fingerprint: string,
  now = Date.now()
): void {
  const key = keyOf(scope, name)
  const previous = entries.get(key)
  const failures = previous?.fingerprint === fingerprint ? previous.failures + 1 : 1
  const step = MCP_BACKOFF_STEPS_MS[Math.min(failures, MCP_BACKOFF_STEPS_MS.length) - 1]
  entries.set(key, { name, fingerprint, failures, until: now + step })
}

export function recordMcpServerSuccess(scope: string, name: string): void {
  entries.delete(keyOf(scope, name))
}

/** A user-initiated action on a connector (sign in, key change, enable/disable, test) retries it at once. */
export function clearMcpServerBackoff(name: string): void {
  for (const [key, entry] of entries) if (entry.name === name) entries.delete(key)
}

export function resetMcpBackoffForTests(): void {
  entries.clear()
}
