import type { PhiEventMessage } from '../event-types'
import type { PhiToolContent } from '../types'

/**
 * Projection of OMP's non-LLM history roles (`custom`/`hookMessage` such as the bash
 * background-job `async-result` follow-up, `bashExecution`, `pythonExecution`,
 * `branchSummary`, `fileMention`). Only declared fields are copied, so nothing outside
 * the OMP contract (provider payloads, authority fields) crosses the public boundary.
 */

const MAX_DETAILS_BYTES = 256 * 1024
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

function content(raw: unknown): string | PhiToolContent[] | undefined {
  if (text(raw)) return raw
  if (!Array.isArray(raw)) return undefined
  const result: PhiToolContent[] = []
  for (const part of raw) {
    if (!record(part)) return undefined
    if (part.type === 'text' && text(part.text)) result.push({ type: 'text', text: part.text })
    else if (part.type === 'image' && text(part.data) && text(part.mimeType))
      result.push({ type: 'image', data: part.data, mimeType: part.mimeType })
    else return undefined
  }
  return result
}

/** Details are advisory display data: drop them when not JSON-safe or oversized. */
function details(value: unknown): { details: unknown } | Record<string, never> {
  if (value === undefined) return {}
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined || encoded.length > MAX_DETAILS_BYTES) return {}
    return { details: JSON.parse(encoded) as unknown }
  } catch {
    return {}
  }
}

export const EXTENSION_MESSAGE_ROLES: ReadonlySet<string> = new Set([
  'custom',
  'hookMessage',
  'bashExecution',
  'pythonExecution',
  'branchSummary',
  'fileMention'
])

/** Returns undefined when the role is not one of these shapes or the shape is malformed. */
export function projectExtensionMessage(raw: Record<string, unknown>): PhiEventMessage | undefined {
  if (!finite(raw.timestamp) || raw.timestamp < 0) return undefined
  const timestamp = raw.timestamp
  switch (raw.role) {
    case 'custom':
    case 'hookMessage': {
      const body = content(raw.content)
      if (!text(raw.customType) || body === undefined || typeof raw.display !== 'boolean')
        return undefined
      return {
        role: raw.role,
        customType: raw.customType,
        content: body,
        display: raw.display,
        ...details(raw.details),
        ...(raw.attribution === 'user' || raw.attribution === 'agent'
          ? { attribution: raw.attribution }
          : {}),
        timestamp
      }
    }
    case 'bashExecution':
    case 'pythonExecution': {
      const source = raw.role === 'bashExecution' ? raw.command : raw.code
      if (
        !text(source) ||
        !text(raw.output) ||
        typeof raw.cancelled !== 'boolean' ||
        typeof raw.truncated !== 'boolean' ||
        (raw.exitCode !== undefined && !finite(raw.exitCode))
      )
        return undefined
      return {
        role: raw.role,
        [raw.role === 'bashExecution' ? 'command' : 'code']: source,
        output: raw.output,
        ...(raw.exitCode === undefined ? {} : { exitCode: raw.exitCode }),
        cancelled: raw.cancelled,
        truncated: raw.truncated,
        ...(typeof raw.excludeFromContext === 'boolean'
          ? { excludeFromContext: raw.excludeFromContext }
          : {}),
        timestamp
      }
    }
    case 'branchSummary':
      return text(raw.summary) && text(raw.fromId)
        ? { role: 'branchSummary', summary: raw.summary, fromId: raw.fromId, timestamp }
        : undefined
    case 'fileMention': {
      if (!Array.isArray(raw.files)) return undefined
      const files: Record<string, unknown>[] = []
      for (const file of raw.files) {
        if (!record(file) || !text(file.path) || !text(file.content)) return undefined
        files.push({
          path: file.path,
          content: file.content,
          ...(finite(file.lineCount) ? { lineCount: file.lineCount } : {}),
          ...(finite(file.byteSize) ? { byteSize: file.byteSize } : {}),
          ...(file.skippedReason === 'tooLarge' || file.skippedReason === 'binary'
            ? { skippedReason: file.skippedReason }
            : {})
        })
      }
      return { role: 'fileMention', files, timestamp }
    }
    default:
      return undefined
  }
}
