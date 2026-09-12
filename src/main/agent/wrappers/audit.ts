import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { WrapperAuditEvent } from './types'

const SECRET_KEY_PATTERN = /secret|password|token|api[-_]?key|credential|authorization/i
const SECRET_VALUE_PATTERN = /^secret:\/\//i

/**
 * Recursively replaces any value whose key name looks secret-ish, or whose
 * string value is a `secret://...` reference, with a redaction marker.
 * Wrapper params/manifests never carry raw secret values (see technical
 * design's Network, Secrets, And Data Policy), but audit payloads are the
 * last line of defense — never trust upstream code to have already redacted.
 */
export function redactSecretsDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsDeep(item)) as unknown as T
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        result[key] = '[redacted]'
        continue
      }
      result[key] = redactSecretsDeep(entry)
    }
    return result as unknown as T
  }

  if (typeof value === 'string' && SECRET_VALUE_PATTERN.test(value)) {
    return '[redacted]' as unknown as T
  }

  return value
}

function ensureParentDir(path: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/** Appends one redacted audit event as a JSON line, creating the file/dir if needed. */
export function appendAuditLine(path: string, event: WrapperAuditEvent): void {
  ensureParentDir(path)
  const redacted = redactSecretsDeep(event)
  appendFileSync(path, `${JSON.stringify(redacted)}\n`, 'utf-8')
}
