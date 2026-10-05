import assert from 'node:assert/strict'
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
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { Browser, Page } from 'puppeteer-core'

import { officeCliEnv, runOfficeCli } from '../../src/main/agent/office/office-driver'
import {
  cleanOfficeProcesses,
  closeNormally,
  electronPath,
  environment,
  launch,
  readyTimeoutMs,
  repoRoot,
  stopChild,
  waitUntil,
  type RunningApp,
  type SmokePaths
} from './smoke-app-pptx-runtime'
import { exerciseOfficeSaveAndSaveAs } from './smoke-app-save'
import { officeGuest } from './smoke-app-selection'

const officeBinaryPath = join(
  repoRoot,
  'resources',
  'office',
  'officecli',
  `${process.platform}-${process.arch}`,
  'officecli'
)
const initialSlideTitle = 'PPTX 实机冒烟：初始中文标题'
const slideTitle = 'PPTX 实机冒烟：更新后的中文标题'
const slideText = 'PPTX 实机冒烟：中文正文 & <实时预览>'

interface SmokeApi {
  createProject(name: string, workingDirectory: string, permissionMode: 'auto'): Promise<unknown>
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

async function startProjectChat(page: Page, projectDir: string): Promise<string> {
  await page.evaluate(async (cwd) => {
    await (window as unknown as { api: SmokeApi }).api.createProject('PPTX Smoke', cwd, 'auto')
  }, projectDir)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[aria-label="项目"]', { visible: true })
  await page.click('[aria-label="项目"]')
  await waitUntil('临时项目出现在侧栏', () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).some((element) =>
        element.textContent?.includes('PPTX Smoke')
      )
    )
  )
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (element) => element.textContent?.includes('PPTX Smoke')
    )
    const actions = row?.querySelectorAll<HTMLButtonElement>('button')
    const newChat = actions?.item((actions?.length ?? 0) - 1)
    if (!newChat) throw new Error('找不到项目的新对话动作')
    newChat.click()
  })
  await page.waitForSelector('[data-phi-focus="chat-input"]', { visible: true })
  const sessionId = await waitUntil('PPTX smoke 会话建立', async () => {
    const id = await page.evaluate(async (cwd) => {
      const api = (window as unknown as { api: SmokeApi }).api
      return (await api.listProjectSessions(cwd))[0]?.phiSessionId ?? ''
    }, projectDir)
    return id || null
  })
  assert.ok(sessionId, '新建 PPTX smoke 会话缺少 phiSessionId')
  return sessionId
}

async function restoreProjectSession(page: Page, projectDir: string): Promise<void> {
  await page.evaluate(async (cwd) => {
    const api = (window as unknown as { api: SmokeApi }).api
    const session = (await api.listProjectSessions(cwd))[0]
    if (!session) throw new Error('重启后找不到 PPTX smoke 会话')
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

async function assertEmptyPresentation(page: Page): Promise<void> {
  await page.waitForSelector('[data-phi-office-empty-preview="pptx"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  const emptyText = await page.$eval(
    '[data-phi-office-empty-preview="pptx"]',
    (element) => element.textContent?.trim() ?? ''
  )
  assert.equal(emptyText, '暂无幻灯片')
  assert.equal(
    await page.$eval('[data-phi-office-webview="true"]', (element) =>
      element.getAttribute('aria-hidden')
    ),
    'true',
    '零页 PPTX 的真实 watch 页面必须保持隐藏'
  )
}

async function createBlankPptx(page: Page, officeRoot: string): Promise<ArtifactRecord> {
  const knownIds = new Set(artifacts(officeRoot).map((artifact) => artifact.artifactId))
  await page.click('[data-phi-office-create-kind="pptx"]')
  await page.waitForSelector('[data-phi-office-create-dialog="true"]', { visible: true })
  await page.type('[data-phi-office-create-name="true"]', 'PPTX 实机草稿')
  await page.click('[data-phi-office-create-submit="true"]')
  await page.waitForSelector('[data-phi-office-state="ready"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  await page.waitForFunction(() => document.body.innerText.includes('只读实时预览'), {
    timeout: readyTimeoutMs
  })
  await assertEmptyPresentation(page)
  const artifact = await waitUntil('PPTX 草稿登记', () =>
    artifacts(officeRoot).find((candidate) => !knownIds.has(candidate.artifactId))
  )
  assert.equal(artifact.kind, 'pptx')
  assert.match(artifact.draftPath, /PPTX 实机草稿\.pptx$/u)
  return artifact
}

async function addSlide(paths: SmokePaths, draftPath: string): Promise<void> {
  const result = await runOfficeCli(
    officeBinaryPath,
    [
      'add',
      draftPath,
      '/',
      '--type',
      'slide',
      '--prop',
      'name=中文第一页',
      '--prop',
      `title=${initialSlideTitle}`,
      '--prop',
      `text=${slideText}`,
      '--json'
    ],
    {
      timeoutMs: 30_000,
      env: officeCliEnv(environment(paths), { OFFICECLI_RESIDENT_FLUSH: 'each' })
    }
  )
  assert.equal(result.exitCode, 0, `officecli add slide 失败：${result.stderr || result.stdout}`)
  const receipt = JSON.parse(result.stdout) as { success?: unknown; data?: unknown }
  assert.equal(receipt.success, true)
  assert.match(String(receipt.data), /Added slide at \/slide\[1\]/u)
}

async function readTitleElementPath(paths: SmokePaths, draftPath: string): Promise<string> {
  const result = await runOfficeCli(
    officeBinaryPath,
    ['get', draftPath, '/slide[1]', '--depth', '2', '--json'],
    {
      timeoutMs: 30_000,
      env: officeCliEnv(environment(paths), { OFFICECLI_RESIDENT_FLUSH: 'each' })
    }
  )
  assert.equal(result.exitCode, 0, `officecli get slide 失败：${result.stderr || result.stdout}`)
  const receipt = JSON.parse(result.stdout) as {
    success?: unknown
    data?: { results?: Array<{ children?: Array<{ path?: unknown; type?: unknown }> }> }
  }
  assert.equal(receipt.success, true)
  const title = receipt.data?.results?.[0]?.children?.find((element) => element.type === 'title')
  assert.match(String(title?.path), /^\/slide\[1\]\/shape\[@id=[1-9]\d*\]$/u)
  return String(title?.path)
}

async function setSlideTitle(paths: SmokePaths, draftPath: string): Promise<void> {
  const titlePath = await readTitleElementPath(paths, draftPath)
  const result = await runOfficeCli(
    officeBinaryPath,
    ['set', draftPath, titlePath, '--prop', `text=${slideTitle}`, '--json'],
    {
      timeoutMs: 30_000,
      env: officeCliEnv(environment(paths), { OFFICECLI_RESIDENT_FLUSH: 'each' })
    }
  )
  assert.equal(
    result.exitCode,
    0,
    `officecli set slide title 失败：${result.stderr || result.stdout}`
  )
  const receipt = JSON.parse(result.stdout) as { success?: unknown; data?: unknown }
  assert.equal(receipt.success, true)
  assert.ok(String(receipt.data).startsWith(`Updated ${titlePath}: text=`))
}

async function assertPresentationPreview(
  browser: Browser,
  page: Page,
  fileName: string,
  expectedTitle = slideTitle
): Promise<void> {
  await page.waitForSelector('[data-phi-office-webview="true"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  assert.equal(await page.$('[data-phi-office-empty-preview="pptx"]'), null)
  const guest = await officeGuest(browser, page)
  await guest.waitForSelector('.slide-container[data-slide="1"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  // The upstream page hides its thumbnail rail at narrow widths, so assert presence, not visibility.
  await guest.waitForSelector('.thumb[data-slide="1"]', { timeout: readyTimeoutMs })
  const preview = await guest.evaluate(() => ({
    counter: document.querySelector('.page-counter')?.textContent?.trim(),
    fileTitle: document.querySelector('h1.file-title')?.textContent?.trim(),
    sidebarTitle: document.querySelector('.sidebar-title')?.textContent?.trim(),
    slideText: document.querySelector('.slide-container[data-slide="1"]')?.textContent ?? ''
  }))
  assert.equal(preview.counter, '1 / 1')
  assert.equal(preview.fileTitle, fileName)
  assert.equal(preview.sidebarTitle, fileName)
  assert.ok(preview.slideText.includes(expectedTitle))
  assert.ok(preview.slideText.includes(slideText))
}

async function openProjectPptx(page: Page, fileName: string): Promise<void> {
  await page.click('[aria-label="文件"]')
  await page.waitForSelector('[aria-label="项目目录树"]', { visible: true })
  const selector = `[data-phi-file-kind="presentation"][title="${fileName}"]`
  await page.waitForSelector(selector, { visible: true, timeout: readyTimeoutMs })
  await page.click(selector)
  await delay(1_500)
  await page.click(selector, { count: 2, delay: 60 })
  await page.waitForSelector('[data-phi-office-state="ready"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  await page.waitForFunction(() => document.body.innerText.includes('只读实时预览'), {
    timeout: readyTimeoutMs
  })
}

async function firstLaunch(paths: SmokePaths, running: RunningApp[]): Promise<string> {
  const app = await launch(paths)
  running.push(app)
  const sessionId = await startProjectChat(app.page, paths.projectDir)
  const officeRoot = join(paths.agentDir, 'sessions', sessionId, 'artifacts', 'office')
  const blank = await createBlankPptx(app.page, officeRoot)
  await addSlide(paths, blank.draftPath)
  await assertPresentationPreview(
    app.browser,
    app.page,
    basename(blank.draftPath),
    initialSlideTitle
  )
  await setSlideTitle(paths, blank.draftPath)
  await assertPresentationPreview(app.browser, app.page, basename(blank.draftPath))
  const output = await exerciseOfficeSaveAndSaveAs(
    app.page,
    blank,
    paths.projectDir,
    paths.saveAsPath,
    paths.screenshotDir
  )
  assert.equal(output.outputPath, basename(paths.saveAsPath))
  await openProjectPptx(app.page, basename(paths.saveAsPath))
  await assertPresentationPreview(app.browser, app.page, basename(paths.saveAsPath))
  await waitUntil('另存 PPTX 登记为有源草稿', () =>
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
  await openProjectPptx(app.page, basename(paths.saveAsPath))
  await app.page.waitForSelector('[data-phi-office-restore-recovered="true"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  await assertPresentationPreview(app.browser, app.page, basename(paths.saveAsPath))
  await closeNormally(app)
}

function smokePaths(runtimeRoot: string): SmokePaths {
  return {
    homeDir: join(runtimeRoot, 'home'),
    agentDir: join(runtimeRoot, 'home', '.phi'),
    projectDir: join(runtimeRoot, 'project'),
    userDataDir: join(runtimeRoot, 'electron-user-data'),
    saveAsPath: join(runtimeRoot, 'project', 'pptx-smoke-output.pptx'),
    screenshotDir: join(runtimeRoot, 'screenshots')
  }
}

async function main(): Promise<void> {
  assert.ok(existsSync(join(repoRoot, 'out', 'main', 'index.mjs')), '请先构建 Electron 应用')
  assert.ok(existsSync(electronPath), 'Electron 可执行入口不存在')
  assert.ok(existsSync(officeBinaryPath), 'OfficeCLI 可执行入口不存在')
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'phi-office-pptx-app-smoke-'))
  const paths = smokePaths(runtimeRoot)
  for (const path of [paths.agentDir, paths.projectDir, paths.userDataDir, paths.screenshotDir]) {
    mkdirSync(path, { recursive: true })
  }
  writeFileSync(join(paths.agentDir, 'onboarding.json'), '{"onboarded":true}\n')
  const running: RunningApp[] = []
  try {
    const sessionId = await firstLaunch(paths, running)
    await secondLaunch(paths, sessionId, running)
    process.stdout.write(
      `OFFICE_APP_PPTX_SMOKE_RESULT ${JSON.stringify({ sessionId, slideCount: 1, restartCount: 2 })}\n`
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
      process.stderr.write('PPTX smoke：ps 不可用，已降级为按已知 Electron 进程清理。\n')
    }
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
