import { redactSensitiveText } from '../agent/redaction'

const QUOTED_SECRET =
  /((?:["']|\b)(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password|passphrase|authorization)(?:["']|\b)\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/giu

export function chatQueuePreview(text: string): string {
  return redactSensitiveText(text.replace(QUOTED_SECRET, '$1"[redacted]"'))
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160)
}
