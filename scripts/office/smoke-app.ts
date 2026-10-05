import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
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
import { basename, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { connect, type Browser, type Page } from 'puppeteer-core'
import { assertSendStoppedByReadiness, officeChipText } from './smoke-app-prompt'
import { exerciseOfficeSelection, seedSelectionCells } from './smoke-app-selection'
import { exerciseOfficeHumanEdit } from './smoke-app-human-edit'
import { exerciseOfficeSaveAndSaveAs } from './smoke-app-save'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const fixturePath = join(repoRoot, 'tests', 'fixtures', 'office', 'sample.xlsx')
const electronPath = join(repoRoot, 'node_modules', '.bin', 'electron')
const officeBinaryPath = join(
  repoRoot,
  'resources',
  'office',
  'officecli',
  `${process.platform}-${process.arch}`,
  'officecli'
)
const draftText = 'O03 split draft'
const appStartTimeoutMs = 30_000
const officeReadyTimeoutMs = 60_000

interface SmokeApi {
  createProject(name: string, workingDirectory: string, permissionMode: 'auto'): Promise<unknown>
  getCurrentSession(): Promise<{ phiSessionId?: string; cwd: string }>
  listProjectSessions(workingDirectory: string): Promise<unknown[]>
  closeWindow(): Promise<void>
  office: {
    status(input: { sourcePath: string }): Promise<{
      ok: boolean
      value?: { state: string } | null
    }>
  }
}

type WebviewElement = HTMLElement & {
  executeJavaScript<T>(code: string): Promise<T>
}

interface LayoutSnapshot {
  chatWidth: number
  artifactWidth: number
  separatorValue: number
}

interface OfficeArtifactRecord {
  artifactId: string
  draftPath: string
  origin?: string
}

interface OfficeBannerSnapshot {
  freeze: string | null
  save: string | null
  result: string | null
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function directorySnapshot(root: string): string[] {
  if (!existsSync(root)) return []
  const entries: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const name = relative(root, path)
      if (entry.isDirectory()) {
        entries.push(`directory:${name}`)
        visit(path)
      } else {
        entries.push(`file:${name}:${sha256(path)}`)
      }
    }
  }
  visit(root)
  return entries.sort()
}

function officeArtifacts(root: string): OfficeArtifactRecord[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const metadata = join(root, entry.name, 'artifact.json')
      if (!existsSync(metadata)) return []
      return [JSON.parse(readFileSync(metadata, 'utf8')) as OfficeArtifactRecord]
    })
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

async function waitUntil<T>(
  label: string,
  timeoutMs: number,
  probe: () => T | null | undefined | false | Promise<T | null | undefined | false>
): Promise<T> {
  const deadline = Date.now() + timeoutMs
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
  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`${label} 超时${detail}`)
}

function isolatedEnvironment(
  homeDir: string,
  agentDir: string,
  saveAsPath?: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    PHI_OFFICE_DEV: '1'
  }
  if (saveAsPath) env.PHI_OFFICE_SMOKE_SAVE_AS_PATH = saveAsPath
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

function startElectron(
  port: number,
  homeDir: string,
  agentDir: string,
  userDataDir: string,
  saveAsPath: string
): { child: ChildProcess; logs: () => string } {
  const child = spawn(
    electronPath,
    ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`],
    {
      cwd: repoRoot,
      env: isolatedEnvironment(homeDir, agentDir, saveAsPath),
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
  return { child, logs: () => output }
}

async function connectToApp(port: number, child: ChildProcess): Promise<Browser> {
  const deadline = Date.now() + appStartTimeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Electron 已退出 code=${String(child.exitCode)} signal=${child.signalCode}`)
    }
    try {
      return await connect({ browserURL: `http://127.0.0.1:${port}` })
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`Electron CDP 启动超时${detail}`)
}

async function findAppPage(browser: Browser): Promise<Page> {
  const page = await waitUntil('Phi renderer 页面', appStartTimeoutMs, async () => {
    const pages = await browser.pages()
    return pages.find((candidate) => candidate.url() !== 'about:blank') ?? null
  })
  await enlargeWindow(page)
  return page
}

// The default window is narrower than the split's combined minimum widths, which would make the
// divider a no-op; a roomy viewport is what a user resizing the panes actually has.
async function enlargeWindow(page: Page): Promise<void> {
  await page.setViewport({ width: 1500, height: 950 })
}

async function currentIdentity(
  page: Page,
  projectDir: string
): Promise<{
  phiSessionId: string
  sessionCount: number
}> {
  const value = await page.evaluate(async (cwd) => {
    const api = (window as unknown as { api: SmokeApi }).api
    const current = await api.getCurrentSession()
    const sessions = await api.listProjectSessions(cwd)
    return { phiSessionId: current.phiSessionId ?? '', sessionCount: sessions.length }
  }, projectDir)
  assert.ok(value.phiSessionId, '当前会话缺少 phiSessionId')
  return value
}

async function startProjectChatFromUi(page: Page, projectName: string): Promise<void> {
  await page.click('[aria-label="项目"]')
  await waitUntil('临时项目出现在侧栏', 10_000, () =>
    page.evaluate(
      (name) =>
        Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).some((element) =>
          element.textContent?.includes(name)
        ),
      projectName
    )
  )
  await page.evaluate((name) => {
    const row = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (element) => element.textContent?.includes(name)
    )
    const actions = row?.querySelectorAll<HTMLButtonElement>('button')
    const newChat = actions?.item((actions?.length ?? 0) - 1)
    if (!newChat) throw new Error('找不到项目的新对话动作')
    newChat.click()
  }, projectName)
  await page.waitForSelector('[data-phi-focus="chat-input"]', { visible: true })
}

async function officeContent(page: Page): Promise<{ body: string; formula: string }> {
  return page.evaluate(async () => {
    const webview = document.querySelector<WebviewElement>('[data-phi-office-webview="true"]')
    if (!webview) throw new Error('Office webview 不存在')
    return webview.executeJavaScript<{ body: string; formula: string }>(`({
      body: document.body.innerText,
      formula: (document.querySelector('td[data-path="/Sheet1/B4"]') || {}).textContent || ''
    })`)
  })
}

async function waitForOfficeContent(page: Page): Promise<{ body: string; formula: string }> {
  return waitUntil('Office 内容加载', officeReadyTimeoutMs, async () => {
    const content = await officeContent(page)
    return content.body.includes('Sheet1') && content.formula === '30' ? content : null
  })
}

async function officeBannerSnapshot(page: Page): Promise<OfficeBannerSnapshot> {
  return page.evaluate(() => ({
    freeze:
      document.querySelector<HTMLElement>('[data-phi-office-freeze-banner="true"]')?.innerText ??
      null,
    save:
      document.querySelector<HTMLElement>('[data-phi-office-save-banner="true"]')?.innerText ??
      null,
    result:
      document.querySelector<HTMLElement>('[data-phi-office-reconcile-result]')?.innerText ?? null
  }))
}

async function assertNormalOfficeBanners(page: Page): Promise<void> {
  assert.deepEqual(await officeBannerSnapshot(page), { freeze: null, save: null, result: null })
}

async function waitForBlankOfficeContent(
  page: Page,
  expectedTitle: string
): Promise<{ body: string; title: string; emptySurface: boolean; dataCellCount: number }> {
  return waitUntil('空白 Office 内容加载', officeReadyTimeoutMs, () =>
    page.evaluate(async (title) => {
      const webview = document.querySelector<WebviewElement>('[data-phi-office-webview="true"]')
      if (!webview) return null
      const content = await webview.executeJavaScript<{
        body: string
        title: string
        emptySurface: boolean
        dataCellCount: number
      }>(`({
        body: document.body.innerText,
        title: (document.querySelector('.file-title') || {}).textContent || '',
        emptySurface: document.querySelector('.empty-sheet') !== null,
        dataCellCount: document.querySelectorAll('td[data-path]').length
      })`)
      return content.body.includes('Sheet1') && content.title === title && content.emptySurface
        ? content
        : null
    }, expectedTitle)
  )
}

async function openCreateDialog(page: Page): Promise<void> {
  await page.click('[data-phi-office-create-button]')
  await page.waitForSelector('[data-phi-office-create-dialog]', { visible: true })
}

async function cancelCreateDialog(page: Page): Promise<void> {
  await page.click('[data-phi-office-create-cancel]')
  await page.waitForSelector('[data-phi-office-create-dialog]', { hidden: true })
}

async function createBlankWorkbook(page: Page, name: string): Promise<void> {
  await openCreateDialog(page)
  await page.type('[data-phi-office-create-name]', name)
  await page.click('[data-phi-office-create-submit]')
  await page.waitForSelector('[data-phi-office-create-dialog]', { hidden: true })
  await page.waitForSelector('[data-phi-office-state="ready"]', {
    visible: true,
    timeout: officeReadyTimeoutMs
  })
}

async function waitForNewArtifact(
  officeRoot: string,
  knownArtifactIds: ReadonlySet<string>
): Promise<OfficeArtifactRecord> {
  return waitUntil('新建 Office 产物登记', officeReadyTimeoutMs, () =>
    officeArtifacts(officeRoot).find((artifact) => !knownArtifactIds.has(artifact.artifactId))
  )
}

async function closeOfficeTab(page: Page, title: string, draftPath: string): Promise<void> {
  // The tab close control is not necessarily a <button>, so match on its accessible name only.
  await page.evaluate((label) => {
    const control = Array.from(document.querySelectorAll<HTMLElement>('[aria-label]')).find(
      (candidate) => candidate.getAttribute('aria-label') === label
    )
    if (!control) throw new Error(`找不到 ${label}`)
    control.click()
  }, `关闭 ${title}`)
  await waitUntil(`${title} Office 资源回收`, 10_000, async () => {
    const result = await page.evaluate(async (sourcePath) => {
      const api = (window as unknown as { api: SmokeApi }).api
      return api.office.status({ sourcePath })
    }, draftPath)
    return result.ok && result.value === null ? true : null
  })
}

async function layoutSnapshot(page: Page): Promise<LayoutSnapshot> {
  return page.evaluate(() => {
    const chat = document.querySelector<HTMLElement>('[data-phi-chat-artifact-pane="chat"]')
    const artifact = document.querySelector<HTMLElement>('[data-phi-chat-artifact-pane="artifact"]')
    const separator = document.querySelector<HTMLElement>(
      '[data-phi-chat-artifact-split="enabled"] > [role="separator"]'
    )
    if (!chat || !artifact || !separator) throw new Error('并排布局节点不完整')
    return {
      chatWidth: chat.getBoundingClientRect().width,
      artifactWidth: artifact.getBoundingClientRect().width,
      separatorValue: Number(separator.getAttribute('aria-valuenow'))
    }
  })
}

async function chatRootWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLElement>('[data-phi-focus="chat-input"]')
    let current = input?.parentElement ?? null
    while (current) {
      if (getComputedStyle(current).containerName.includes('phi-chat')) {
        return current.getBoundingClientRect().width
      }
      current = current.parentElement
    }
    throw new Error('找不到聊天根容器')
  })
}

async function primeChatScroll(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const input = document.querySelector<HTMLElement>('[data-phi-focus="chat-input"]')
    let chatRoot = input?.parentElement ?? null
    while (chatRoot && !getComputedStyle(chatRoot).containerName.includes('phi-chat')) {
      chatRoot = chatRoot.parentElement
    }
    const scrollContainer = Array.from(chatRoot?.querySelectorAll<HTMLElement>('div') ?? []).find(
      (element) => getComputedStyle(element).overflowY === 'auto'
    )
    const content = scrollContainer?.firstElementChild
    if (!scrollContainer || !(content instanceof HTMLElement) || content.classList.length === 0) {
      throw new Error('找不到聊天消息滚动容器')
    }
    const selector = Array.from(content.classList)
      .map((name) => `.${CSS.escape(name)}`)
      .join('')
    const style = document.createElement('style')
    style.id = 'phi-office-smoke-scroll-style'
    style.textContent = `${selector}{min-height:2400px!important}`
    document.head.append(style)
    await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()))
    scrollContainer.scrollTop = 320
    scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }))
    return scrollContainer.scrollTop
  })
}

async function chatScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLElement>('[data-phi-focus="chat-input"]')
    let chatRoot = input?.parentElement ?? null
    while (chatRoot && !getComputedStyle(chatRoot).containerName.includes('phi-chat')) {
      chatRoot = chatRoot.parentElement
    }
    const scrollContainer = Array.from(chatRoot?.querySelectorAll<HTMLElement>('div') ?? []).find(
      (element) => getComputedStyle(element).overflowY === 'auto'
    )
    if (!scrollContainer) throw new Error('找不到聊天消息滚动容器')
    return scrollContainer.scrollTop
  })
}

async function removeChatScrollFixture(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector('#phi-office-smoke-scroll-style')?.remove())
}

async function resizeWithMouse(
  page: Page
): Promise<{ before: LayoutSnapshot; after: LayoutSnapshot }> {
  const selector = '[data-phi-chat-artifact-split="enabled"] > [role="separator"]'
  const separator = await page.waitForSelector(selector, { visible: true })
  const box = await separator?.boundingBox()
  assert.ok(box, '分隔条没有可见区域')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const before = await layoutSnapshot(page)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await waitUntil('webview 拖拽遮罩', 2_000, () =>
    page.evaluate(() => {
      const split = document.querySelector('[data-phi-chat-artifact-split="enabled"]')
      const overlay = document.querySelector<HTMLElement>('[data-phi-webview-drag-overlay="true"]')
      return (
        split?.getAttribute('data-phi-chat-artifact-dragging') === 'true' &&
        overlay !== null &&
        getComputedStyle(overlay).display !== 'none'
      )
    })
  )
  await page.mouse.move(x + 100, y, { steps: 8 })
  await page.mouse.up()
  const after = await waitUntil('鼠标调整宽度', 8_000, async () => {
    const value = await layoutSnapshot(page)
    return value.chatWidth > before.chatWidth + 50 ? value : null
  })
  assert.ok(after.artifactWidth < before.artifactWidth - 50)
  return { before, after }
}

async function resizeWithKeyboard(page: Page): Promise<LayoutSnapshot> {
  const before = await layoutSnapshot(page)
  await page.focus('[data-phi-chat-artifact-split="enabled"] > [role="separator"]')
  await page.keyboard.press('ArrowLeft')
  return waitUntil('键盘调整宽度', 8_000, async () => {
    const value = await layoutSnapshot(page)
    return value.chatWidth < before.chatWidth && value.separatorValue < before.separatorValue
      ? value
      : null
  })
}

function officePidsForRoot(root: string): number[] {
  try {
    const output = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    return output
      .split('\n')
      .filter((line) => line.includes('officecli') && line.includes(root))
      .map((line) => Number(/^\s*(\d+)/.exec(line)?.[1]))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  const exited = await Promise.race([
    new Promise<boolean>((resolveExit) => child.once('exit', () => resolveExit(true))),
    delay(3_000).then(() => false)
  ])
  if (exited || !child.pid) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

async function cleanOfficeProcesses(root: string): Promise<void> {
  let pids = officePidsForRoot(root)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      continue
    }
  }
  await delay(250)
  pids = officePidsForRoot(root)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      continue
    }
  }
  assert.deepEqual(officePidsForRoot(root), [], '仍有 OfficeCLI 进程残留')
}

async function main(): Promise<void> {
  assert.ok(existsSync(join(repoRoot, 'out', 'main', 'index.mjs')), '请先构建 Electron 应用')
  assert.ok(existsSync(electronPath), 'Electron 可执行入口不存在')
  assert.ok(existsSync(officeBinaryPath), 'OfficeCLI 可执行入口不存在')
  assert.ok(existsSync(fixturePath), 'Office smoke 样例不存在')

  const runtimeRoot = mkdtempSync(join(tmpdir(), 'phi-office-app-smoke-'))
  const screenshotDir = mkdtempSync(join(tmpdir(), 'phi-office-app-shots-'))
  const homeDir = join(runtimeRoot, 'home')
  const agentDir = join(homeDir, '.phi')
  const projectDir = join(runtimeRoot, 'project')
  const userDataDir = join(runtimeRoot, 'electron-user-data')
  const sourcePath = join(projectDir, basename(fixturePath))
  const saveAsPath = join(projectDir, 'office-smoke-output.xlsx')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(agentDir, 'onboarding.json'), '{"onboarded":true}\n')
  copyFileSync(fixturePath, sourcePath)
  const sourceHash = sha256(sourcePath)

  let browser: Browser | null = null
  let page: Page | null = null
  let electron: ReturnType<typeof startElectron> | null = null
  let completed = false
  try {
    const port = await reservePort()
    electron = startElectron(port, homeDir, agentDir, userDataDir, saveAsPath)
    browser = await connectToApp(port, electron.child)
    page = await findAppPage(browser)

    await page.evaluate(async (cwd) => {
      const api = (window as unknown as { api: SmokeApi }).api
      await api.createProject('Office Smoke', cwd, 'auto')
    }, projectDir)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await startProjectChatFromUi(page, 'Office Smoke')
    const identity = await waitUntil('项目会话建立', 10_000, async () => {
      const value = await currentIdentity(page as Page, projectDir)
      return value.phiSessionId ? value : null
    })
    const officeRoot = join(agentDir, 'sessions', identity.phiSessionId, 'artifacts', 'office')

    await page.click('[aria-label="文件"]')
    await page.waitForSelector('[aria-label="项目目录树"]', { visible: true })
    // The file tree selects on the first click and opens on a double click.
    const sampleRow = '[data-phi-file-kind="spreadsheet"][title="sample.xlsx"]'
    await page.click(sampleRow)
    // The first click loads a preview asynchronously; a double click before that settles is ignored.
    await delay(1_500)
    await page.click(sampleRow, { count: 2, delay: 60 })
    await page.waitForSelector('[data-phi-chat-artifact-split="enabled"]', {
      visible: true,
      timeout: officeReadyTimeoutMs
    })
    await page.waitForSelector('[data-phi-office-state="ready"]', {
      visible: true,
      timeout: officeReadyTimeoutMs
    })
    const initialContent = await waitForOfficeContent(page)
    assert.equal(initialContent.formula, '30')
    await assertNormalOfficeBanners(page)
    const sampleArtifact = await waitUntil('样例 Office 产物登记', officeReadyTimeoutMs, () =>
      officeArtifacts(officeRoot).find((artifact) => artifact.draftPath.endsWith('sample.xlsx'))
    )
    await exerciseOfficeHumanEdit(
      browser,
      page,
      sampleArtifact,
      officeBinaryPath,
      isolatedEnvironment(homeDir, agentDir),
      screenshotDir
    )
    const savedOutput = await exerciseOfficeSaveAndSaveAs(
      page,
      sampleArtifact,
      projectDir,
      saveAsPath,
      screenshotDir
    )
    assert.equal(sha256(sourcePath), sourceHash, '人工编辑误改了项目源文件')
    await page.screenshot({ path: join(screenshotDir, '01-split-ready.png') })

    const input = await page.waitForSelector('[data-phi-focus="chat-input"]', { visible: true })
    assert.ok(input, '并排布局中聊天输入框不可见')
    await input.click()
    await page.keyboard.type(draftText)
    assert.equal(
      await page.$eval(
        '[data-phi-focus="chat-input"]',
        (element) => (element as HTMLTextAreaElement).value
      ),
      draftText
    )
    assert.equal(
      await page.$eval(
        '[data-phi-composer-action="send"]',
        (element) => (element as HTMLButtonElement).disabled
      ),
      false,
      '并排布局中发送动作不可用'
    )
    assert.deepEqual(await currentIdentity(page, projectDir), identity)
    await waitForOfficeContent(page)
    const savedChatScrollTop = await primeChatScroll(page)
    assert.ok(savedChatScrollTop > 100, '未建立可验证的聊天滚动位置')

    const mouseLayout = await resizeWithMouse(page)
    const keyboardLayout = await resizeWithKeyboard(page)
    await waitForOfficeContent(page)
    assert.deepEqual(await currentIdentity(page, projectDir), identity)
    await page.screenshot({ path: join(screenshotDir, '02-split-resized.png') })

    await page.click('[aria-label="关闭 sample.xlsx"]')
    await page.waitForSelector('[data-phi-chat-artifact-split="enabled"]', { hidden: true })
    await page.waitForSelector('[data-phi-focus="chat-input"]', { visible: true })
    assert.equal(
      await page.$eval(
        '[data-phi-focus="chat-input"]',
        (element) => (element as HTMLTextAreaElement).value
      ),
      draftText
    )
    const restoredChatWidth = await chatRootWidth(page)
    assert.ok(restoredChatWidth > mouseLayout.after.chatWidth + 100, '关闭预览后聊天未恢复全宽')
    const restoredChatScrollTop = await waitUntil('聊天滚动位置恢复', 3_000, async () => {
      const value = await chatScrollTop(page as Page)
      return Math.abs(value - savedChatScrollTop) <= 2 ? value : null
    })
    await removeChatScrollFixture(page)
    assert.deepEqual(await currentIdentity(page, projectDir), identity)
    await waitUntil('Office 资源回收', 10_000, async () => {
      const result = await page?.evaluate(async (path) => {
        const api = (window as unknown as { api: SmokeApi }).api
        return api.office.status({ sourcePath: path })
      }, sourcePath)
      return result?.ok && result.value === null ? true : null
    })
    await page.screenshot({ path: join(screenshotDir, '03-chat-restored.png') })

    // `status` already reports null while the service is still closing the draft, and closing
    // re-packs the file; snapshot only once every OfficeCLI process of this run is gone.
    await waitUntil('Office 进程全部退出', 10_000, () =>
      officePidsForRoot(runtimeRoot).length === 0 ? true : null
    )
    const beforeCancel = directorySnapshot(officeRoot)
    await openCreateDialog(page)
    await cancelCreateDialog(page)
    const afterCancel = directorySnapshot(officeRoot)
    assert.deepEqual(
      afterCancel,
      beforeCancel,
      `取消创建改变了会话产物目录；新增/变化：${JSON.stringify(
        afterCancel.filter((entry) => !beforeCancel.includes(entry))
      )}；消失/变化前：${JSON.stringify(beforeCancel.filter((entry) => !afterCancel.includes(entry)))}`
    )

    const firstKnownIds = new Set(officeArtifacts(officeRoot).map((item) => item.artifactId))
    const firstName = 'O04 空白一'
    const firstTitle = `${firstName}.xlsx`
    await createBlankWorkbook(page, firstName)
    const firstArtifact = await waitForNewArtifact(officeRoot, firstKnownIds)
    const firstBlank = await waitForBlankOfficeContent(page, firstTitle)
    await assertNormalOfficeBanners(page)
    assert.equal(firstArtifact.origin, 'blank')
    assert.equal(firstBlank.dataCellCount, 0)
    const firstBytes = readFileSync(firstArtifact.draftPath)
    await page.screenshot({ path: join(screenshotDir, '04-blank-first.png') })
    await page.waitForSelector(`[data-phi-office-target="${firstArtifact.artifactId}"]`, {
      visible: true,
      timeout: officeReadyTimeoutMs
    })
    assert.ok(
      (await officeChipText(page, firstArtifact.artifactId)).includes(firstName),
      '关联文档 chip 没有显示友好名称'
    )
    await assertSendStoppedByReadiness(page, firstArtifact.artifactId)

    const secondKnownIds = new Set(officeArtifacts(officeRoot).map((item) => item.artifactId))
    const secondName = 'O04 空白二'
    const secondTitle = `${secondName}.xlsx`
    await createBlankWorkbook(page, secondName)
    const secondArtifact = await waitForNewArtifact(officeRoot, secondKnownIds)
    const secondBlank = await waitForBlankOfficeContent(page, secondTitle)
    await assertNormalOfficeBanners(page)
    assert.equal(secondArtifact.origin, 'blank')
    assert.equal(secondBlank.dataCellCount, 0)
    assert.notEqual(secondArtifact.artifactId, firstArtifact.artifactId)
    assert.notEqual(secondArtifact.draftPath, firstArtifact.draftPath)
    assert.deepEqual(readFileSync(firstArtifact.draftPath), firstBytes)
    await page.waitForSelector(`[data-phi-office-target="${secondArtifact.artifactId}"]`, {
      visible: true,
      timeout: officeReadyTimeoutMs
    })
    assert.ok(
      (await officeChipText(page, secondArtifact.artifactId)).includes(secondName),
      '切换到第二份草稿后 chip 没有更新为新文档'
    )
    await page.screenshot({ path: join(screenshotDir, '05-blank-second.png') })

    await seedSelectionCells(
      officeBinaryPath,
      secondArtifact.draftPath,
      isolatedEnvironment(homeDir, agentDir)
    )
    await exerciseOfficeSelection(browser, page, secondArtifact.artifactId, screenshotDir)
    assert.ok(
      (await officeChipText(page, secondArtifact.artifactId)).includes(secondName),
      '清除选区后文档关联丢失'
    )
    assert.ok(
      !(await officeChipText(page, secondArtifact.artifactId)).includes('选区：'),
      '清除选区后 chip 仍显示选区'
    )

    // File tabs are preview tabs: opening the second workbook replaced the first one's tab, so the
    // first preview was released while its draft stays on disk. Closing the remaining tab must
    // release everything else.
    await closeOfficeTab(page, secondTitle, secondArtifact.draftPath)
    await page.waitForSelector('[data-phi-chat-artifact-split="enabled"]', { hidden: true })
    const livePage = page
    await waitUntil('第一份草稿预览释放', 10_000, async () => {
      const status = await livePage.evaluate(async (sourcePath) => {
        const api = (window as unknown as { api: SmokeApi }).api
        return api.office.status({ sourcePath })
      }, firstArtifact.draftPath)
      return status.ok && status.value === null ? true : null
    })
    assert.deepEqual(officePidsForRoot(runtimeRoot), [], '关闭空白草稿后仍有 OfficeCLI 进程')
    assert.deepEqual(readFileSync(firstArtifact.draftPath), firstBytes, '第一份草稿被改动')
    assert.ok(readFileSync(secondArtifact.draftPath).length > 0, '第二份草稿丢失')
    await page.screenshot({ path: join(screenshotDir, '09-blank-closed.png') })

    process.stdout.write(
      `OFFICE_APP_SMOKE_RESULT ${JSON.stringify({
        sessionId: identity.phiSessionId,
        sessionCount: identity.sessionCount,
        mouseLayout,
        keyboardLayout,
        restoredChatWidth,
        savedChatScrollTop,
        restoredChatScrollTop,
        cancelledArtifactSnapshot: beforeCancel,
        firstBlankArtifactId: firstArtifact.artifactId,
        secondBlankArtifactId: secondArtifact.artifactId,
        selectionSmoke: true,
        statusBannerSmoke: true,
        savedOutput,
        sendBlockedByReadiness: true,
        screenshotDir
      })}\n`
    )
    completed = true
  } catch (error) {
    const logs = electron?.logs().trim()
    if (logs) process.stderr.write(`Electron 输出（末尾）：\n${logs}\n`)
    throw error
  } finally {
    const cleanupErrors: unknown[] = []
    try {
      if (page && !page.isClosed()) {
        await page
          .evaluate(() => (window as unknown as { api: SmokeApi }).api.closeWindow())
          .catch(() => undefined)
        await delay(500)
      }
      browser?.disconnect()
      if (electron) await stopChild(electron.child)
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      await cleanOfficeProcesses(runtimeRoot)
    } catch (error) {
      cleanupErrors.push(error)
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true })
      if (!completed) rmSync(screenshotDir, { recursive: true, force: true })
    }
    if (cleanupErrors.length > 0) {
      const cleanupError = new AggregateError(cleanupErrors, 'Office app smoke 清理失败')
      process.stderr.write(`${cleanupError.stack ?? cleanupError.message}\n`)
      process.exitCode = 1
    }
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
