import type { CustomTool } from '@oh-my-pi/pi-coding-agent'
import { basename } from 'node:path'

import { resolveInsideProject } from '../project-path'
import { transferFile } from './file-transfer'

const DEFAULT_MAX_BYTES = 250 * 1024 * 1024
const MAX_BYTES = 2 * 1024 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 20_000

interface DownloadTransport {
  fetch(input: URL, init: RequestInit): Promise<Response>
}

class DownloadPolicyError extends Error {
  readonly retryable = false
}

const SYSTEM_TRANSPORT: DownloadTransport = {
  fetch(input, init) {
    return fetch(input, init)
  }
}

function validateDownloadUrl(url: URL): void {
  if (url.protocol !== 'https:') {
    throw new DownloadPolicyError('Download blocked: only HTTPS URLs are allowed')
  }
  if (url.username || url.password) {
    throw new DownloadPolicyError('Download blocked: URL credentials are not allowed')
  }
  if (isBlockedHostname(url.hostname)) {
    throw new DownloadPolicyError('Download blocked: localhost/private hosts are not allowed')
  }
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  // IPv4-mapped IPv6 is the embedded IPv4 address; URL parsing writes it in hex
  // (::ffff:7f00:1), a literal may still use the dotted form.
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
  if (mappedDotted) return isBlockedHostname(mappedDotted[1])
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized)
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16)
    const low = Number.parseInt(mappedHex[2], 16)
    return isBlockedHostname(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
  }
  const octets = parseIpv4(normalized)
  if (octets) {
    const [first, second] = octets
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    )
  }
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true
  if (normalized.startsWith('fe80:')) return true
  const firstHextet = Number.parseInt(normalized.split(':', 1)[0], 16)
  return Number.isFinite(firstHextet) && (firstHextet & 0xfe00) === 0xfc00
}

function parseIpv4(hostname: string): [number, number, number, number] | undefined {
  const parts = hostname.split('.')
  if (parts.length !== 4) return undefined
  const octets = parts.map((part) => Number(part))
  if (
    octets.some(
      (octet, index) =>
        !Number.isInteger(octet) || octet < 0 || octet > 255 || String(octet) !== parts[index]
    )
  ) {
    return undefined
  }
  return octets as [number, number, number, number]
}

async function fetchWithTimeout(
  transport: DownloadTransport,
  url: URL,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  const controller = new AbortController()
  const requestSignal = AbortSignal.any([controller.signal, signal])
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      transport.fetch(url, { ...init, signal: requestSignal }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error('Download request timed out'))
        }, REQUEST_TIMEOUT_MS)
        timeout.unref?.()
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function requestDownload(
  transport: DownloadTransport,
  initialUrl: URL,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  let currentUrl = initialUrl
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    validateDownloadUrl(currentUrl)
    const response = await fetchWithTimeout(
      transport,
      currentUrl,
      { method: 'GET', headers, redirect: 'manual' },
      signal
    )
    const location = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || !location) return response
    await response.body?.cancel()
    currentUrl = new URL(location, currentUrl)
  }
  throw new DownloadPolicyError('Download exceeded the redirect limit')
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
  _agentDir: string,
  options: { remoteProject?: boolean; transport?: DownloadTransport } = {}
): CustomTool {
  return {
    name: 'download_file',
    label: 'Download File',
    description:
      'Download one public HTTPS file, including a database file, directly into the current project with retries, streaming, and resume. Use only when the user asked to fetch a file. The destination must stay inside the project.',
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
      if (options.remoteProject) {
        return {
          content: [
            {
              type: 'text',
              text: '远程项目暂不支持 download_file；不会回退到本机项目锚点。请先在服务器上准备文件。'
            }
          ],
          isError: true
        }
      }
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
          request: (headers, requestSignal) =>
            requestDownload(options.transport ?? SYSTEM_TRANSPORT, url, headers, requestSignal)
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
