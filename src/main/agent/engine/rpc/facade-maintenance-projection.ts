import type { PhiCompactionResult, PhiKnownAgentEvent } from '../event-types'
import type { RpcFrame } from './types'

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const integer = (value: unknown): value is number =>
  nonnegative(value) && Number.isSafeInteger(value)
const optionalText = (value: unknown): boolean => value === undefined || text(value)
const optionalBoolean = (value: unknown): boolean =>
  value === undefined || typeof value === 'boolean'
const actions = new Set(['context-full', 'remote', 'handoff', 'shake', 'snapcompact'])
const clone = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value))

function compactionResult(raw: unknown): PhiCompactionResult | undefined {
  if (
    !record(raw) ||
    !text(raw.summary) ||
    !text(raw.firstKeptEntryId) ||
    !nonnegative(raw.tokensBefore) ||
    !optionalText(raw.shortSummary) ||
    (raw.preserveData !== undefined && !record(raw.preserveData))
  )
    return undefined
  return {
    summary: raw.summary,
    firstKeptEntryId: raw.firstKeptEntryId,
    tokensBefore: raw.tokensBefore,
    ...(text(raw.shortSummary) ? { shortSummary: raw.shortSummary } : {}),
    ...(raw.details !== undefined ? { details: clone(raw.details) } : {}),
    ...(record(raw.preserveData) ? { preserveData: structuredClone(raw.preserveData) } : {})
  }
}
function retryRecovery(raw: unknown): Record<string, unknown> | undefined {
  if (
    !record(raw) ||
    raw.kind !== 'auto-retry' ||
    !text(raw.status) ||
    !['recovered', 'superseded'].includes(raw.status) ||
    !integer(raw.attempt) ||
    !text(raw.recovery) ||
    !['credential', 'model', 'wait', 'plain'].includes(raw.recovery) ||
    !text(raw.note)
  )
    return undefined
  const base = {
    kind: 'auto-retry',
    status: raw.status,
    attempt: raw.attempt,
    recovery: raw.recovery,
    note: raw.note
  }
  if (raw.status === 'superseded') return base
  if (!text(raw.recoveredAt) || !Number.isFinite(Date.parse(raw.recoveredAt))) return undefined
  const superseded = raw.supersededBy
  if (
    superseded !== undefined &&
    (!record(superseded) ||
      !nonnegative(superseded.timestamp) ||
      !text(superseded.provider) ||
      !text(superseded.model) ||
      !optionalText(superseded.responseId))
  )
    return undefined
  return {
    ...base,
    recoveredAt: raw.recoveredAt,
    ...(record(superseded)
      ? {
          supersededBy: {
            timestamp: superseded.timestamp,
            provider: superseded.provider,
            model: superseded.model,
            ...(text(superseded.responseId) ? { responseId: superseded.responseId } : {})
          }
        }
      : {})
  }
}
function retryErrors(raw: unknown): unknown[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const output: unknown[] = []
  for (const entry of raw) {
    if (
      !record(entry) ||
      !text(entry.entryId) ||
      !text(entry.note) ||
      !optionalText(entry.persistenceKey)
    )
      return undefined
    const recovery = retryRecovery(entry.retryRecovery)
    if (!recovery) return undefined
    output.push({
      entryId: entry.entryId,
      note: entry.note,
      ...(text(entry.persistenceKey) ? { persistenceKey: entry.persistenceKey } : {}),
      retryRecovery: recovery
    })
  }
  return output
}

/** Pinned SDK/public Phi maintenance fields only; protocol payloads never cross this boundary. */
export function projectRpcMaintenanceEvent(
  frame: Readonly<RpcFrame>
): PhiKnownAgentEvent | undefined {
  switch (frame.type) {
    case 'auto_compaction_start':
      if (
        !text(frame.action) ||
        !actions.has(frame.action) ||
        !text(frame.reason) ||
        !['threshold', 'overflow', 'idle', 'incomplete'].includes(frame.reason)
      )
        return undefined
      return {
        type: 'auto_compaction_start',
        action: frame.action as 'context-full' | 'remote' | 'handoff' | 'shake' | 'snapcompact',
        reason: frame.reason as 'threshold' | 'overflow' | 'idle' | 'incomplete'
      }
    case 'auto_compaction_end': {
      if (
        !text(frame.action) ||
        !actions.has(frame.action) ||
        typeof frame.aborted !== 'boolean' ||
        typeof frame.willRetry !== 'boolean' ||
        !optionalText(frame.errorMessage) ||
        !optionalBoolean(frame.skipped) ||
        (frame.tokensAfter !== undefined && !nonnegative(frame.tokensAfter))
      )
        return undefined
      const result = frame.result === undefined ? undefined : compactionResult(frame.result)
      if (frame.result !== undefined && !result) return undefined
      return {
        type: 'auto_compaction_end',
        action: frame.action as 'context-full' | 'remote' | 'handoff' | 'shake' | 'snapcompact',
        result,
        aborted: frame.aborted,
        willRetry: frame.willRetry,
        ...(text(frame.errorMessage) ? { errorMessage: frame.errorMessage } : {}),
        ...(typeof frame.skipped === 'boolean' ? { skipped: frame.skipped } : {}),
        ...(nonnegative(frame.tokensAfter) ? { tokensAfter: frame.tokensAfter } : {})
      }
    }
    case 'auto_retry_start':
      if (
        !integer(frame.attempt) ||
        !integer(frame.maxAttempts) ||
        !nonnegative(frame.delayMs) ||
        !text(frame.errorMessage) ||
        (frame.errorId !== undefined && !integer(frame.errorId))
      )
        return undefined
      return {
        type: 'auto_retry_start',
        attempt: frame.attempt,
        maxAttempts: frame.maxAttempts,
        delayMs: frame.delayMs,
        errorMessage: frame.errorMessage,
        ...(integer(frame.errorId) ? { errorId: frame.errorId } : {})
      }
    case 'auto_retry_end': {
      if (
        typeof frame.success !== 'boolean' ||
        !integer(frame.attempt) ||
        !optionalText(frame.finalError)
      )
        return undefined
      const errors = frame.retryErrors === undefined ? undefined : retryErrors(frame.retryErrors)
      if (frame.retryErrors !== undefined && !errors) return undefined
      return {
        type: 'auto_retry_end',
        success: frame.success,
        attempt: frame.attempt,
        ...(text(frame.finalError) ? { finalError: frame.finalError } : {}),
        ...(errors ? { retryErrors: errors } : {})
      }
    }
    default:
      return undefined
  }
}
