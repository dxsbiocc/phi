import type {
  NotebookAiGenerationActivity,
  NotebookAiGenerationJobPhase
} from '../../../shared/notebookAiJobTypes'
import type { PhiAgentEventSummary } from '../engine/event-types'

const MAX_ENTRIES = 80
const MAX_ENTRY_LENGTH = 8_000
const MAX_TOTAL_LENGTH = 40_000
const PHASE_TEXT: Record<NotebookAiGenerationJobPhase, string> = {
  preparing: '准备上下文',
  waiting: '等待模型响应',
  generating: '正在生成代码',
  repairing: '修正生成结果',
  completed: '生成完成',
  failed: '生成失败'
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function resultText(value: unknown): string {
  if (typeof value === 'string') return value.slice(-MAX_ENTRY_LENGTH)
  const content = record(value)?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    const item = record(part)
    if (item?.type === 'text' && typeof item.text === 'string') {
      text = `${text}${text ? '\n' : ''}${item.text.slice(-MAX_ENTRY_LENGTH)}`.slice(
        -MAX_ENTRY_LENGTH
      )
    }
  }
  return text
}

/** Bounded event journal; token deltas update one block rather than creating token rows. */
export class NotebookAiActivity {
  readonly entries: NotebookAiGenerationActivity[] = []
  private readonly streams = new Map<string, NotebookAiGenerationActivity>()
  private messageIndex = 0
  private nextId = 0
  private length = 0

  constructor(private readonly timestamp: () => string) {}

  phase(phase: NotebookAiGenerationJobPhase): void {
    // Repair runs in a new temporary agent session; some providers emit no message_start.
    if (phase === 'repairing') {
      this.finish(false)
      this.messageIndex += 1
    }
    this.add('phase', PHASE_TEXT[phase])
  }

  finish(failed: boolean): void {
    const at = this.timestamp()
    for (const entry of this.entries) {
      if (entry.status !== 'running') continue
      entry.status = failed ? 'failed' : 'completed'
      entry.updatedAt = at
    }
  }

  observe(summary: PhiAgentEventSummary): boolean {
    if (summary.type === 'message_start') {
      if (record(summary.message)?.role !== 'assistant') return false
      this.messageIndex += 1
      return false
    }
    if (summary.type === 'message_update') {
      const event = record(summary.assistantMessageEvent)
      if (!event) return false
      const type = typeof event.type === 'string' ? event.type : ''
      if (/^(thinking|text)_(start|delta|end)$/.test(type)) {
        const kind = type.startsWith('thinking') ? 'thinking' : 'text'
        const key = `${this.messageIndex}:${kind}:${event.contentIndex ?? 0}`
        const entry = this.stream(key, kind)
        if (type.endsWith('_delta') && typeof event.delta === 'string') {
          this.setText(entry, `${entry.text}${event.delta.slice(-MAX_ENTRY_LENGTH)}`)
        } else if (type.endsWith('_end')) {
          if (typeof event.content === 'string') this.setText(entry, event.content)
          entry.status = 'completed'
        }
        entry.updatedAt = this.timestamp()
        return true
      }
      if (type === 'done') return this.message(event.message)
      if (type === 'error') return this.message(event.error)
      return false
    }
    if (summary.type === 'message_end') return this.message(summary.message)
    if (!/^tool_execution_(start|update|end)$/.test(summary.type)) return false
    const toolId = summary.toolCallId ?? summary.id
    if (typeof toolId !== 'string') return false
    const entry = this.stream(`tool:${toolId}`, 'action')
    if (typeof summary.toolName === 'string') entry.label = summary.toolName.slice(0, 200)
    if (summary.type === 'tool_execution_start' && typeof summary.intent === 'string') {
      this.setText(entry, summary.intent)
    }
    if (summary.type === 'tool_execution_update' || summary.type === 'tool_execution_end') {
      const text = resultText(
        summary.type === 'tool_execution_update' ? summary.partialResult : summary.result
      )
      if (text) this.setText(entry, text)
    }
    if (summary.type === 'tool_execution_end') {
      entry.status = summary.isError ? 'failed' : 'completed'
    }
    entry.updatedAt = this.timestamp()
    return true
  }

  private message(value: unknown): boolean {
    const message = record(value)
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return false
    let observed = false
    message.content.forEach((value, index) => {
      const part = record(value)
      if (!part || (part.type !== 'text' && part.type !== 'thinking')) return
      const text = part.type === 'text' ? part.text : part.thinking
      if (typeof text !== 'string' || !text) return
      const entry = this.stream(`${this.messageIndex}:${part.type}:${index}`, part.type)
      this.setText(entry, text)
      entry.status = 'completed'
      entry.updatedAt = this.timestamp()
      observed = true
    })
    return observed
  }

  private stream(
    key: string,
    kind: NotebookAiGenerationActivity['kind']
  ): NotebookAiGenerationActivity {
    const existing = this.streams.get(key)
    if (existing) return existing
    const entry = this.add(kind, '')
    entry.status = 'running'
    this.streams.set(key, entry)
    return entry
  }

  private add(
    kind: NotebookAiGenerationActivity['kind'],
    text: string
  ): NotebookAiGenerationActivity {
    const at = this.timestamp()
    const entry: NotebookAiGenerationActivity = {
      id: String(++this.nextId),
      kind,
      text: '',
      at,
      updatedAt: at
    }
    this.entries.push(entry)
    this.setText(entry, text)
    return entry
  }

  private setText(entry: NotebookAiGenerationActivity, text: string): void {
    this.length -= entry.text.length
    entry.text = text.slice(-MAX_ENTRY_LENGTH)
    this.length += entry.text.length
    while (this.entries.length > MAX_ENTRIES || this.length > MAX_TOTAL_LENGTH) {
      const removed = this.entries.shift()!
      this.length -= removed.text.length
      for (const [key, candidate] of this.streams) {
        if (candidate === removed) this.streams.delete(key)
      }
    }
  }
}
