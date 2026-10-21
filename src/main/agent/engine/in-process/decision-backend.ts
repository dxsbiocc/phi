import {
  chatTextBackend,
  createNativeJudge,
  isJudgmentApi,
  TextJudge,
  type AssistantMessage,
  type ChoiceAnswer,
  type JudgmentRequest,
  type Usage
} from '@oh-my-pi/pi-ai'
import { calculateCost } from '@oh-my-pi/pi-catalog'
import type { ModelAvailabilitySettings } from '../../../../shared/modelAvailabilityTypes'
import { isModelEnabled } from '../../model-availability'
import type {
  DecisionModelOption,
  DecisionModelSelection,
  DecisionRequest,
  DecisionResult
} from '../../../../shared/decisionTypes'
import { isRecord, type RuntimeContext, type RuntimeModel } from './common'
import { getContext, modelBySelector } from './runtime-context'
import { sessions } from './state'

const NATIVE_ATTEMPT_TIMEOUT_MS = 12_000

type DecisionParams = {
  agentDir: string
  sessionId: string
  model: DecisionModelSelection
  judgeModel: DecisionModelSelection | null
  request: DecisionRequest
  availability?: ModelAvailabilitySettings
}
type BoundDecisionParams = DecisionParams & {
  providerSessionId: string
  metadataForProvider?: (provider: string) => Record<string, unknown> | undefined
}
type UsageRecorder = (
  model: RuntimeModel,
  usage: Usage,
  stopReason: AssistantMessage['stopReason']
) => void

/** Abort also bounds operations whose underlying transport ignores its signal. */
async function withSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined
  try {
    const value = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
    ])
    signal.throwIfAborted()
    return value
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

function matches(model: RuntimeModel, selection: DecisionModelSelection): boolean {
  return model.provider === selection.providerId && model.id === selection.modelId
}

export async function listDecisionModels(agentDir: string): Promise<DecisionModelOption[]> {
  const { modelRegistry } = await getContext(agentDir)
  const available = modelRegistry.getAvailable('judge')
  return modelRegistry
    .getAll('judge')
    .filter((model) => isJudgmentApi(model.api))
    .map((model) => ({
      providerId: model.provider,
      modelId: model.id,
      name: model.name || model.id,
      configured: available.some((candidate) =>
        matches(candidate, { providerId: model.provider, modelId: model.id })
      )
    }))
}

function judgmentRequest(request: DecisionRequest): JudgmentRequest {
  const ids = request.options.map((option) => option.id)
  if (
    !request.question.trim() ||
    ids.length < 2 ||
    ids.some((id) => !id.trim()) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error('Invalid decision request')
  }
  return {
    state: { purpose: request.purpose, context: request.context },
    questions: {
      decision: {
        type: 'choice',
        instructions: request.question,
        criteria: Object.fromEntries(
          request.options.map((option) => [option.id, option.description])
        )
      }
    }
  }
}

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function validAnswer(value: unknown, request: DecisionRequest, native: boolean): ChoiceAnswer {
  if (
    !isRecord(value) ||
    value.type !== 'choice' ||
    typeof value.choice !== 'string' ||
    !request.options.some((option) => option.id === value.choice)
  ) {
    throw new Error('Invalid decision answer')
  }
  if (native) {
    const probabilities = value.probabilities
    if (
      !isRecord(probabilities) ||
      Object.keys(probabilities).length !== request.options.length ||
      !probability(value.confidence)
    ) {
      throw new Error('Invalid decision probabilities')
    }
    let total = 0
    for (const { id } of request.options) {
      const weight = probabilities[id]
      if (
        !Object.hasOwn(probabilities, id) ||
        !probability(weight) ||
        weight > Number(probabilities[value.choice])
      ) {
        throw new Error('Invalid decision probabilities')
      }
      total += weight
    }
    if (Math.abs(total - 1) > 0.001) throw new Error('Invalid decision probabilities')
  }
  return value as unknown as ChoiceAnswer
}

async function nativeDecision(
  ctx: RuntimeContext,
  params: BoundDecisionParams & { judgeModel: DecisionModelSelection },
  request: JudgmentRequest,
  recordUsage: UsageRecorder,
  signal: AbortSignal
): Promise<DecisionResult> {
  const timeout = new AbortController()
  const timer = setTimeout(
    () => timeout.abort(new Error('Decision attempt timed out')),
    NATIVE_ATTEMPT_TIMEOUT_MS
  )
  const nativeSignal = AbortSignal.any([signal, timeout.signal])
  try {
    nativeSignal.throwIfAborted()
    const selection = params.judgeModel
    const { modelRegistry } = ctx
    const model = modelRegistry
      .getAvailable('judge')
      .find((candidate) => matches(candidate, selection))
    if (!model || !isJudgmentApi(model.api)) throw new Error('Decision model unavailable')
    const key = await withSignal(
      modelRegistry.getApiKey(model, params.providerSessionId, { signal: nativeSignal }),
      nativeSignal
    )
    if (key === undefined) throw new Error('Decision model unavailable')
    const headers = await withSignal(
      modelRegistry.resolveModelHeaders(model, nativeSignal),
      nativeSignal
    )
    const judge = createNativeJudge(model, {
      apiKey: modelRegistry.resolver(model, params.providerSessionId),
      headers
    })
    const result = await withSignal(judge.judge(request, { signal: nativeSignal }), nativeSignal)
    if (result.usage.cost.total === 0) calculateCost(model, result.usage)
    let answer: ChoiceAnswer
    try {
      answer = validAnswer(result.answers.decision, params.request, true)
    } catch (error) {
      recordUsage(model, result.usage, 'error')
      throw error
    }
    recordUsage(model, result.usage, 'stop')
    return {
      choice: answer.choice,
      source: 'native',
      model: selection,
      confidence: answer.confidence
    }
  } finally {
    clearTimeout(timer)
  }
}

async function modelDecision(
  ctx: RuntimeContext,
  params: BoundDecisionParams,
  request: JudgmentRequest,
  recordUsage: UsageRecorder,
  signal: AbortSignal
): Promise<DecisionResult> {
  signal.throwIfAborted()
  if (
    params.availability &&
    !isModelEnabled(params.availability, params.model.providerId, params.model.modelId)
  ) {
    throw new Error('Current model is disabled in Phi')
  }
  const { modelRegistry } = ctx
  const model = await withSignal(
    modelBySelector(ctx, { provider: params.model.providerId, id: params.model.modelId }),
    signal
  )
  if (!model || isJudgmentApi(model.api) || model.api === 'local-inference') {
    throw new Error('Decision model unavailable')
  }
  const key = await withSignal(
    modelRegistry.getApiKey(model, params.providerSessionId, { signal }),
    signal
  )
  if (key === undefined) throw new Error('Decision model unavailable')
  const judge = new TextJudge(
    // The SDK stream resolves model.resolveHeaders on each attempt, including command-backed headers.
    chatTextBackend(model, {
      apiKey: modelRegistry.resolver(model, params.providerSessionId),
      sessionId: params.providerSessionId,
      metadata: params.metadataForProvider?.(model.provider),
      // TextJudge's aggregate includes these attempts; never journal it again.
      onAttempt: (attempt) => recordUsage(model, attempt.usage, attempt.stopReason)
    })
  )
  const result = await withSignal(judge.judge(request, { signal }), signal)
  const answer = validAnswer(result.answers.decision, params.request, false)
  return {
    choice: answer.choice,
    source: 'model',
    model: params.model,
    fallbackReason: params.judgeModel ? 'unavailable' : 'not_configured'
  }
}

export async function evaluateDecision(
  params: DecisionParams,
  signal: AbortSignal
): Promise<DecisionResult> {
  signal.throwIfAborted()
  const request = judgmentRequest(params.request)
  const session = sessions.get(params.sessionId)?.result.session
  const manager = session?.sessionManager
  // Phi's registry ID, the SDK journal ID and the provider-facing ID are distinct.
  const bound: BoundDecisionParams = {
    ...params,
    providerSessionId: session?.agent.sessionId ?? params.sessionId,
    metadataForProvider: session?.agent.metadataForProvider.bind(session.agent)
  }
  const usageOwner = manager
    ? { sessionId: manager.getSessionId(), parentId: manager.getLeafId() }
    : undefined
  const recordUsage: UsageRecorder = (model, usage, stopReason) => {
    if (!manager || !usageOwner) return
    manager.appendModelUsage(
      {
        purpose: `phi_decision:${params.request.purpose}`,
        role: 'judge',
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason
      },
      usageOwner
    )
  }
  try {
    const ctx = await withSignal(getContext(params.agentDir), signal)
    if (params.judgeModel) {
      try {
        return await withSignal(
          nativeDecision(
            ctx,
            { ...bound, judgeModel: params.judgeModel },
            request,
            recordUsage,
            signal
          ),
          signal
        )
      } catch {
        // Caller cancellation and the overall deadline must never start a fallback.
        signal.throwIfAborted()
      }
    }
    return await withSignal(modelDecision(ctx, bound, request, recordUsage, signal), signal)
  } catch {
    signal.throwIfAborted()
    // Provider exceptions may contain credentials, endpoint bodies or private context.
    throw new Error('Decision evaluation failed')
  }
}
