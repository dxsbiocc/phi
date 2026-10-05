import type { IncomingMessage } from 'node:http'

import {
  isValidOfficeSelectionPath,
  MAX_OFFICE_SELECTION_PATH_CHARS,
  MAX_OFFICE_SELECTION_PATHS
} from './office-selection-events'

const MAX_SELECTION_BODY_BYTES = 8 * 1024

export class OfficePreviewRequestError extends Error {
  constructor(readonly status: number) {
    super('Invalid preview request')
  }
}

export function readOfficePreviewRequestBody(
  request: IncomingMessage,
  maxBytes = MAX_SELECTION_BODY_BYTES
): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let bytes = 0
    let oversized = false
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > maxBytes) oversized = true
      else body += chunk
    })
    request.once('end', () =>
      oversized ? reject(new OfficePreviewRequestError(413)) : resolve(body)
    )
    request.once('error', reject)
  })
}

export function parseOfficePreviewSelectionBody(body: string): string {
  const value = JSON.parse(body) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== 'paths') || !Array.isArray(record.paths)) {
    throw new Error('invalid')
  }
  if (record.paths.length > MAX_OFFICE_SELECTION_PATHS) throw new Error('invalid')
  if (
    record.paths.some(
      (path) =>
        typeof path !== 'string' ||
        path.length === 0 ||
        [...path].length > MAX_OFFICE_SELECTION_PATH_CHARS
    )
  ) {
    throw new Error('invalid')
  }
  if (record.paths.some((path) => !isValidOfficeSelectionPath(path as string))) {
    throw new Error('invalid')
  }
  return JSON.stringify({ paths: record.paths })
}
