import type { AnalysisNotebookGeneratedCell } from '../../../shared/notebookCodeGeneration'
import type { PhiAgentEventSummary } from '../engine/types'

export type NotebookCompletionSelection = {
  cells: AnalysisNotebookGeneratedCell[]
  text: string
}

type CompletionParser = (candidate: unknown, language: string) => AnalysisNotebookGeneratedCell[]

const protocolTypes = new Set([
  'data-notebook-cells-completion',
  'notebook-cells-completion',
  'data-cell-completion',
  'cell-completion'
])
const nonAnswerType = /thinking|reasoning|tool|error|image/i
const answerContainers = [
  'content',
  'delta',
  'data',
  'value',
  'result',
  'output',
  'outputs',
  'message'
]

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keep provenance attached: an assistant's reasoning is never completion content. */
function answerContent(value: unknown): unknown {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(answerContent).filter((item) => item !== undefined)
  if (!record(value)) return undefined
  if (value.role !== undefined && value.role !== 'assistant') return undefined
  if (typeof value.type === 'string' && nonAnswerType.test(value.type)) return undefined
  if (typeof value.type === 'string' && protocolTypes.has(value.type)) return value
  if (
    value.type !== undefined &&
    !['text', 'output_text', 'input_text', 'markdown', 'message_delta'].includes(String(value.type))
  ) {
    return undefined
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => ['role', 'type', 'text', 'output_text', ...answerContainers].includes(key))
      .map(([key, item]) => [key, answerContent(item)])
      .filter(([, item]) => item !== undefined)
  )
}

function answerText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(answerText).join('')
  if (!record(value)) return ''
  if (typeof value.text === 'string') return value.text
  if (typeof value.output_text === 'string') return value.output_text
  return answerContainers.map((key) => answerText(value[key])).find(Boolean) ?? ''
}

function protocolCompletion(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(protocolCompletion).find((item) => item !== undefined)
  }
  if (!record(value)) return undefined
  if (typeof value.type === 'string' && protocolTypes.has(value.type)) return value
  return answerContainers
    .map((key) => protocolCompletion(value[key]))
    .find((item) => item !== undefined)
}

function assistantMessages(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(assistantMessages)
  if (!record(value)) return []
  if (value.role === 'assistant') return [value]
  return [...assistantMessages(value.messages), ...assistantMessages(value.message)]
}

function finalAnswer(message: unknown): unknown {
  if (!record(message) || message.role !== 'assistant') return undefined
  if (['error', 'aborted', 'toolUse'].includes(String(message.stopReason))) return undefined
  const answer = answerContent(message)
  return answerText(answer).trim() || protocolCompletion(answer) ? answer : undefined
}

/**
 * One aggregate answer plus the latest authoritative final replaces token candidate ranking.
 * Longer reasoning, earlier drafts and code-cell bonuses cannot displace the final answer.
 */
export class NotebookCompletionCollector {
  private body = ''
  private final: unknown
  private protocol: unknown
  private ended = false

  get text(): string {
    return answerText(this.final).trim() || this.body.trim()
  }

  observe(summary: PhiAgentEventSummary): void {
    if (protocolTypes.has(summary.type)) {
      if (this.ended) this.beginMessage()
      this.protocol = summary
      return
    }
    if (summary.type === 'message_start' && record(summary.message)) {
      if (summary.message.role === 'assistant') this.beginMessage()
      return
    }
    if (summary.type === 'message_update' && record(summary.assistantMessageEvent)) {
      const event = summary.assistantMessageEvent
      const type = String(event.type)
      if (nonAnswerType.test(type)) return
      if (type === 'done') {
        this.finishMessage(event.message)
        return
      }
      if (this.ended && ['start', 'text_start', 'partial'].includes(type)) this.beginMessage()
      if (type === 'text_delta' || type === 'message_delta') {
        if (this.ended) this.beginMessage()
        const delta = answerContent(event.delta)
        this.body += answerText(delta)
        this.protocol = protocolCompletion(delta) ?? this.protocol
      } else if (protocolTypes.has(type)) {
        if (this.ended) this.beginMessage()
        this.protocol = event
      } else if (!['partial', 'start', 'text_start', 'text_end'].includes(type)) {
        return
      }
      const partial = finalAnswer(event.partial)
      const partialText = answerText(partial)
      if (partialText) this.body = partialText
      this.protocol = protocolCompletion(partial) ?? this.protocol
      if (type === 'text_end' && !this.body) {
        this.body = answerText(answerContent(event.content))
      }
      return
    }
    if (summary.type === 'message_end') {
      this.finishMessage(summary.message)
      return
    }
    if (nonAnswerType.test(summary.type)) return
    const message =
      assistantMessages(summary.result).at(-1) ?? assistantMessages(summary.messages).at(-1)
    if (message) this.finishMessage(message)
  }

  select(
    language: string,
    parse: CompletionParser,
    history?: readonly unknown[]
  ): NotebookCompletionSelection | null {
    // A final response supersedes its partials even when it is invalid and needs repair.
    if (this.final !== undefined) return this.parse(this.final, language, parse)
    if (this.protocol !== undefined) return this.parse(this.protocol, language, parse)
    const historyAnswer = finalAnswer(assistantMessages(history).at(-1))
    const historical = this.parse(historyAnswer, language, parse)
    return historical ?? this.parse(this.body.trim(), language, parse)
  }

  private parse(
    candidate: unknown,
    language: string,
    parse: CompletionParser
  ): NotebookCompletionSelection | null {
    if (candidate === undefined || candidate === '') return null
    const cells = parse(candidate, language)
    return cells.length > 0 ? { cells, text: answerText(candidate).trim() } : null
  }

  private beginMessage(): void {
    this.body = ''
    this.final = undefined
    this.protocol = undefined
    this.ended = false
  }

  private finishMessage(message: unknown): void {
    const answer = finalAnswer(message)
    if (answer === undefined) return
    this.final = answer
    this.body = answerText(answer)
    this.ended = true
  }
}
