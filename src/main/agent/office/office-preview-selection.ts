import { request as requestHttp } from 'node:http'

const LOOPBACK_HOST = '127.0.0.1'
const CLEAR_SELECTION_TIMEOUT_MS = 2_000

export function clearOfficePreviewSelection(upstreamPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65_535) {
      reject(new Error('Invalid Office preview port'))
      return
    }
    const body = '{"paths":[]}'
    const request = requestHttp(
      {
        hostname: LOOPBACK_HOST,
        port: upstreamPort,
        path: '/api/selection',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
        },
        timeout: CLEAR_SELECTION_TIMEOUT_MS
      },
      (response) => {
        response.resume()
        response.once('end', () => {
          const status = response.statusCode ?? 500
          if (status >= 200 && status < 300) resolve()
          else reject(new Error('Office selection clear failed'))
        })
      }
    )
    request.once('timeout', () => request.destroy(new Error('Office selection clear timed out')))
    request.once('error', reject)
    request.end(body)
  })
}
