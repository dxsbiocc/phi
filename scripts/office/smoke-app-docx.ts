import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { connect, type Browser, type Page } from 'puppeteer-core'

import { officeCliEnv, runOfficeCli } from '../../src/main/agent/office/office-driver'
import { officeGuest } from './smoke-app-selection'
import { exerciseOfficeSaveAndSaveAs } from './smoke-app-save'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const electronPath = join(repoRoot, 'node_modules', '.bin', 'electron')
const officeBinaryPath = join(
  repoRoot,
  'resources',
  'office',
  'officecli',
  `${process.platform}-${process.arch}`,
  'officecli'
)
const readyTimeoutMs = 60_000
const initialParagraph = 'Phi DOCX 实机冒烟：初始中文段落 & <实时预览>'
const paragraph = 'Phi DOCX 实机冒烟：修改后的中文段落 & <实时预览>'
class FatalSmokeError extends Error {}

interface SmokeApi {
  createProject(name: string, workingDirectory: string, permissionMode: 'auto'): Promise<unknown>
  createProjectSession(workingDirectory: string, permissionMode: 'auto'): Promise<unknown>
  getCurrentSession(): Promise<{ phiSessionId?: string }>
  listProjectSessions(
    workingDirectory: string
  ): Promise<Array<{ path: string; phiSessionId?: string }>>
  switchSession(path: string): Promise<unknown>
}

interface ArtifactRecord {
  readonly artifactId: string
  readonly draftPath: string
  readonly kind?: string
  readonly sourcePath?: string | null
}

interface RunningApp {
  readonly browser: Browser
  readonly page: Page
  readonly child: ChildProcess
  readonly logs: () => string
}

function environment(homeDir: string, agentDir: string, saveAsPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    PHI_OFFICE_DEV: '1',
    PHI_OFFICE_SMOKE_SAVE_AS_PATH: saveAsPath
  }
  for (const key of [
    'PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'SHELL',
    'USER',
    'LOGNAME',
    'DISPLAY',
    'XDG_RUNTIME_DIR',
    'SSH_AUTH_SOCK'
  ]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

async function waitUntil<T>(
  label: string,
  probe: () => T | null | false | undefined | Promise<T | null | false | undefined>
): Promise<T> {
  const deadline = Date.now() + readyTimeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      if (error instanceof FatalSmokeError) throw error
      lastError = error
    }
    await delay(100)
  }
  const detail = lastError instanceof Error ? `：${lastError.message}` : ''
  throw new Error(`${label}超时${detail}`)
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

async function launch(paths: SmokePaths): Promise<RunningApp> {
  const port = await reservePort()
  const child = spawn(
    electronPath,
    ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${paths.userDataDir}`],
    {
      cwd: repoRoot,
      env: environment(paths.homeDir, paths.agentDir, paths.saveAsPath),
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
      throw new FatalSmokeError(
        `Electron 已退出 code=${String(child.exitCode)} signal=${child.signalCode}\n${output}`
      )
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

async function startProjectChat(page: Page, projectDir: string): Promise<string> {
  await page.evaluate(async (cwd) => {
    const api = (window as unknown as { api: SmokeApi }).api
    await api.createProject('DOCX Smoke', cwd, 'auto')
  }, projectDir)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[aria-label="项目"]', { visible: true })
  await page.click('[aria-label="项目"]')
  await waitUntil('临时项目出现在侧栏', () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).some((element) =>
        element.textContent?.includes('DOCX Smoke')
      )
    )
  )
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (element) => element.textContent?.includes('DOCX Smoke')
    )
    const actions = row?.querySelectorAll<HTMLButtonElement>('button')
    const newChat = actions?.item((actions?.length ?? 0) - 1)
    if (!newChat) throw new Error('找不到项目的新对话动作')
    newChat.click()
  })
  await page.waitForSelector('[data-phi-focus="chat-input"]', { visible: true })
  const sessionId = await waitUntil('DOCX smoke 会话建立', async () => {
    const id = await page.evaluate(async (cwd) => {
      const api = (window as unknown as { api: SmokeApi }).api
      return (await api.listProjectSessions(cwd))[0]?.phiSessionId ?? ''
    }, projectDir)
    return id || null
  })
  assert.ok(sessionId, '新建 DOCX smoke 会话缺少 phiSessionId')
  return sessionId
}

async function restoreProjectSession(page: Page, projectDir: string): Promise<void> {
  await page.evaluate(async (cwd) => {
    const api = (window as unknown as { api: SmokeApi }).api
    const session = (await api.listProjectSessions(cwd))[0]
    if (!session) throw new Error('重启后找不到 DOCX smoke 会话')
    await api.switchSession(session.path)
  }, projectDir)
  await page.reload({ waitUntil: 'domcontentloaded' })
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

async function createBlankDocx(page: Page, officeRoot: string): Promise<ArtifactRecord> {
  const knownIds = new Set(artifacts(officeRoot).map((artifact) => artifact.artifactId))
  await page.click('[data-phi-office-create-kind="docx"]')
  await page.waitForSelector('[data-phi-office-create-dialog="true"]', { visible: true })
  await page.type('[data-phi-office-create-name="true"]', 'DOCX 实机草稿')
  await page.click('[data-phi-office-create-submit="true"]')
  await page.waitForSelector('[data-phi-office-state="ready"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  await page.waitForFunction(() => document.body.innerText.includes('只读实时预览'), {
    timeout: readyTimeoutMs
  })
  const artifact = await waitUntil('DOCX 草稿登记', () =>
    artifacts(officeRoot).find((candidate) => !knownIds.has(candidate.artifactId))
  )
  assert.equal(artifact.kind, 'docx')
  assert.match(artifact.draftPath, /DOCX 实机草稿\.docx$/u)
  return artifact
}

async function assertBlankPage(browser: Browser, page: Page): Promise<Page> {
  const guest = await officeGuest(browser, page)
  await guest.waitForSelector('.page-body', { visible: true, timeout: readyTimeoutMs })
  const text = await guest.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.page-body'))
      .map((element) => element.innerText)
      .join('')
      .trim()
  )
  assert.equal(text, '', '空白 DOCX 预览出现了占位正文')
  return guest
}

async function addParagraph(paths: SmokePaths, draftPath: string): Promise<string> {
  const result = await runOfficeCli(
    officeBinaryPath,
    [
      'add',
      draftPath,
      '/body',
      '--type',
      'paragraph',
      '--prop',
      `text=${initialParagraph}`,
      '--json'
    ],
    {
      timeoutMs: 30_000,
      env: officeCliEnv(environment(paths.homeDir, paths.agentDir, paths.saveAsPath), {
        OFFICECLI_RESIDENT_FLUSH: 'each'
      })
    }
  )
  assert.equal(result.exitCode, 0, `officecli add 失败：${result.stderr || result.stdout}`)
  const receipt = JSON.parse(result.stdout) as { success?: unknown; data?: unknown }
  assert.equal(receipt.success, true)
  const match = /paraId=([0-9A-F]{8})/iu.exec(String(receipt.data))
  assert.ok(match, 'officecli add 未返回稳定 paraId')
  return match[1]!.toUpperCase()
}

async function setParagraph(paths: SmokePaths, draftPath: string, paraId: string): Promise<void> {
  const result = await runOfficeCli(
    officeBinaryPath,
    ['set', draftPath, `/body/p[@paraId=${paraId}]`, '--prop', `text=${paragraph}`, '--json'],
    {
      timeoutMs: 30_000,
      env: officeCliEnv(environment(paths.homeDir, paths.agentDir, paths.saveAsPath), {
        OFFICECLI_RESIDENT_FLUSH: 'each'
      })
    }
  )
  assert.equal(result.exitCode, 0, `officecli set 失败：${result.stderr || result.stdout}`)
  assert.equal((JSON.parse(result.stdout) as { success?: unknown }).success, true)
}

async function openProjectDocx(page: Page, fileName: string): Promise<void> {
  await page.click('[aria-label="文件"]')
  await page.waitForSelector('[aria-label="项目目录树"]', { visible: true })
  const selector = `[data-phi-file-kind="document"][title="${fileName}"]`
  await page.waitForSelector(selector, { visible: true, timeout: readyTimeoutMs })
  await page.click(selector)
  await delay(1_500)
  await page.click(selector, { count: 2, delay: 60 })
  await page.waitForSelector('[data-phi-office-state="ready"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
}

async function assertPreviewText(browser: Browser, page: Page): Promise<void> {
  const guest = await officeGuest(browser, page)
  await guest.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll<HTMLElement>('.page-body')).some((element) =>
        element.innerText.includes(expected)
      ),
    { timeout: readyTimeoutMs },
    paragraph
  )
}

async function closeNormally(app: RunningApp): Promise<void> {
  await app.browser.close().catch(() => undefined)
  const exited = await Promise.race([
    new Promise<boolean>((resolveExit) => app.child.once('exit', () => resolveExit(true))),
    delay(10_000).then(() => false)
  ])
  if (exited) return
  app.child.kill('SIGTERM')
  assert.equal(
    await Promise.race([
      new Promise<boolean>((resolveExit) => app.child.once('exit', () => resolveExit(true))),
      delay(10_000).then(() => false)
    ]),
    true,
    'SIGTERM 后 Electron 仍未退出'
  )
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

function officePidsForRoot(root: string): number[] | null {
  try {
    return execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes('officecli') && line.includes(root))
      .map((line) => Number(/^\s*(\d+)/u.exec(line)?.[1]))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  } catch {
    return null
  }
}

async function cleanOfficeProcesses(root: string): Promise<'verified' | 'ps_unavailable'> {
  const initial = officePidsForRoot(root)
  if (initial === null) return 'ps_unavailable'
  for (const pid of initial) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      continue
    }
  }
  await delay(250)
  for (const pid of officePidsForRoot(root) ?? []) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      continue
    }
  }
  assert.deepEqual(officePidsForRoot(root), [], '仍有 DOCX OfficeCLI 进程残留')
  return 'verified'
}

interface SmokePaths {
  readonly homeDir: string
  readonly agentDir: string
  readonly projectDir: string
  readonly userDataDir: string
  readonly saveAsPath: string
  readonly screenshotDir: string
}

async function firstLaunch(paths: SmokePaths, running: RunningApp[]): Promise<string> {
  const app = await launch(paths)
  running.push(app)
  const sessionId = await startProjectChat(app.page, paths.projectDir)
  const officeRoot = join(paths.agentDir, 'sessions', sessionId, 'artifacts', 'office')
  const blank = await createBlankDocx(app.page, officeRoot)
  const guest = await assertBlankPage(app.browser, app.page)
  const paraId = await addParagraph(paths, blank.draftPath)
  await guest.waitForFunction(
    (expected) => document.body.innerText.includes(expected),
    { timeout: readyTimeoutMs },
    initialParagraph
  )
  await setParagraph(paths, blank.draftPath, paraId)
  await guest.waitForFunction(
    (expected) => document.body.innerText.includes(expected),
    { timeout: readyTimeoutMs },
    paragraph
  )
  const output = await exerciseOfficeSaveAndSaveAs(
    app.page,
    blank,
    paths.projectDir,
    paths.saveAsPath,
    paths.screenshotDir
  )
  assert.equal(output.outputPath, basename(paths.saveAsPath))
  await openProjectDocx(app.page, basename(paths.saveAsPath))
  await assertPreviewText(app.browser, app.page)
  await waitUntil('另存 DOCX 登记为有源草稿', () =>
    artifacts(officeRoot).find((artifact) => artifact.sourcePath === realpathSync(paths.saveAsPath))
  )
  await closeNormally(app)
  return sessionId
}

async function secondLaunch(
  paths: SmokePaths,
  sessionId: string,
  running: RunningApp[]
): Promise<void> {
  const app = await launch(paths)
  running.push(app)
  await restoreProjectSession(app.page, paths.projectDir)
  const currentSessionId = await waitUntil('重启会话身份恢复', async () => {
    const current = await app.page.evaluate(async () =>
      (window as unknown as { api: SmokeApi }).api.getCurrentSession()
    )
    return current.phiSessionId || null
  })
  assert.equal(currentSessionId, sessionId)
  await openProjectDocx(app.page, basename(paths.saveAsPath))
  await app.page.waitForSelector('[data-phi-office-restore-recovered="true"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  await assertPreviewText(app.browser, app.page)
  await closeNormally(app)
}

async function main(): Promise<void> {
  assert.ok(existsSync(join(repoRoot, 'out', 'main', 'index.mjs')), '请先构建 Electron 应用')
  assert.ok(existsSync(electronPath), 'Electron 可执行入口不存在')
  assert.ok(existsSync(officeBinaryPath), 'OfficeCLI 可执行入口不存在')
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'phi-office-docx-app-smoke-'))
  const paths: SmokePaths = {
    homeDir: join(runtimeRoot, 'home'),
    agentDir: join(runtimeRoot, 'home', '.phi'),
    projectDir: join(runtimeRoot, 'project'),
    userDataDir: join(runtimeRoot, 'electron-user-data'),
    saveAsPath: join(runtimeRoot, 'project', 'docx-smoke-output.docx'),
    screenshotDir: join(runtimeRoot, 'screenshots')
  }
  mkdirSync(paths.agentDir, { recursive: true })
  mkdirSync(paths.projectDir, { recursive: true })
  mkdirSync(paths.userDataDir, { recursive: true })
  mkdirSync(paths.screenshotDir, { recursive: true })
  writeFileSync(join(paths.agentDir, 'onboarding.json'), '{"onboarded":true}\n')
  const running: RunningApp[] = []
  try {
    const sessionId = await firstLaunch(paths, running)
    await secondLaunch(paths, sessionId, running)
    process.stdout.write(
      `OFFICE_APP_DOCX_SMOKE_RESULT ${JSON.stringify({ sessionId, paragraph, restartCount: 2 })}\n`
    )
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
    const processCheck = await cleanOfficeProcesses(runtimeRoot).finally(() =>
      rmSync(runtimeRoot, { recursive: true, force: true })
    )
    if (processCheck === 'ps_unavailable') {
      process.stderr.write('DOCX smoke：ps 不可用，已降级为按已知 Electron 进程清理。\n')
    }
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
