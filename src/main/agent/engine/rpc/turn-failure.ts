import { CodedError } from '../../../../shared/errorCodes'
import { redactSensitiveText } from '../../redaction'
import type { RemoteRuntimeTurnResult } from './remote-session-runtime'

const MAX_PROVIDER_MESSAGE_CHARS = 300

function sanitized(text: string): string {
  const flat = redactSensitiveText(text).replace(/\s+/g, ' ').trim()
  return flat.length > MAX_PROVIDER_MESSAGE_CHARS
    ? `${flat.slice(0, MAX_PROVIDER_MESSAGE_CHARS)}…`
    : flat
}

function providerMessage(error: NonNullable<RemoteRuntimeTurnResult['result']['error']>): string {
  const origin = [error.provider, error.model].filter(Boolean).join('/')
  const status = error.httpStatus === undefined ? '' : `HTTP ${error.httpStatus}`
  const context = [origin, status].filter(Boolean).join(', ')
  const detail = sanitized(error.message)
  return `Remote turn failed${context ? ` (${context})` : ''}${detail ? `: ${detail}` : ''}`
}

/** Classifies a finished remote turn that did not complete. Never carries raw stderr or request bodies. */
export function remoteTurnFailure(
  turn: Pick<RemoteRuntimeTurnResult, 'result' | 'outcome'>
): CodedError {
  if (turn.outcome === 'aborted') return new CodedError('ABORTED', 'Remote turn was aborted')
  const error = turn.result.error
  if (error) {
    return new CodedError('PROVIDER_ERROR', providerMessage(error), {
      retryable: error.retryable
    })
  }
  return new CodedError('APPROVAL_DENIED', 'Remote approval was denied')
}
