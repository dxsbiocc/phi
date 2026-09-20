import type { DbConnectorRetryPolicy } from './manifest-types'

export interface RetryDecisionInput {
  status?: number
  errorName?: string
  policyBlocked?: boolean
  validationFailed?: boolean
}

export interface RetryPolicyConfig {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_DB_RETRY_POLICY: RetryPolicyConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 409, 413, 422])

export function isRetryableDbFailure(input: RetryDecisionInput): boolean {
  if (input.policyBlocked || input.validationFailed) return false
  if (input.status !== undefined) {
    if (NON_RETRYABLE_STATUS.has(input.status)) return false
    return RETRYABLE_STATUS.has(input.status)
  }
  return input.errorName === 'TimeoutError' || input.errorName === 'TypeError'
}

export function retryDelayMs(
  attempt: number,
  policy: RetryPolicyConfig = DEFAULT_DB_RETRY_POLICY,
  retryAfterMs?: number
): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, policy.maxDelayMs)
  const exponent = Math.max(0, attempt - 1)
  const delay = policy.baseDelayMs * 2 ** exponent
  return Math.min(delay, policy.maxDelayMs)
}

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const dateMs = Date.parse(value)
  if (!Number.isFinite(dateMs)) return undefined
  return Math.max(0, dateMs - Date.now())
}

export function normalizeRetryPolicy(policy?: DbConnectorRetryPolicy): RetryPolicyConfig {
  return {
    maxAttempts: Math.max(
      1,
      Math.floor(policy?.maxAttempts ?? DEFAULT_DB_RETRY_POLICY.maxAttempts)
    ),
    baseDelayMs: Math.max(0, policy?.baseDelayMs ?? DEFAULT_DB_RETRY_POLICY.baseDelayMs),
    maxDelayMs: Math.max(0, policy?.maxDelayMs ?? DEFAULT_DB_RETRY_POLICY.maxDelayMs)
  }
}
