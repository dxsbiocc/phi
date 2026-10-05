import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { connect, type Browser, type Page } from 'puppeteer-core'

import { officeGuest } from './smoke-app-selection'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const fixturePath = join(repoRoot, 'tests', 'fixtures', 'office', 'sample.xlsx')
const electronPath = join(repoRoot, 'node_modules', '.bin', 'electron')
const READY_TIMEOUT_MS = 60_000

interface SmokeApi {
  createProject(name: string, workingDirectory: string, permissionMode: 'auto'): Promise<unknown>
  createProjectSession(workingDirectory: string, permissionMode: 'auto'): Promise<unknown>
  listProjectSessions(
    workingDirectory: string
  ): Promise<Array<{ path: string; phiSessionId?: string }>>
  switchSession(path: string): Promise<unknown>
  closeWindow(): Promise<void>
  office: {
    create(input: { requestId: string; name: string }): Promise<Record<string, unknown>>
    open(input: { sourcePath: string }): Promise<Record<string, unknown>>
    close(input: { artifactId: string; sessionId: string }): Promise<Record<string, unknown>>
  }
}

interface ArtifactRecord {
  readonly artifactId: string
  readonly draftPath: string
}

interface RunningApp {
  readonly browser: Browser
  readonly page: Page
  readonly child: ChildProcess
  readonly logs: () => string
}

function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('无法分配 CDP 端口'))
        return
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)))
    })
  })
}

function environment(homeDir: string, agentDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    PHI_OFFICE_DEV: '1'
  }
  for (const key of ['PATH', 'TMPDIR', 'LANG', 'SHELL', 'USER', 'LOGNAME', 'DISPLAY']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

async function waitUntil<T>(
  label: string,
  probe: () => T | null | false | Promise<T | null | false>
): Promise<T> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  const detail = lastError instanceof Error ? `：${lastError.message}` : ''
  throw new Error(`${label}超时${detail}`)
}

async function launch(homeDir: string, agentDir: string, userDataDir: string): Promise<RunningApp> {
  const port = await reservePort()
  const child = spawn(
    electronPath,
    ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`],
    {
      cwd: repoRoot,
      env: environment(homeDir, agentDir),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let output = ''
  const collect = (chunk: Buffer): void => {
    output = `${output}${chunk.toString('utf8')}`.slice(-20_000)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  const browser = await waitUntil('Electron CDP 启动', async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Electron 已退出 code=${String(child.exitCode)} signal=${child.signalCode}`)
    }
    return connect({ browserURL: `http://127.0.0.1:${port}` }).catch(() => null)
  })
  const page = await waitUntil('Phi renderer 页面', async () => {
    const pages = await browser.pages()
    return pages.find((candidate) => candidate.url() !== 'about:blank') ?? null
  })
  await page.setViewport({ width: 1500, height: 950 })
  return { browser, page, child, logs: () => output }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await delay(500)
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return Promise.race([
    new Promise<boolean>((resolveExit) => child.once('exit', () => resolveExit(true))),
    delay(timeoutMs).then(() => false)
  ])
}

// Closing the window does not quit the app on macOS, so ask the browser to close (a normal
// quit that runs the main-process cleanup) and fall back to SIGTERM if that is ignored.
async function closeNormally(app: RunningApp): Promise<void> {
  await app.browser.close().catch(() => undefined)
  let exited = await waitForExit(app.child, 10_000)
  if (!exited) {
    app.child.kill('SIGTERM')
    exited = await waitForExit(app.child, 10_000)
  }
  assert.equal(exited, true, '退出应用后 Electron 进程仍然存在')
}

async function selectSession(page: Page, projectDir: string, create: boolean): Promise<string> {
  const sessionId = await page.evaluate(
    async ({ cwd, shouldCreate }) => {
      const api = (window as unknown as { api: SmokeApi }).api
      if (shouldCreate) {
        await api.createProject('Office Restart Smoke', cwd, 'auto')
        await api.createProjectSession(cwd, 'auto')
      } else {
        const sessions = await api.listProjectSessions(cwd)
        const session = sessions[0]
        if (!session) throw new Error('重启后找不到项目会话')
        await api.switchSession(session.path)
      }
      const sessions = await api.listProjectSessions(cwd)
      return sessions[0]?.phiSessionId ?? ''
    },
    { cwd: projectDir, shouldCreate: create }
  )
  assert.ok(sessionId, '项目会话缺少 phiSessionId')
  await page.reload({ waitUntil: 'domcontentloaded' })
  return sessionId
}

async function openSource(page: Page): Promise<void> {
  await page.click('[aria-label="文件"]')
  await page.waitForSelector('[aria-label="项目目录树"]', { visible: true })
  // The file tree selects on the first click and opens on a double click.
  const sampleRow = '[data-phi-file-kind="spreadsheet"][title="sample.xlsx"]'
  await page.click(sampleRow)
  // The first click loads a preview asynchronously; a double click before that settles is ignored.
  await delay(1_500)
  await page.click(sampleRow, { count: 2, delay: 60 })
  await page.waitForSelector('[data-phi-office-state="ready"]', {
    visible: true,
    timeout: READY_TIMEOUT_MS
  })
  await page.waitForSelector('[data-phi-office-webview="true"]', {
    visible: true,
    timeout: READY_TIMEOUT_MS
  })
}

function artifacts(officeRoot: string): ArtifactRecord[] {
  if (!existsSync(officeRoot)) return []
  return readdirSync(officeRoot, { withFileTypes: true }).flatMap((entry) => {
    const metadata = join(officeRoot, entry.name, 'artifact.json')
    return entry.isDirectory() && existsSync(metadata)
      ? [JSON.parse(readFileSync(metadata, 'utf8')) as ArtifactRecord]
      : []
  })
}

function revision(draftPath: string): number {
  const value = JSON.parse(readFileSync(join(dirname(draftPath), 'operations.json'), 'utf8')) as {
    contentRevision?: number
  }
  return value.contentRevision ?? 0
}

async function verifyResourceReclaim(page: Page, officeRoot: string): Promise<void> {
  const result = await page.evaluate(async () => {
    const office = (window as unknown as { api: SmokeApi }).api.office
    // The renderer-safe document hides `draftPath`; for a blank draft `sourcePath` is that path.
    const documents: Array<{ artifactId: string; sessionId: string; sourcePath: string }> = []
    for (let index = 1; index <= 4; index += 1) {
      const response = (await office.create({
        requestId: `resource-smoke-${index}`,
        name: `资源回收 ${index}`
      })) as { ok?: boolean; value?: { state?: string; document?: (typeof documents)[number] } }
      if (!response.ok || response.value?.state !== 'ready' || !response.value.document) {
        throw new Error(`第 ${index} 份资源草稿创建失败`)
      }
      documents.push(response.value.document)
    }
    const reopened = (await office.open({ sourcePath: documents[0]!.sourcePath })) as {
      ok?: boolean
      value?: { state?: string; document?: { artifactId?: string } }
    }
    if (
      !reopened.ok ||
      reopened.value?.state !== 'ready' ||
      reopened.value.document?.artifactId !== documents[0]!.artifactId
    ) {
      throw new Error('被回收草稿没有以原 artifactId 恢复')
    }
    await office.close({
      artifactId: documents[0]!.artifactId,
      sessionId: documents[0]!.sessionId
    })
    return { artifactIds: documents.map((document) => document.artifactId) }
  })
  assert.equal(result.artifactIds.length, 4)
  assert.equal(new Set(result.artifactIds).size, 4)
  assert.equal(artifacts(officeRoot).length, 5, 'LRU 回收不应删除登记草稿')
  const processes = execFileSync('/bin/ps', ['-ax', '-o', 'command='], { encoding: 'utf8' })
    .split('\n')
    .filter(
      (command) =>
        command.includes(officeRoot) &&
        (command.includes('__resident-serve__') || command.includes(' watch '))
    )
  assert.ok(processes.length <= 6, `Office 进程超过 3 × 2 上限：${processes.length}`)
}

async function editCell(page: Page, browser: Browser, value: string): Promise<void> {
  const guest = await officeGuest(browser, page)
  const selector = 'td[data-path="/Sheet1/A2"]'
  const cell = await guest.waitForSelector(selector, { visible: true, timeout: READY_TIMEOUT_MS })
  assert.ok(cell)
  await cell.click({ count: 2, delay: 40 })
  const input = await guest.waitForSelector(`${selector} input`, {
    visible: true,
    timeout: READY_TIMEOUT_MS
  })
  assert.ok(input)
  await input.click({ count: 3 })
  await guest.keyboard.press('Backspace')
  await guest.keyboard.type(value)
  await guest.keyboard.press('Enter')
  await page.waitForSelector('[data-phi-office-save-state="saved"]', {
    visible: true,
    timeout: READY_TIMEOUT_MS
  })
}

async function guestCellText(page: Page, browser: Browser): Promise<string> {
  const guest = await officeGuest(browser, page)
  await guest.waitForSelector('td[data-path="/Sheet1/A2"]', {
    visible: true,
    timeout: READY_TIMEOUT_MS
  })
  return guest.$eval('td[data-path="/Sheet1/A2"]', (cell) => cell.textContent?.trim() ?? '')
}

async function assertFrozenWriteRejected(page: Page, browser: Browser): Promise<void> {
  const guest = await officeGuest(browser, page)
  const status = await guest.evaluate(async () => {
    const response = await fetch('/api/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/Sheet1/A2', prop: 'text', value: '不得写入' })
    })
    return response.status
  })
  assert.equal(status, 423, '冻结草稿仍接受了人工写入')
}

interface RestartSmokePaths {
  readonly homeDir: string
  readonly agentDir: string
  readonly projectDir: string
  readonly userDataDir: string
}

interface FirstLaunchResult {
  readonly sessionId: string
  readonly artifact: ArtifactRecord
  readonly revision: number
  readonly officeRoot: string
}

async function firstLaunch(
  paths: RestartSmokePaths,
  running: RunningApp[]
): Promise<FirstLaunchResult> {
  const app = await launch(paths.homeDir, paths.agentDir, paths.userDataDir)
  running.push(app)
  const sessionId = await selectSession(app.page, paths.projectDir, true)
  const officeRoot = join(paths.agentDir, 'sessions', sessionId, 'artifacts', 'office')
  await openSource(app.page)
  await editCell(app.page, app.browser, '重启恢复值')
  const artifact = await waitUntil('首次草稿登记', () => artifacts(officeRoot)[0] ?? null)
  await waitUntil('首次写入 revision', () => (revision(artifact.draftPath) > 0 ? true : null))
  const restoredRevision = revision(artifact.draftPath)
  assert.equal(artifacts(officeRoot).length, 1)
  await closeNormally(app)
  return { sessionId, artifact, revision: restoredRevision, officeRoot }
}

async function secondLaunch(
  paths: RestartSmokePaths,
  first: FirstLaunchResult,
  running: RunningApp[]
): Promise<void> {
  const app = await launch(paths.homeDir, paths.agentDir, paths.userDataDir)
  running.push(app)
  assert.equal(await selectSession(app.page, paths.projectDir, false), first.sessionId)
  await openSource(app.page)
  await app.page.waitForSelector('[data-phi-office-restore-recovered="true"]', {
    visible: true,
    timeout: READY_TIMEOUT_MS
  })
  assert.equal(await guestCellText(app.page, app.browser), '重启恢复值')
  assert.equal(revision(first.artifact.draftPath), first.revision)
  assert.equal(artifacts(first.officeRoot).length, 1, '重启恢复错误地创建了第二份草稿')
  await verifyResourceReclaim(app.page, first.officeRoot)
  await closeNormally(app)
}

async function thirdLaunch(
  paths: RestartSmokePaths,
  first: FirstLaunchResult,
  running: RunningApp[]
): Promise<void> {
  appendFileSync(first.artifact.draftPath, Buffer.from('phi-smoke-tamper'))
  const app = await launch(paths.homeDir, paths.agentDir, paths.userDataDir)
  running.push(app)
  assert.equal(await selectSession(app.page, paths.projectDir, false), first.sessionId)
  await openSource(app.page)
  await app.page.waitForSelector('[data-phi-office-restore-error="draft_hash_mismatch"]', {
    visible: true,
    timeout: READY_TIMEOUT_MS
  })
  assert.equal(await guestCellText(app.page, app.browser), '重启恢复值')
  await assertFrozenWriteRejected(app.page, app.browser)
  assert.equal(artifacts(first.officeRoot).length, 5)
  process.stdout.write(
    `OFFICE_APP_RESTART_SMOKE_RESULT ${JSON.stringify({
      sessionId: first.sessionId,
      artifactId: first.artifact.artifactId,
      restoredRevision: first.revision,
      restartCount: 3,
      hashMismatchRejectedWrite: true
    })}\n`
  )
  await closeNormally(app)
}

async function main(): Promise<void> {
  assert.ok(existsSync(join(repoRoot, 'out', 'main', 'index.mjs')), '请先构建 Electron 应用')
  assert.ok(existsSync(electronPath), 'Electron 可执行入口不存在')
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'phi-office-restart-smoke-'))
  const homeDir = join(runtimeRoot, 'home')
  const agentDir = join(homeDir, '.phi')
  const projectDir = join(runtimeRoot, 'project')
  const userDataDir = join(runtimeRoot, 'electron-user-data')
  const sourcePath = join(projectDir, basename(fixturePath))
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(agentDir, 'onboarding.json'), '{"onboarded":true}\n')
  copyFileSync(fixturePath, sourcePath)
  const running: RunningApp[] = []
  try {
    const paths = { homeDir, agentDir, projectDir, userDataDir }
    const first = await firstLaunch(paths, running)
    await secondLaunch(paths, first, running)
    await thirdLaunch(paths, first, running)
  } catch (error) {
    const logs = running
      .map((app) => app.logs().trim())
      .filter(Boolean)
      .join('\n')
    if (logs) process.stderr.write(`Electron 输出（末尾）：\n${logs}\n`)
    throw error
  } finally {
    for (const app of running) {
      app.browser.disconnect()
      await stopChild(app.child)
    }
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
