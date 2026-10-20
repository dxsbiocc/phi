import type { ModelSelection } from './projects'
import { getAuthManager } from './auth-manager'
import type { PhiAgentEventSummary } from './engine/types'
import { isPhiEventType, isPhiMessageUpdateSummary } from './engine/events'
import { fallbackMarkdownFromDescription } from './persona-manager'
import { createInMemoryRuntimeSessionManager } from './runtime/runtime-adapter'
import { createAgentSession } from './session/session-manager'

export interface PersonaGenerationText {
  extractAssistantText: (message: unknown) => string
  extractMessageText: (content: unknown) => string
  lastAssistantMessageFrom: (value: unknown) => unknown
}

export interface PersonaGenerationOptions {
  getSelectedModel: () => ModelSelection | null | undefined
  getNoProjectTaskFolder: () => string
  text: PersonaGenerationText
}

function assistantTextFromMessageUpdate(
  summary: PhiAgentEventSummary,
  currentText: string,
  readers: PersonaGenerationText
): string | null {
  if (summary.type !== 'message_update') return null
  const assistantMessageEvent = isPhiMessageUpdateSummary(summary)
    ? summary.assistantMessageEvent
    : undefined
  if (!assistantMessageEvent) return null

  if (
    assistantMessageEvent?.type === 'text_delta' &&
    typeof assistantMessageEvent.delta === 'string'
  ) {
    return `${currentText}${assistantMessageEvent.delta}`
  }
  if (typeof assistantMessageEvent.type === 'string') {
    const deltaText = readers.extractMessageText(assistantMessageEvent.delta)
    if (deltaText && assistantMessageEvent.type.endsWith('_delta')) {
      return `${currentText}${deltaText}`
    }
  }

  if (assistantMessageEvent.type === 'done') {
    const text = readers.extractAssistantText(assistantMessageEvent.message).trim()
    return text || currentText
  }

  if (assistantMessageEvent.partial) {
    const text = readers.extractAssistantText(assistantMessageEvent.partial).trim()
    if (text) return text
  }
  const text = readers.extractMessageText(assistantMessageEvent).trim()
  return text || null
}

export function assistantTextFromEventSummary(
  summary: PhiAgentEventSummary,
  currentText: string,
  readers: PersonaGenerationText
): string {
  const updatedText = assistantTextFromMessageUpdate(summary, currentText, readers)
  if (updatedText !== null) return updatedText

  const message = isPhiEventType(summary, 'message_end') ? summary.message : undefined

  if (summary.type === 'message_end' && message?.role === 'assistant') {
    const text = readers.extractAssistantText(message).trim()
    return text || currentText
  }

  const batchedText = readers
    .extractAssistantText(readers.lastAssistantMessageFrom(summary.messages))
    .trim()
  if (batchedText) return batchedText

  const resultText = readers
    .extractAssistantText(readers.lastAssistantMessageFrom(summary.result))
    .trim()
  if (resultText) return resultText

  return currentText
}

// Turns a free-text description of the desired assistant into a persona markdown file
// by asking the agent itself to write it, in a throwaway session (noTools + in-memory
// history) so it doesn't touch the user's real chat or leave tool-call side effects.
export async function generatePersonaMarkdown(
  description: string,
  control: { assertCurrent(): void } | undefined,
  options: PersonaGenerationOptions
): Promise<string> {
  control?.assertCurrent()
  const runtime = await getAuthManager().getRuntime()
  control?.assertCurrent()
  const selectedModel = options.getSelectedModel()
  const model = selectedModel
    ? runtime.getModel(selectedModel.providerId, selectedModel.modelId)
    : undefined
  let eventAssistantText = ''
  const cwd = options.getNoProjectTaskFolder()
  const { session } = await createAgentSession(
    {
      modelRuntime: runtime,
      cwd,
      noTools: 'all',
      sessionManager: createInMemoryRuntimeSessionManager(cwd),
      ...(model ? { model } : {})
    },
    (summary) => {
      eventAssistantText = assistantTextFromEventSummary(summary, eventAssistantText, options.text)
    }
  )

  try {
    control?.assertCurrent()
    await session.prompt(
      [
        '请根据下面用户对助手的描述，生成一份 Markdown 格式的智能体人设配置。',
        '内容应涵盖：性格特征、说话风格/语气、回答偏好（如结构、详略程度等）。',
        '只输出 Markdown 正文本身，不要包含任何解释、前后缀说明或代码块包裹符号。',
        '',
        '用户描述：',
        description
      ].join('\n')
    )

    control?.assertCurrent()
    const lastAssistantMessage = [...session.messages].reverse().find((message) => {
      const record = message as { role?: string }
      return record.role === 'assistant'
    })
    const generated =
      options.text.extractAssistantText(lastAssistantMessage).trim() || eventAssistantText.trim()
    return generated || fallbackMarkdownFromDescription(description)
  } finally {
    await session.dispose()
  }
}
