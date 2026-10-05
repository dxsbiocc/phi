import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app, BrowserWindow, type WebContents } from 'electron'

import { officeCliEnv, runOfficeCli } from '../../src/main/agent/office/office-driver'
import { createOfficeService } from '../../src/main/agent/office/office-service'
import { installOfficeWebviewSecurity } from '../../src/main/agent/office/office-webview'
import { createPhiSession } from '../../src/main/agent/session/session-store'

const sourcePath = requiredEnv('PHI_OFFICE_SMOKE_SOURCE')
const binaryPath = requiredEnv('PHI_OFFICE_SMOKE_BINARY')
const screenshotDir = requiredEnv('PHI_OFFICE_SMOKE_SCREENSHOTS')
const workDir = requiredEnv('PHI_OFFICE_SMOKE_WORKDIR')

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function statusFailure(status: { state: string; code?: string; message?: string }): Error {
  return new Error(
    status.state === 'error'
      ? `${status.code ?? 'error'}: ${status.message ?? 'Office preview failed'}`
      : `Unexpected Office state: ${status.state}`
  )
}

function rssKb(pid: number): number | null {
  try {
    const value = execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf8'
    }).trim()
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

function lsof(...args: string[]): string {
  try {
    return execFileSync('/usr/sbin/lsof', args, { encoding: 'utf8' })
  } catch {
    return ''
  }
}

function parentHtml(previewUrl: string): string {
  const escaped = previewUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  return `<!doctype html><html><body style="margin:0"><webview id="office" src="${escaped}" partition="phi-office-preview" webpreferences="sandbox=yes,contextIsolation=yes,nodeIntegration=no" style="display:flex;width:100vw;height:100vh"></webview></body></html>`
}

const GUEST_READY_TIMEOUT_MS = 20_000

async function guestHasWorkbook(guest: WebContents): Promise<boolean> {
  if (guest.isDestroyed()) throw new Error('Office webview was destroyed during attach')
  try {
    return (await guest.executeJavaScript(`!!document.querySelector('td[data-path]')`)) === true
  } catch {
    return false
  }
}

// Poll for rendered content instead of waiting for a single load event, which can be missed
// when the guest finishes loading before the listener is registered.
async function attachGuest(window: BrowserWindow, previewUrl: string): Promise<WebContents> {
  const attached = new Promise<WebContents>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Office webview never attached')),
      GUEST_READY_TIMEOUT_MS
    )
    window.webContents.once('did-attach-webview', (_event, guest) => {
      clearTimeout(timer)
      resolve(guest)
    })
  })
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(parentHtml(previewUrl))}`)
  const guest = await attached
  const started = Date.now()
  while (!(await guestHasWorkbook(guest))) {
    if (Date.now() - started > GUEST_READY_TIMEOUT_MS) {
      throw new Error(`Office webview showed no workbook within ${GUEST_READY_TIMEOUT_MS} ms`)
    }
    await delay(50)
  }
  return guest
}

async function assertExternalNavigationBlocked(
  guest: WebContents,
  previewUrl: string
): Promise<void> {
  const target = 'https://example.com/phi-office-smoke'
  const navigation = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('external navigation event missing')), 5_000)
    guest.once('will-navigate', (event, url) => {
      clearTimeout(timer)
      if (url !== target) {
        reject(new Error(`unexpected navigation target: ${url}`))
        return
      }
      if (!event.defaultPrevented) {
        reject(new Error('external navigation was not blocked'))
        return
      }
      resolve()
    })
  })
  await guest.executeJavaScript(`location.assign(${JSON.stringify(target)})`)
  await navigation
  if (guest.isDestroyed()) throw new Error('Office webview was destroyed after blocked navigation')
  if (new URL(guest.getURL()).origin !== new URL(previewUrl).origin) {
    throw new Error(`Office webview escaped its gateway: ${guest.getURL()}`)
  }
}

async function waitForCell(guest: WebContents, path: string, expected: string): Promise<number> {
  const started = Date.now()
  while (Date.now() - started < 5_000) {
    const text = await guest.executeJavaScript(
      `(document.querySelector(${JSON.stringify(`td[data-path="${path}"]`)})||{}).textContent`
    )
    if (text === expected) return Date.now() - started
    await delay(25)
  }
  throw new Error(`Cell ${path} did not become ${expected}`)
}

async function createLargeWorkbook(path: string): Promise<void> {
  const csvPath = join(workDir, 'large.csv')
  const rows = Array.from({ length: 1_000 }, (_, row) =>
    Array.from({ length: 10 }, (_, column) => `${row + 1}-${column + 1}`).join(',')
  ).join('\n')
  writeFileSync(csvPath, rows)
  const env = officeCliEnv(process.env, { OFFICECLI_RESIDENT_FLUSH: 'each' })
  await runOfficeCli(binaryPath, ['create', path, '--json'], { env })
  await runOfficeCli(binaryPath, ['import', path, '/Sheet1', csvPath, '--json'], { env })
  await runOfficeCli(binaryPath, ['close', path, '--json'], { env })
}

type OfficeService = ReturnType<typeof createOfficeService>
type OpenRequest = Parameters<OfficeService['open']>[0]
type ReadyDocument = Extract<
  Awaited<ReturnType<OfficeService['open']>>,
  { state: 'ready' }
>['document']

async function openReady(service: OfficeService, request: OpenRequest): Promise<ReadyDocument> {
  const opened = await service.open(request)
  if (opened.state !== 'ready') throw statusFailure(opened)
  return opened.document
}

async function inspectGuest(guest: WebContents): Promise<Record<string, string>> {
  const probe = (await guest.executeJavaScript(`({
    requireType: typeof require, processType: typeof process, phiType: typeof window.phi,
    body: document.body.innerText,
    formula: (document.querySelector('td[data-path="/Sheet1/B4"]')||{}).textContent
  })`)) as Record<string, string>
  if (
    [probe.requireType, probe.processType, probe.phiType].some((value) => value !== 'undefined')
  ) {
    throw new Error(`guest isolation failed: ${JSON.stringify(probe)}`)
  }
  if (!probe.body.includes('Sheet1') || probe.formula !== '30') {
    throw new Error(`workbook content missing: ${JSON.stringify(probe)}`)
  }
  return probe
}

function blockedAttempts(guest: WebContents, watchPort: number): Promise<unknown> {
  return guest.executeJavaScript(`Promise.all([
    fetch('/api/switch',{method:'POST',body:'{}'}).then(r=>r.status),
    fetch('http://127.0.0.1:${watchPort}/').then(r=>r.status).catch(()=> 'blocked-by-csp'),
    fetch('https://example.com/').then(r=>r.status).catch(()=> 'blocked-by-csp')
  ])`)
}

function assertBlockedAttempts(value: unknown): void {
  const expected = [403, 'blocked-by-csp', 'blocked-by-csp']
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`preview boundary failed: ${JSON.stringify(value)}`)
  }
}

async function mutateAndCapture(guest: WebContents, document: ReadyDocument): Promise<number> {
  writeFileSync(join(screenshotDir, 'before.png'), (await guest.capturePage()).toPNG())
  const started = performance.now()
  const changed = await runOfficeCli(
    binaryPath,
    ['set', document.draftPath, '/Sheet1/A1', '--prop', 'value=Smoke更新', '--json'],
    { env: officeCliEnv(process.env, { OFFICECLI_RESIDENT_FLUSH: 'each' }) }
  )
  if (changed.exitCode !== 0) throw new Error(`set failed: ${changed.stderr}`)
  await waitForCell(guest, '/Sheet1/A1', 'Smoke更新')
  writeFileSync(join(screenshotDir, 'after.png'), (await guest.capturePage()).toPNG())
  return Math.round(performance.now() - started)
}

async function measureLarge(service: OfficeService, request: OpenRequest): Promise<object> {
  const bigPath = join(workDir, 'large-1000x10.xlsx')
  await createLargeWorkbook(bigPath)
  const document = await openReady(service, {
    ...request,
    sourcePath: bigPath,
    allowRoots: [workDir]
  })
  await (await fetch(document.previewUrl)).text()
  await delay(500)
  const rss = { residentKb: rssKb(document.residentPid), watchKb: rssKb(document.watchPid) }
  await service.close(document.artifactId, document.sessionId)
  return rss
}

async function exercisePreview(
  service: OfficeService,
  window: BrowserWindow,
  request: OpenRequest
): Promise<Record<string, unknown>> {
  const coldStarted = performance.now()
  let document = await openReady(service, request)
  const guest = await attachGuest(window, document.previewUrl)
  const coldToFirstScreenMs = Math.round(performance.now() - coldStarted)
  const probe = await inspectGuest(guest)
  await assertExternalNavigationBlocked(guest, document.previewUrl)
  const blocked = await blockedAttempts(guest, document.watchPort)
  assertBlockedAttempts(blocked)
  const forgedSend = await fetch(`${document.previewUrl}api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/Sheet1/A1', props: { x: 1, y: 2 } })
  })
  if (forgedSend.status !== 400) {
    throw new Error(`preview send boundary failed: ${forgedSend.status}`)
  }
  const visibleAfterChangeMs = await mutateAndCapture(guest, document)
  const smallRss = { residentKb: rssKb(document.residentPid), watchKb: rssKb(document.watchPid) }
  const largeRss = await measureLarge(service, request)
  process.stderr.write('STEP large-done\n')
  guest.close()
  process.stderr.write('STEP guest-closed\n')
  await service.close(document.artifactId, document.sessionId)
  process.stderr.write('STEP service-closed\n')
  const hotStarted = performance.now()
  document = await openReady(service, request)
  const hotGuest = await attachGuest(window, document.previewUrl)
  const hotToFirstScreenMs = Math.round(performance.now() - hotStarted)
  hotGuest.close()
  return {
    coldToFirstScreenMs,
    hotToFirstScreenMs,
    visibleAfterChangeMs,
    isolation: probe,
    externalNavigationBlocked: true,
    blocked,
    smallRss,
    largeRss,
    ports: { watch: document.watchPort, gateway: document.gatewayPort },
    draftPath: document.draftPath
  }
}

async function main(): Promise<Record<string, unknown>> {
  mkdirSync(screenshotDir, { recursive: true })
  const originalHash = sha256(sourcePath)
  const session = createPhiSession({
    kind: 'ordinary',
    cwd: process.cwd(),
    cwdRealPath: process.cwd(),
    permissionMode: 'auto'
  })
  const service = createOfficeService()
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 760,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })
  installOfficeWebviewSecurity(window.webContents, (url) => service.ownsPreviewUrl(url))
  const request = {
    sessionId: session.sessionId,
    projectId: null,
    sourcePath,
    allowRoots: [process.cwd()]
  }
  try {
    const result = await exercisePreview(service, window, request)
    return { ...result, originalHashUnchanged: sha256(sourcePath) === originalHash, screenshotDir }
  } finally {
    await service.dispose()
    window.destroy()
  }
}

// Without a handler Electron shows a native error dialog and freezes the main process, which
// reads as a hang. Fail fast with the stack instead.
process.on('uncaughtException', (error) => {
  process.stderr.write(`${error.stack ?? String(error)}\n`)
  app.exit(1)
})

app.whenReady().then(async () => {
  let exitCode = 0
  try {
    const result = await main()
    const ports = result.ports as { watch: number; gateway: number }
    const draftPath = result.draftPath as string
    const cleanup = {
      watchListener: lsof('-nP', `-iTCP:${ports.watch}`, '-sTCP:LISTEN'),
      gatewayListener: lsof('-nP', `-iTCP:${ports.gateway}`, '-sTCP:LISTEN'),
      draftOwners: lsof('-t', '-a', '-c', 'officecli', '--', draftPath)
    }
    if (cleanup.watchListener || cleanup.gatewayListener || cleanup.draftOwners) {
      throw new Error(`cleanup failed: ${JSON.stringify(cleanup)}`)
    }
    process.stdout.write(`OFFICE_SMOKE_RESULT ${JSON.stringify({ ...result, cleanup })}\n`)
  } catch (error) {
    exitCode = 1
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  } finally {
    app.exit(exitCode)
  }
})
