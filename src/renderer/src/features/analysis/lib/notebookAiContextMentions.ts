import type { AnalysisNotebookContextReference } from '../../../types'
import { notebookContextKindLabel } from './notebookViewModel'

export type NotebookAiContextMention = {
  start: number
  end: number
  query: string
}

export function notebookAiContextMentionAtCursor(
  prompt: string,
  cursorPosition: number
): NotebookAiContextMention | null {
  const cursor = Math.max(0, Math.min(cursorPosition, prompt.length))
  const prefix = prompt.slice(0, cursor)
  const match = /(^|\s)@([^\s@]*)$/.exec(prefix)
  if (!match) return null
  const query = match[2] ?? ''
  const atStart = prefix.length - query.length - 1
  return {
    start: atStart,
    end: cursor,
    query
  }
}

function normalizedMentionQuery(value: string): string {
  return value.trim().replace(/^@/, '').toLocaleLowerCase()
}

export function filterNotebookAiContextOptions(
  options: AnalysisNotebookContextReference[],
  query: string
): AnalysisNotebookContextReference[] {
  const normalized = normalizedMentionQuery(query)
  if (!normalized) return options
  return options.filter((option) => {
    const fields = [
      option.name,
      option.detail,
      option.id,
      notebookContextKindLabel(option.kind),
      option.preview?.source,
      option.preview?.shape,
      option.preview?.value,
      option.preview?.output
    ]
    return fields.some((field) => field?.toLocaleLowerCase().includes(normalized))
  })
}

export function notebookAiPromptWithContextReference(
  prompt: string,
  mention: NotebookAiContextMention,
  reference: AnalysisNotebookContextReference
): string {
  const token = `@${reference.name}`
  const suffix = prompt.slice(mention.end)
  const needsSpace = suffix.length === 0 || (!/^\s/.test(suffix) && !/^[,.;:!?)]/.test(suffix))
  return `${prompt.slice(0, mention.start)}${token}${needsSpace ? ' ' : ''}${suffix}`
}
