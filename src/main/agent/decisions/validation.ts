import type {
  DecisionModelSelection,
  DecisionRequest,
  DecisionResult
} from '../../../shared/decisionTypes'

const PURPOSES = new Set(['task_routing', 'evidence_review', 'recovery'])
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function text(value: unknown, limit: number, empty = false): value is string {
  return typeof value === 'string' && value.length <= limit && (empty || Boolean(value.trim()))
}

/** Copy only the bounded Phi contract; no session, provider or control input is accepted. */
export function validateDecisionRequest(value: unknown): DecisionRequest {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !['purpose', 'context', 'question', 'options'].includes(key)
    ) ||
    !text(value.purpose, 32) ||
    !PURPOSES.has(value.purpose) ||
    !text(value.context, 32_768, true) ||
    !text(value.question, 4_096) ||
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.length > 12
  )
    throw new Error('Invalid or oversized decision request')
  const options = value.options.map((option: unknown) => {
    if (
      !record(option) ||
      Object.keys(option).some((key) => !['id', 'description'].includes(key)) ||
      typeof option.id !== 'string' ||
      !SAFE_ID.test(option.id) ||
      !text(option.description, 2_048)
    )
      throw new Error('Invalid decision option')
    return { id: option.id, description: option.description }
  })
  if (new Set(options.map((option) => option.id)).size !== options.length)
    throw new Error('Decision option IDs must be unique')
  const request: DecisionRequest = {
    purpose: value.purpose as DecisionRequest['purpose'],
    context: value.context,
    question: value.question,
    options
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 65_536)
    throw new Error('Decision request exceeds total size limit')
  return request
}

export function validateDecisionModel(value: unknown): DecisionModelSelection {
  if (!record(value) || !text(value.providerId, 256) || !text(value.modelId, 256))
    throw new Error('Decision requires an explicitly selected session model')
  return { providerId: value.providerId, modelId: value.modelId }
}

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

export function validateDecisionResult(value: unknown, request: DecisionRequest): DecisionResult {
  if (
    !record(value) ||
    typeof value.choice !== 'string' ||
    !request.options.some((option) => option.id === value.choice) ||
    (value.source !== 'native' && value.source !== 'model') ||
    (value.confidence !== undefined &&
      (value.source !== 'native' || !probability(value.confidence))) ||
    (value.fallbackReason !== undefined &&
      value.fallbackReason !== 'not_configured' &&
      value.fallbackReason !== 'unavailable')
  )
    throw new Error('Invalid decision result')
  return {
    choice: value.choice,
    source: value.source as DecisionResult['source'],
    model: validateDecisionModel(value.model),
    ...(value.confidence !== undefined ? { confidence: value.confidence as number } : {}),
    ...(value.fallbackReason !== undefined
      ? { fallbackReason: value.fallbackReason as DecisionResult['fallbackReason'] }
      : {})
  }
}
