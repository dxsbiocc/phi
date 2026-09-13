export const notebookAiEmptyGenerationMessage =
  'AI 没有生成可插入内容，请换一种更具体的描述后重试。'

export type NotebookAiPromptError = {
  message: string
  detail: string
}

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
    return suffix ? `AI 没有生成可插入内容。${suffix}` : 'AI 没有生成可插入内容'
  }
  return message
}

export function notebookAiPromptError(error: unknown): NotebookAiPromptError {
  const rawMessage =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '无法生成代码'
  const message = stripFrameworkErrorPrefixes(rawMessage)

  if (!message) {
    return { message: '无法生成代码', detail: '无法生成代码' }
  }
  if (
    message.startsWith('Agent 没有返回可插入的 cell') ||
    message.startsWith('AI 没有生成可插入内容')
  ) {
    return {
      message: notebookAiEmptyGenerationMessage,
      detail: emptyGenerationDetail(message)
    }
  }
  return { message, detail: message }
}

export function notebookAiPromptErrorMessage(error: unknown): string {
  return notebookAiPromptError(error).message
}
