import type {
  RuntimeAgentSession,
  RuntimeModel,
  RuntimePromptOptions
} from '../runtime/runtime-adapter'

const CONTINUE_PROMPT =
  '请继续完成用户上一条请求，沿用当前对话和已有工具结果，从中断处继续。不要重复执行已经成功完成的操作。'

function modelKey(model: Pick<RuntimeModel, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`
}

/** Transport failures may throw instead of emitting an assistant error message. */
function isModelRequestError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /abort|cancel|permission.*(?:tool|command|file)|approval|denied.*(?:tool|command|file)/i.test(
      message
    )
  )
    return false
  return /\b(?:400|401|402|403|404|408|409|413|422|429|5\d\d)\b|rate.?limit|quota|capacity|overload|authentication|api.?key|model.*(?:not found|unavailable|unsupported)|provider|region|country|network|fetch failed|timeout|timed out|ECONN|ETIMEDOUT|stream.*(?:closed|ended|error)/i.test(
    message
  )
}

/**
 * Keep the same run and history while trying each configured model at most once.
 * The caller owns automatic selection intent; fallback never saves a manual preference.
 */
export async function promptWithAutomaticModelFallback(input: {
  session: Pick<RuntimeAgentSession, 'model' | 'messages' | 'prompt' | 'setModel'>
  text: string
  options: RuntimePromptOptions
  automatic: boolean
  isCurrent(): boolean
  recordedFailure(): string | undefined
  clearFailure(): void
  candidates(): Promise<RuntimeModel[]>
  onSwitch(from: RuntimeModel, to: RuntimeModel, error: string): void
}): Promise<void> {
  const { session } = input
  const attempted = new Set<string>()
  let candidates: RuntimeModel[] | undefined
  let options = input.options
  let text = input.text

  while (input.isCurrent()) {
    const current = session.model
    if (current) attempted.add(modelKey(current))
    const historyLength = session.messages.length
    let failure: unknown
    let threw = false
    try {
      await session.prompt(text, options)
      failure = input.recordedFailure()
      if (!failure) return
    } catch (error) {
      failure = error
      threw = true
    }
    if (!input.isCurrent()) return
    if (
      !input.automatic ||
      !current ||
      (threw && !input.recordedFailure() && !isModelRequestError(failure))
    ) {
      if (threw) throw failure
      return
    }

    const errorMessage =
      input.recordedFailure() ?? (failure instanceof Error ? failure.message : String(failure))
    const admitted = !!input.recordedFailure() || session.messages.length > historyLength
    candidates ??= await input.candidates()
    if (!input.isCurrent()) return
    let switched = false
    for (const candidate of candidates) {
      const key = modelKey(candidate)
      if (attempted.has(key)) continue
      attempted.add(key)
      if (!input.isCurrent()) return
      try {
        await session.setModel(candidate)
      } catch (error) {
        if (!input.isCurrent()) return
        if (!isModelRequestError(error)) throw error
        continue
      }
      if (!input.isCurrent()) return
      input.onSwitch(current, candidate, errorMessage)
      input.clearFailure()
      // Before admission there is no user message to continue. Otherwise a hidden
      // developer continuation preserves the original user message and tool results.
      if (admitted) {
        text = CONTINUE_PROMPT
        options = {
          ...input.options,
          images: undefined,
          synthetic: true,
          userInitiated: false,
          expandPromptTemplates: false
        }
      }
      switched = true
      break
    }
    if (!switched) {
      // Preserve the final provider's diagnostic and the caller's existing failure path.
      if (threw) throw failure
      return
    }
  }
}
