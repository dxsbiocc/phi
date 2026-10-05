import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

import type { OfficeDocumentKind, OfficeSelectionSummary } from '../../../shared/officeProtocol'
import { OfficeSelectionSseParser } from './office-selection-events'
import type { OfficeCellPatch } from './office-selection-events'
import {
  OFFICE_HUMAN_EDIT_LIMITS,
  OfficeHumanEditGate,
  OfficeHumanEditRequestError,
  parseOfficeHumanCellEditBody,
  humanEditErrorResponse,
  type OfficeHumanEditAccess,
  type OfficeHumanCellEdit
} from './office-human-edit'
import { adaptOfficePreviewHtml } from './office-preview-adapter'
import type { OfficeHighlightTarget } from './office-highlight'
import { OFFICE_PREVIEW_CONTROL_PATH, OfficePreviewControlChannel } from './office-preview-control'
import { officePreviewRouteAllowed } from './office-preview-route-policy'
import {
  OfficePreviewRequestError,
  parseOfficePreviewSelectionBody,
  readOfficePreviewRequestBody
} from './office-preview-request'
export { clearOfficePreviewSelection } from './office-preview-selection'
export const OFFICE_PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'self'"

const LOOPBACK_HOST = '127.0.0.1'
const MAX_PREVIEW_HTML_BYTES = 1024 * 1024
// Admitted XLSX files can contain 80,000 cells; OfficeCLI renders the full grid into one page.
const MAX_XLSX_PREVIEW_HTML_BYTES = 16 * 1024 * 1024
// PPTX watch inlines media as data URLs, so valid 25 MiB packages can expand beyond the ZIP size.
const MAX_PPTX_PREVIEW_HTML_BYTES = 40 * 1024 * 1024

export interface OfficePreviewGateway {
  artifactId: string
  port: number
  url: string
  publishHighlight?: (target: OfficeHighlightTarget, follow: boolean) => boolean
  close: () => Promise<void>
}

export interface StartOfficePreviewGatewayInput {
  artifactId: string
  kind?: OfficeDocumentKind
  upstreamPort: number
  onSelection?: (selection: OfficeSelectionSummary | null) => void
  onCellPatch?: (patch: OfficeCellPatch) => void
  onFullRefresh?: (version: number) => void
  onDocumentPatch?: (version: number) => void
  onPresentationChange?: (version: number, slideCountChanged: boolean) => void
  onHumanCellEdit?: (edit: OfficeHumanCellEdit) => Promise<void>
  humanEditAccess?: () => OfficeHumanEditAccess
  onHumanEditRejected?: (code: string) => void
  humanEditClock?: () => number
  humanEditId?: () => string
}

function securityHeaders(headers: IncomingHttpHeaders = {}): IncomingHttpHeaders {
  return {
    ...headers,
    'content-security-policy': OFFICE_PREVIEW_CSP,
    'x-content-type-options': 'nosniff'
  }
}

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }))
  response.end(body)
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, securityHeaders({ 'content-type': 'application/json; charset=utf-8' }))
  response.end(JSON.stringify(body))
}

function publishHumanEditRejection(input: StartOfficePreviewGatewayInput, code: string): void {
  try {
    input.onHumanEditRejected?.(code)
  } catch {
    // User feedback must not change the gateway's security decision or response.
  }
}

function requestPath(request: IncomingMessage): string | undefined {
  if (!request.url || !request.method) return undefined
  const parsed = new URL(request.url, 'http://placeholder')
  if (parsed.search || parsed.hash) return undefined
  return parsed.pathname
}

function validBrowserIdentity(request: IncomingMessage, gatewayPort: number): boolean {
  const expectedHost = `${LOOPBACK_HOST}:${gatewayPort}`
  if (request.headers.host !== expectedHost) return false
  const origin = request.headers.origin
  return origin === undefined || origin === `http://${expectedHost}`
}

function upstreamHeaders(request: IncomingMessage, upstreamPort: number): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {
    accept: request.headers.accept,
    'cache-control': request.headers['cache-control'],
    'content-type': request.headers['content-type'],
    'last-event-id': request.headers['last-event-id'],
    host: `${LOOPBACK_HOST}:${upstreamPort}`
  }
  if (request.headers.origin) headers.origin = `http://${LOOPBACK_HOST}:${upstreamPort}`
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined))
}

function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  upstreamPort: number,
  body?: string,
  onSelection?: (selection: OfficeSelectionSummary | null) => void,
  onCellPatch?: (patch: OfficeCellPatch) => void,
  onFullRefresh?: (version: number) => void,
  onDocumentPatch?: (version: number) => void,
  onPresentationChange?: (version: number, slideCountChanged: boolean) => void,
  previewAccess?: () => OfficeHumanEditAccess,
  previewHtmlLimitBytes = MAX_PREVIEW_HTML_BYTES,
  aiControls = true
): void {
  const upstream = requestHttp(
    {
      hostname: LOOPBACK_HOST,
      port: upstreamPort,
      method: request.method,
      path,
      headers: upstreamHeaders(request, upstreamPort)
    },
    (upstreamResponse) => {
      if (
        path === '/' &&
        String(upstreamResponse.headers['content-type']).toLowerCase().includes('text/html')
      ) {
        proxyAdaptedPreview(
          upstreamResponse,
          response,
          previewAccess,
          previewHtmlLimitBytes,
          aiControls
        )
        return
      }
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        securityHeaders(upstreamResponse.headers)
      )
      if (
        path === '/events' &&
        (onSelection || onCellPatch || onFullRefresh || onDocumentPatch || onPresentationChange)
      ) {
        const decoder = new StringDecoder('utf8')
        const parser = new OfficeSelectionSseParser(
          onSelection,
          onCellPatch,
          onFullRefresh,
          onDocumentPatch,
          onPresentationChange
        )
        upstreamResponse.on('data', (chunk: Buffer) => parser.push(decoder.write(chunk)))
        upstreamResponse.once('end', () => parser.push(decoder.end()))
      }
      upstreamResponse.pipe(response)
    }
  )
  upstream.on('error', () => {
    if (!response.headersSent) respond(response, 502, 'Office preview upstream unavailable')
    else response.destroy()
  })
  response.once('close', () => upstream.destroy())
  request.once('aborted', () => upstream.destroy())
  if (body === undefined) request.pipe(upstream)
  else upstream.end(body)
}

function proxyAdaptedPreview(
  upstream: IncomingMessage,
  response: ServerResponse,
  previewAccess: (() => OfficeHumanEditAccess) | undefined,
  maxBytes: number,
  aiControls: boolean
): void {
  const chunks: Buffer[] = []
  let bytes = 0
  upstream.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes <= maxBytes) chunks.push(chunk)
  })
  upstream.once('end', () => {
    if (bytes > maxBytes) {
      respond(response, 502, 'Office preview page is too large')
      return
    }
    const html = adaptOfficePreviewHtml(
      Buffer.concat(chunks).toString('utf8'),
      (previewAccess?.() ?? 'read_only') !== 'writable',
      aiControls
    )
    const headers = { ...upstream.headers }
    delete headers['content-length']
    delete headers['transfer-encoding']
    response.writeHead(
      upstream.statusCode ?? 502,
      securityHeaders({
        ...headers,
        'content-length': String(Buffer.byteLength(html))
      })
    )
    response.end(html)
  })
}

async function handleHumanCellEdit(
  request: IncomingMessage,
  response: ServerResponse,
  input: StartOfficePreviewGatewayInput,
  gate: OfficeHumanEditGate
): Promise<void> {
  if (!input.onHumanCellEdit) {
    respond(response, 403, 'Forbidden')
    request.resume()
    return
  }
  const access = input.humanEditAccess?.() ?? 'writable'
  if (access !== 'writable') {
    const code = access === 'read_only' ? 'document_read_only' : 'document_frozen'
    publishHumanEditRejection(input, code)
    respondJson(response, 423, { ok: false, code })
    request.resume()
    return
  }
  const pendingLimited = gate.atPendingLimit
  const release = gate.enter()
  if (!release) {
    const code = pendingLimited ? 'too_many_edits' : 'rate_limited'
    publishHumanEditRejection(input, code)
    respondJson(response, 429, {
      ok: false,
      code
    })
    request.resume()
    return
  }
  let serviceInvoked = false
  try {
    const parsed = parseOfficeHumanCellEditBody(
      await readOfficePreviewRequestBody(request, OFFICE_HUMAN_EDIT_LIMITS.maxBodyBytes)
    )
    serviceInvoked = true
    await input.onHumanCellEdit({
      artifactId: input.artifactId,
      operationId: (input.humanEditId ?? randomUUID)(),
      ...parsed
    })
    respondJson(response, 200, { ok: true })
  } catch (error) {
    const requestError =
      error instanceof OfficeHumanEditRequestError || error instanceof OfficePreviewRequestError
    const failure = requestError
      ? {
          status: error.status,
          code:
            error instanceof OfficePreviewRequestError && error.status === 413
              ? 'payload_too_large'
              : error instanceof OfficeHumanEditRequestError
                ? error.code
                : 'edit_failed'
        }
      : humanEditErrorResponse(error)
    if (!serviceInvoked) publishHumanEditRejection(input, failure.code)
    respondJson(response, failure.status, {
      ok: false,
      code: failure.code
    })
  } finally {
    release()
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  gatewayPort: number,
  input: StartOfficePreviewGatewayInput,
  humanEditGate: OfficeHumanEditGate,
  control: OfficePreviewControlChannel
): Promise<void> {
  if (!validBrowserIdentity(request, gatewayPort)) {
    respond(response, 403, 'Forbidden')
    return
  }
  const path = requestPath(request)
  const method = request.method
  if (!path || !method || !officePreviewRouteAllowed(input.kind, method, path)) {
    respond(response, 403, 'Forbidden')
    request.resume()
    return
  }
  if (method === 'GET' && path === OFFICE_PREVIEW_CONTROL_PATH) {
    control.connect(
      response,
      securityHeaders({
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      }) as Readonly<Record<string, string>>
    )
    return
  }
  if (method === 'POST') {
    if (path === '/api/send' && !input.onHumanCellEdit) {
      respond(response, 403, 'Forbidden')
      request.resume()
      return
    }
    if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
      if (path === '/api/send') {
        publishHumanEditRejection(input, 'invalid_edit')
        respondJson(response, 415, { ok: false, code: 'invalid_edit' })
      } else respond(response, 415, 'Selection request must be JSON')
      request.resume()
      return
    }
    if (path === '/api/send') {
      await handleHumanCellEdit(request, response, input, humanEditGate)
      return
    }
    try {
      const body = parseOfficePreviewSelectionBody(await readOfficePreviewRequestBody(request))
      proxyRequest(request, response, path, input.upstreamPort, body)
    } catch (error) {
      respond(
        response,
        error instanceof OfficePreviewRequestError ? error.status : 400,
        'Invalid selection request'
      )
    }
    return
  }
  proxyRequest(
    request,
    response,
    path,
    input.upstreamPort,
    undefined,
    input.onSelection,
    input.onCellPatch,
    input.onFullRefresh,
    input.onDocumentPatch,
    input.onPresentationChange,
    () =>
      input.kind === undefined || input.kind === 'xlsx'
        ? input.onHumanCellEdit
          ? (input.humanEditAccess?.() ?? 'writable')
          : 'read_only'
        : 'read_only',
    input.kind === 'pptx'
      ? MAX_PPTX_PREVIEW_HTML_BYTES
      : input.kind === undefined || input.kind === 'xlsx'
        ? MAX_XLSX_PREVIEW_HTML_BYTES
        : MAX_PREVIEW_HTML_BYTES,
    input.kind === undefined || input.kind === 'xlsx'
  )
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('Gateway port unavailable'))
      else resolve(address.port)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close((error) => (error ? reject(error) : resolve()))
    server.closeAllConnections()
  })
}

export async function startOfficePreviewGateway(
  input: StartOfficePreviewGatewayInput
): Promise<OfficePreviewGateway> {
  let port = 0
  const humanEditGate = new OfficeHumanEditGate(input.humanEditClock)
  const control = new OfficePreviewControlChannel(input.kind === undefined || input.kind === 'xlsx')
  const server = createServer((request, response) => {
    void handleRequest(request, response, port, input, humanEditGate, control)
  })
  port = await listen(server)
  return {
    artifactId: input.artifactId,
    port,
    url: `http://${LOOPBACK_HOST}:${port}/`,
    publishHighlight: (target, follow) => control.publish(target, follow),
    close: () => {
      control.close()
      return closeServer(server)
    }
  }
}
