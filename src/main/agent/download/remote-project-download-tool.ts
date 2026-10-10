import type { CustomTool } from '@oh-my-pi/pi-coding-agent'
import { posix } from 'node:path'

import { suggestedFilename, validateDownloadUrl } from './project-download-tool'

const DEFAULT_MAX_BYTES = 250 * 1024 * 1024
const MAX_BYTES = 2 * 1024 * 1024 * 1024

export const PHI_REMOTE_DOWNLOAD_DESCRIPTION =
  'Download one public HTTPS file directly from the server into the current SSH project. The server performs the request and write; Phi never downloads through or writes to the local session anchor.'

export type RemoteDownloadResult = { path: string; displayPath: string; bytes: number }
export type RemoteDownloadBackend = (
  request: { toolCallId: string; url: string; outputPath: string; maxFileBytes: number },
  signal?: AbortSignal
) => Promise<RemoteDownloadResult>

export function buildRemoteProjectDownloadTool(backend: RemoteDownloadBackend): CustomTool {
  return {
    name: 'download_file',
    label: 'Download File',
    description: PHI_REMOTE_DOWNLOAD_DESCRIPTION,
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
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true
        }
      }
    }
  }
}

function parameters(): CustomTool['parameters'] {
  return {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string' },
      outputPath: { type: 'string', description: 'Remote project-relative destination path.' },
      maxFileBytes: { type: 'integer', minimum: 1, maximum: MAX_BYTES }
    }
  }
}

function checkedInput(value: unknown): { url: string; outputPath: string; maxFileBytes: number } {
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
  return { url: url.toString(), outputPath, maxFileBytes }
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
