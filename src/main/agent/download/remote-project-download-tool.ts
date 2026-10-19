import type { PhiTool } from '../engine/types'
import { posix } from 'node:path'
import { PHI_REMOTE_DOWNLOAD_DESCRIPTION } from '../engine/phi-extension'

export { PHI_REMOTE_DOWNLOAD_DESCRIPTION } from '../engine/phi-extension'

import { suggestedFilename, validateDownloadUrl } from './project-download-tool'

import { errorMessage } from '../../../shared/errorCodes'
const DEFAULT_MAX_BYTES = 250 * 1024 * 1024
const MAX_BYTES = 2 * 1024 * 1024 * 1024

export type RemoteDownloadResult = { path: string; displayPath: string; bytes: number }
export type RemoteDownloadBackend = (
  request: {
    toolCallId: string
    url: string
    outputPath: string
    maxFileBytes: number
    expectedSha256?: string
  },
  signal?: AbortSignal
) => Promise<RemoteDownloadResult>

export function buildRemoteProjectDownloadTool(backend: RemoteDownloadBackend): PhiTool {
  return {
    name: 'download_file',
    label: 'Download File',
    description: PHI_REMOTE_DOWNLOAD_DESCRIPTION,
    site: 'host',
    loadMode: 'essential',
    approval: 'write',
    parameters: parameters(),
    async execute(toolCallId, params, _onUpdate, _ctx, signal) {
      try {
        const input = checkedInput(params)
        const result = await backend({ toolCallId, ...input }, signal)
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      } catch (error) {
        return {
          content: [{ type: 'text', text: errorMessage(error) }],
          isError: true
        }
      }
    }
  }
}

function parameters(): PhiTool['parameters'] {
  return {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string' },
      outputPath: { type: 'string', description: 'Remote project-relative destination path.' },
      maxFileBytes: { type: 'integer', minimum: 1, maximum: MAX_BYTES },
      expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' }
    }
  }
}

function checkedInput(value: unknown): {
  url: string
  outputPath: string
  maxFileBytes: number
  expectedSha256?: string
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('url is required')
  const record = value as Record<string, unknown>
  if (typeof record.url !== 'string') throw new Error('url is required')
  const url = new URL(record.url)
  validateDownloadUrl(url)
  const outputPath =
    typeof record.outputPath === 'string' && record.outputPath.trim()
      ? record.outputPath.trim()
      : suggestedFilename(url)
  if (unsafeOutputPath(outputPath)) throw new Error('Download destination must stay inside project')
  const requested = record.maxFileBytes
  const maxFileBytes =
    typeof requested === 'number' && Number.isInteger(requested)
      ? Math.min(Math.max(requested, 1), MAX_BYTES)
      : DEFAULT_MAX_BYTES
  const expectedSha256 =
    typeof record.expectedSha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(record.expectedSha256)
      ? record.expectedSha256.toLowerCase()
      : undefined
  if (record.expectedSha256 !== undefined && expectedSha256 === undefined) {
    throw new Error('expectedSha256 must be a 64-character hexadecimal SHA-256')
  }
  return {
    url: url.toString(),
    outputPath,
    maxFileBytes,
    ...(expectedSha256 ? { expectedSha256 } : {})
  }
}

function unsafeOutputPath(path: string): boolean {
  return (
    !path ||
    path.includes('\0') ||
    /^ssh:\/\//i.test(path) ||
    posix.isAbsolute(path) ||
    path.split('/').includes('..')
  )
}
