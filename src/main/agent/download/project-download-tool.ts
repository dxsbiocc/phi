import type { CustomTool } from '@oh-my-pi/pi-coding-agent'
import { basename } from 'node:path'

import { readAppSettings } from '../app-settings'
import { getDbProxyTransport } from '../db/egress-transport'
import type { DbConnectorManifest } from '../db/manifest-types'
import { executeDbHttpRequest, type DbEgressTransport } from '../db/policy'
import { resolveInsideProject } from '../project-path'
import { transferFile } from './file-transfer'

const DEFAULT_MAX_BYTES = 250 * 1024 * 1024
const MAX_BYTES = 2 * 1024 * 1024 * 1024

function downloadManifest(url: URL): DbConnectorManifest {
  return {
    phiDbConnectorVersion: 1,
    id: 'project/download',
    name: 'Project Download',
    protocolFamily: 'generic-http',
    curationTier: 'curated',
    baseUrl: `${url.origin}/`,
    networkPolicy: { allowedHosts: [url.hostname], allowRedirects: false },
    auth: { type: 'none' },
    retryPolicy: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5000 },
    domains: []
  }
}

function suggestedFilename(url: URL): string {
  try {
    const name = basename(decodeURIComponent(url.pathname))
    return name && name !== '/' && name !== '.' ? name : 'download'
  } catch {
    return 'download'
  }
}

export function buildProjectDownloadTool(
  cwd: string,
  agentDir: string,
  options: { transport?: DbEgressTransport } = {}
): CustomTool {
  return {
    name: 'download_file',
    label: 'Download File',
    description:
      'Download one public HTTPS file into the current project with retries, streaming, and resume. Use only when the user asked to fetch a file. Delegate database discovery and GEO/SRA downloads to Database first; use this tool for other direct files or after an allowed specialist fallback. The destination must stay inside the project.',
    loadMode: 'essential',
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string' },
        outputPath: { type: 'string', description: 'Project-relative destination path.' },
        maxFileBytes: { type: 'integer', minimum: 1, maximum: MAX_BYTES }
      }
    },
    approval: 'write',
    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      try {
        const input = params as Record<string, unknown>
        if (typeof input.url !== 'string') throw new Error('url is required')
        const url = new URL(input.url)
        const requested =
          typeof input.outputPath === 'string' && input.outputPath.trim()
            ? input.outputPath.trim()
            : suggestedFilename(url)
        const destination = resolveInsideProject(cwd, requested, 'Download destination')
        if (!destination.ok) throw new Error(destination.error)
        const maxFileBytes =
          typeof input.maxFileBytes === 'number' && Number.isInteger(input.maxFileBytes)
            ? Math.min(Math.max(input.maxFileBytes, 1), MAX_BYTES)
            : DEFAULT_MAX_BYTES
        const settings = readAppSettings(agentDir)
        let lastProgress = 0
        const result = await transferFile({
          url: url.toString(),
          destination: destination.path,
          maxBytes: maxFileBytes,
          signal,
          onProgress(bytes, totalBytes) {
            if (bytes - lastProgress < 1024 * 1024 && bytes !== totalBytes) return
            lastProgress = bytes
            onUpdate?.({
              content: [
                {
                  type: 'text',
                  text: `Downloaded ${bytes}${totalBytes ? ` / ${totalBytes}` : ''} bytes`
                }
              ]
            })
          },
          request: async (headers, requestSignal) => {
            let currentUrl = url
            for (let redirects = 0; redirects <= 5; redirects += 1) {
              const result = await executeDbHttpRequest({
                manifest: downloadManifest(currentUrl),
                path: currentUrl.toString(),
                headers,
                defaultProxyMode: settings.defaultProxyMode,
                transport: options.transport,
                proxyTransport: getDbProxyTransport(),
                maxResponseBytes: maxFileBytes,
                streamResponse: true,
                allowRedirectResponse: true,
                cacheTtlMs: 0,
                signal: requestSignal,
                idempotent: true,
                agentDir
              })
              const response = result.response
              const location = response.headers.get('location')
              if (response.status < 300 || response.status >= 400 || !location) return response
              await response.body?.cancel()
              currentUrl = new URL(location, currentUrl)
            }
            throw new Error('Download exceeded the redirect limit')
          }
        })
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
