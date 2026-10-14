import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readHeadMetadata } from './metadata'
import {
  checkedPreviewUrl,
  pinPublicAddress,
  resolvePublicAddresses,
  type ResolveAddresses
} from './urlSafety'

export interface PreviewResourceOptions {
  signal: AbortSignal
  kind: 'html' | 'icon'
  maxBytes: number
}

export interface PreviewResource {
  url: string
  body: Buffer
  contentType: string
}

export type PreviewFetcher = (
  url: string,
  options: PreviewResourceOptions
) => Promise<PreviewResource>
export type RequestFactory = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void
) => ClientRequest

interface TransportDependencies {
  resolve?: ResolveAddresses
  request?: RequestFactory
}

interface ResponseData {
  status: number
  location: string | undefined
  contentType: string
  body: Buffer
}

export function createPreviewFetcher(dependencies: TransportDependencies = {}): PreviewFetcher {
  const resolve = dependencies.resolve ?? resolvePublicAddresses
  const request: RequestFactory =
    dependencies.request ??
    ((url, options, callback) =>
      (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, callback))
  return async (input, options) => {
    let url = checkedPreviewUrl(input)
    for (let redirects = 0; redirects <= 3; redirects++) {
      const address = await pinPublicAddress(url, resolve, options.signal)
      if (options.signal.aborted) throw new Error('Web preview timed out')
      const response = await requestResource(url, address, options, request)
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.location || redirects === 3)
          throw new Error('Web preview redirect limit reached')
        url = checkedPreviewUrl(new URL(response.location, url).href)
        continue
      }
      if (response.status < 200 || response.status >= 300)
        throw new Error('Web preview page unavailable')
      return { url: url.href, body: response.body, contentType: response.contentType }
    }
    throw new Error('Web preview redirect limit reached')
  }
}

function requestResource(
  url: URL,
  address: { address: string; family: 4 | 6 },
  options: PreviewResourceOptions,
  request: RequestFactory
): Promise<ResponseData> {
  return new Promise((resolve, reject) => {
    let settled = false
    let response: IncomingMessage | undefined
    let client: ClientRequest | undefined
    const finish = (error?: Error, result?: ResponseData): void => {
      if (settled) return
      settled = true
      options.signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result!)
      response?.destroy()
      client?.destroy()
    }
    const onAbort = (): void => finish(new Error('Web preview timed out'))
    if (options.signal.aborted) return onAbort()
    options.signal.addEventListener('abort', onAbort, { once: true })
    try {
      client = request(
        url,
        {
          method: 'GET',
          agent: false,
          signal: options.signal,
          maxHeaderSize: 16_384,
          // Keep the original hostname for Host, TLS SNI and certificate checks, but
          // connect only to the public address that was just validated.
          lookup: (_hostname, lookupOptions, callback) =>
            lookupOptions.all
              ? callback(null, [address])
              : callback(null, address.address, address.family),
          headers: {
            Accept:
              options.kind === 'html'
                ? 'text/html,application/xhtml+xml'
                : 'image/png,image/x-icon,image/gif',
            'Accept-Encoding': 'identity',
            'User-Agent': 'Phi-LinkPreview/1.0'
          }
        },
        (incoming) => {
          response = incoming
          incoming.on('error', (error) => finish(error))
          const status = incoming.statusCode ?? 0
          const contentType = incoming.headers['content-type'] ?? ''
          const location = incoming.headers.location
          const result = (body = Buffer.alloc(0)): ResponseData => ({
            status,
            location,
            contentType,
            body
          })
          if ([301, 302, 303, 307, 308].includes(status) || status < 200 || status >= 300) {
            finish(undefined, result())
            return
          }
          if (
            (options.kind === 'html' &&
              !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(contentType)) ||
            (options.kind === 'icon' &&
              !/^(?:image\/(?:png|gif|x-icon|vnd\.microsoft\.icon)|application\/octet-stream)(?:;|$)/iu.test(
                contentType
              )) ||
            (incoming.headers['content-encoding'] &&
              incoming.headers['content-encoding'] !== 'identity')
          ) {
            finish(new Error('Web preview content type unavailable'))
            return
          }
          let size = 0
          let scannedBytes = -1
          const chunks: Buffer[] = []
          incoming.on('data', (chunk: Buffer) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            size += data.length
            if (size > options.maxBytes) {
              finish(new Error('Web preview response too large'))
              return
            }
            chunks.push(data)
            // Remote servers can split a small head into thousands of tiny chunks.
            // Bound repeated scans independently of that attacker-controlled chunking.
            if (options.kind === 'html' && (scannedBytes < 0 || size - scannedBytes >= 8192)) {
              const body = Buffer.concat(chunks, size)
              chunks.length = 0
              chunks.push(body)
              scannedBytes = size
              if (readHeadMetadata(body.toString('utf8')).end !== null)
                finish(undefined, result(body))
            }
          })
          incoming.on('end', () => {
            const body = Buffer.concat(chunks, size)
            finish(undefined, result(body))
          })
          incoming.on('aborted', () => finish(new Error('Web preview response interrupted')))
          incoming.on('close', () => {
            if (!incoming.complete) finish(new Error('Web preview response interrupted'))
          })
        }
      )
      client.on('error', (error) => finish(error))
      client.end()
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Web preview request failed'))
    }
  })
}
