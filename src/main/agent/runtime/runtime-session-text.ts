import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

type UnknownRecord = Record<string, unknown>

const DEFAULT_MAX_TEXT_CHARS = 20_000
const DEFAULT_MAX_MESSAGE_CHARS = 2_000

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return normalizeText(content)
  if (!Array.isArray(content)) return ''
  return normalizeText(
    content
      .map((part) => {
        if (typeof part === 'string') return part
        if (!isRecord(part)) return ''
        if (typeof part.text === 'string') return part.text
        if (typeof part.content === 'string') return part.content
        return ''
      })
      .filter(Boolean)
      .join(' ')
  )
}

function messageTextFromEntry(entry: unknown): string {
  if (!isRecord(entry)) return ''
  const message = isRecord(entry.message) ? entry.message : entry
  const role = message.role
  if (role !== 'user' && role !== 'assistant') return ''
  return textFromContent(message.content)
}

export async function readRuntimeSessionMessagesText(
  file: string,
  options: { maxTextChars?: number; maxMessageChars?: number } = {}
): Promise<string> {
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS
  const maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS
  const messages: string[] = []
  let totalChars = 0

  try {
    const lines = createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity
    })

    for await (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      let entry: unknown
      try {
        entry = JSON.parse(trimmed)
      } catch {
        continue
      }

      const text = messageTextFromEntry(entry)
      if (!text) continue

      const remaining = maxTextChars - totalChars
      if (remaining <= 0) break
      const clipped = text.slice(0, Math.min(maxMessageChars, remaining))
      messages.push(clipped)
      totalChars += clipped.length + 1
    }
  } catch {
    return ''
  }

  return messages.join(' ')
}
