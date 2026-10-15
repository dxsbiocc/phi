import type { RemoteOmpRuntimeRef } from '../../src/main/agent/session/runtime-reference'
import { remoteOmpJournalPath } from '../../src/main/agent/session/runtime-reference'
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** A readback barrier observes the requested journal, not the CLI's temporary bootstrap session. */
export function t15AttachedReadback(
  value: unknown,
  reference: RemoteOmpRuntimeRef,
  model: { provider: string; id: string }
): boolean {
  return (
    record(value) &&
    record(value.model) &&
    value.model.provider === model.provider &&
    value.model.id === model.id &&
    value.sessionId === reference.ompSessionId &&
    value.sessionFile === remoteOmpJournalPath(reference)
  )
}
