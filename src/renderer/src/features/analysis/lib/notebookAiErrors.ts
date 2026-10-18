import { analysisCopy } from './analysisUiCopy'
export function notebookAiEmptyGenerationMessage(): string {
  return analysisCopy.aiEmptyGeneration
}

export type NotebookAiPromptError = {
  message: string
  detail: string
}

const emptyGenerationBareMessage = 'AI 没有生成可插入内容'

function stripFrameworkErrorPrefixes(value: string): string {
  let message = value.trim()
  for (;;) {
    const next = message
      .replace(/^Error invoking remote method '[^']+':\s*/i, '')
      .replace(/^Error occurred in handler for '[^']+':\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim()
    if (next === message) return next
    message = next
  }
}

function emptyGenerationDetail(message: string): string {
  if (message.startsWith('Agent 没有返回可插入的 cell')) {
    const suffix = message.slice('Agent 没有返回可插入的 cell'.length).trim()
    return suffix ? `${emptyGenerationBareMessage}。${suffix}` : notebookAiEmptyGenerationMessage()
  }
  if (message === emptyGenerationBareMessage) return notebookAiEmptyGenerationMessage()
  return message
}

export function notebookAiPromptError(error: unknown): NotebookAiPromptError {
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : analysisCopy.cannotGenerate
  const message = stripFrameworkErrorPrefixes(rawMessage)

  if (!message) {
    return { message: analysisCopy.cannotGenerate, detail: analysisCopy.cannotGenerate }
  }
  if (
    message.startsWith('Agent 没有返回可插入的 cell') ||
    message.startsWith('AI 没有生成可插入内容') ||
    message.startsWith('AI did not generate insertable content')
  ) {
    return {
      message: notebookAiEmptyGenerationMessage(),
      detail: emptyGenerationDetail(message)
    }
  }
  return { message, detail: message }
}

export function notebookAiPromptErrorMessage(error: unknown): string {
  return notebookAiPromptError(error).message
}
