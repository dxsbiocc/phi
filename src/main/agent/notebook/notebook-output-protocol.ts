import { randomUUID } from 'node:crypto'
import { ipcMain, protocol } from 'electron'
import {
  NOTEBOOK_OUTPUT_CSP,
  NOTEBOOK_OUTPUT_SCHEME,
  notebookOutputFrameId,
  notebookOutputFrameUrl
} from '../../../shared/notebookOutputFrame'

const MAX_OUTPUT_FRAMES = 48
const MAX_OUTPUT_HTML_CHARS = 12_000_000

const frames = new Map<string, string>()

export function registerNotebookOutputScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: NOTEBOOK_OUTPUT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

function rememberFrame(id: string, html: string): void {
  frames.delete(id)
  frames.set(id, html)
  while (frames.size > MAX_OUTPUT_FRAMES) {
    const oldest = frames.keys().next().value
    if (!oldest) break
    frames.delete(oldest)
  }
}

export function installNotebookOutputProtocol(): void {
  protocol.handle(NOTEBOOK_OUTPUT_SCHEME, (request) => {
    const id = notebookOutputFrameId(request.url)
    const html = id ? frames.get(id) : undefined
    if (!html) {
      return new Response('Notebook output is no longer available.', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' }
      })
    }
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': NOTEBOOK_OUTPUT_CSP,
        'cache-control': 'no-store'
      }
    })
  })

  ipcMain.handle('analysis:publishNotebookOutputFrame', (_event, html: unknown) => {
    if (typeof html !== 'string' || html.length === 0 || html.length > MAX_OUTPUT_HTML_CHARS) {
      throw new Error('Notebook output frame is empty or too large.')
    }
    const id = randomUUID()
    rememberFrame(id, html)
    return notebookOutputFrameUrl(id)
  })

  ipcMain.handle('analysis:releaseNotebookOutputFrame', (_event, url: unknown) => {
    const id = typeof url === 'string' ? notebookOutputFrameId(url) : null
    if (id) frames.delete(id)
  })
}
