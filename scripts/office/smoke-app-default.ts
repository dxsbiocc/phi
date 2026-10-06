import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { Page } from 'puppeteer-core'

import {
  cleanOfficeProcesses,
  closeNormally,
  electronPath,
  launch,
  officePidsForRoot,
  repoRoot,
  stopChild,
  waitUntil,
  type RunningApp,
  type SmokePaths
} from './smoke-app-pptx-runtime'

type OfficeKind = 'xlsx' | 'docx' | 'pptx'
type ProjectSession = { sessionId: string; sessionPath: string }

interface SmokeApi {
  createProject(name: string, workingDirectory: string, permissionMode: 'auto'): Promise<unknown>
  getAppSettings(): Promise<{ officeEnabled: boolean }>
  getCurrentSession(): Promise<{ phiSessionId?: string }>
  listProjectSessions(
    workingDirectory: string
  ): Promise<Array<{ path: string; phiSessionId?: string }>>
  switchSession(path: string): Promise<unknown>
  office: {
    readonly enabled: boolean
    readonly availability: { enabled: boolean; reason: string | null }
  }
}

function pathsFor(runtimeRoot: string): SmokePaths {
  return {
    homeDir: join(runtimeRoot, 'home'),
    agentDir: join(runtimeRoot, 'home', '.phi'),
    projectDir: join(runtimeRoot, 'project'),
    userDataDir: join(runtimeRoot, 'electron-user-data'),
    saveAsPath: join(runtimeRoot, 'project', 'default-smoke-output.xlsx'),
    screenshotDir: join(runtimeRoot, 'screenshots')
  }
}

async function startProjectChat(
  page: Page,
  projectDir: string
): Promise<{ sessionId: string; sessionPath: string }> {
  await page.evaluate(async (cwd) => {
    await (window as unknown as { api: SmokeApi }).api.createProject(
      'Office Default Smoke',
      cwd,
      'auto'
    )
  }, projectDir)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[aria-label="项目"]', { visible: true })
  await page.click('[aria-label="项目"]')
  await waitUntil('默认开启 smoke 项目出现在侧栏', () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).some((element) =>
        element.textContent?.includes('Office Default Smoke')
      )
    )
  )
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (element) => element.textContent?.includes('Office Default Smoke')
    )
    const actions = row?.querySelectorAll<HTMLButtonElement>('button')
    const newChat = actions?.item((actions?.length ?? 0) - 1)
    if (!newChat) throw new Error('找不到项目的新对话动作')
    newChat.click()
  })
  await page.waitForSelector('[data-phi-focus="chat-input"]', { visible: true })
  return waitUntil('默认开启 smoke 会话建立', async () => {
    const sessions = await page.evaluate(async (cwd) => {
      return (window as unknown as { api: SmokeApi }).api.listProjectSessions(cwd)
    }, projectDir)
    const session = sessions[0]
    return session?.phiSessionId
      ? { sessionId: session.phiSessionId, sessionPath: session.path }
      : null
  })
}

async function restoreProjectChat(
  page: Page,
  projectDir: string,
  session: { sessionId: string; sessionPath: string }
): Promise<void> {
  await page.evaluate(
    async ({ cwd, sessionPath }) => {
      const api = (window as unknown as { api: SmokeApi }).api
      const target = (await api.listProjectSessions(cwd)).find(
        (candidate) => candidate.path === sessionPath
      )
      if (!target) throw new Error('重启后找不到默认开启 smoke 会话')
      await api.switchSession(target.path)
    },
    { cwd: projectDir, sessionPath: session.sessionPath }
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[aria-label="项目"]', { visible: true })
  await page.click('[aria-label="项目"]')
  await waitUntil('侧栏出现默认开启 smoke 会话', () =>
    page.evaluate(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find(
        (element) => element.textContent?.includes('新对话')
      )
      row?.click()
      return Boolean(row)
    })
  )
  await page.waitForSelector('[data-phi-focus="chat-input"]', { visible: true })
  const currentSessionId = await waitUntil('重启会话身份恢复', async () => {
    const current = await page.evaluate(async () =>
      (window as unknown as { api: SmokeApi }).api.getCurrentSession()
    )
    return current.phiSessionId ?? null
  })
  assert.equal(currentSessionId, session.sessionId)
}

async function assertCreateButtons(page: Page, expected: boolean): Promise<void> {
  const count = await page.$$eval(
    '[data-phi-office-create-button="true"]',
    (elements) => elements.length
  )
  assert.equal(count, expected ? 3 : 0)
  if (!expected) return
  for (const product of ['Excel', 'Word', 'PowerPoint']) {
    await page.waitForSelector(`[aria-label="新建空白 ${product}"]`, { visible: true })
  }
}

async function createAndPreview(page: Page, kind: OfficeKind, name: string): Promise<void> {
  const previousArtifact = await page
    .$eval('[data-phi-office-state="ready"]', (element) =>
      element.getAttribute('data-phi-office-artifact')
    )
    .catch(() => null)
  // A click that lands while the settings dialog is still fading out is swallowed by its backdrop.
  await page.waitForSelector('[role="dialog"]', { hidden: true })
  await page.click(`[data-phi-office-create-kind="${kind}"]`)
  await page.waitForSelector('[data-phi-office-create-dialog="true"]', { visible: true })
  await page.type('[data-phi-office-create-name="true"]', name)
  await page.click('[data-phi-office-create-submit="true"]')
  await page.waitForSelector('[data-phi-office-create-dialog="true"]', { hidden: true })
  await waitUntil(`${kind} 空白文档预览`, async () => {
    const artifact = await page
      .$eval('[data-phi-office-state="ready"]', (element) =>
        element.getAttribute('data-phi-office-artifact')
      )
      .catch(() => null)
    return artifact && artifact !== previousArtifact ? artifact : null
  })
}

async function openGeneralSettings(page: Page): Promise<void> {
  await page.click('[aria-label="设置"]')
  await page.waitForSelector('[role="dialog"]', { visible: true })
  await page.evaluate(() => {
    const general = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (element) => element.textContent?.trim() === '通用'
    )
    general?.click()
  })
  await page.waitForSelector('input[name="officeEnabled"]')
}

async function setOfficePreference(page: Page, enabled: boolean): Promise<void> {
  await openGeneralSettings(page)
  const input = await page.$('input[name="officeEnabled"]')
  assert.ok(input)
  assert.equal(await input.evaluate((element) => (element as HTMLInputElement).checked), !enabled)
  await input.click()
  await waitUntil(`Office 设置保存为 ${String(enabled)}`, () =>
    page.evaluate(async (expected) => {
      const settings = await (window as unknown as { api: SmokeApi }).api.getAppSettings()
      return settings.officeEnabled === expected
    }, enabled)
  )
  await page.click('[aria-label="关闭设置"]')
}

async function assertOfficeBridge(
  page: Page,
  expected: { enabled: boolean; reason: string | null }
): Promise<void> {
  assert.deepEqual(
    await page.evaluate(() => {
      const office = (window as unknown as { api: SmokeApi }).api.office
      return { enabled: office.enabled, reason: office.availability.reason }
    }),
    expected
  )
}

async function assertNoOfficeProcess(runtimeRoot: string): Promise<void> {
  await delay(1_000)
  const pids = officePidsForRoot(runtimeRoot)
  if (pids === null) throw new Error('无法读取进程列表，不能验证 OfficeCLI 未启动')
  assert.deepEqual(pids, [], 'Office 关闭时不应存在 OfficeCLI 进程')
}

async function runDefaultEnabledScenario(
  paths: SmokePaths,
  running: RunningApp[]
): Promise<ProjectSession> {
  const initial = await launch(paths, { injectSaveAsPath: false })
  running.push(initial)
  const session = await startProjectChat(initial.page, paths.projectDir)
  await assertOfficeBridge(initial.page, { enabled: true, reason: null })
  await assertCreateButtons(initial.page, true)
  await openGeneralSettings(initial.page)
  const initialSwitch = await initial.page.$('input[name="officeEnabled"]')
  assert.ok(initialSwitch)
  assert.equal(await initialSwitch.evaluate((element) => element.checked), true)
  await initial.page.click('[aria-label="关闭设置"]')
  await createAndPreview(initial.page, 'xlsx', '默认开启 Excel')
  await createAndPreview(initial.page, 'docx', '默认开启 Word')
  await createAndPreview(initial.page, 'pptx', '默认开启 PowerPoint')
  await setOfficePreference(initial.page, false)
  await closeNormally(initial)
  return session
}

async function runDisabledScenario(
  paths: SmokePaths,
  runtimeRoot: string,
  session: ProjectSession,
  running: RunningApp[]
): Promise<void> {
  const disabled = await launch(paths, { injectSaveAsPath: false })
  running.push(disabled)
  await restoreProjectChat(disabled.page, paths.projectDir, session)
  await assertOfficeBridge(disabled.page, { enabled: false, reason: 'user-disabled' })
  await assertCreateButtons(disabled.page, false)
  await assertNoOfficeProcess(runtimeRoot)
  await setOfficePreference(disabled.page, true)
  await closeNormally(disabled)
}

async function runRestoredScenario(
  paths: SmokePaths,
  session: ProjectSession,
  running: RunningApp[]
): Promise<void> {
  const restored = await launch(paths, { injectSaveAsPath: false })
  running.push(restored)
  await restoreProjectChat(restored.page, paths.projectDir, session)
  await assertOfficeBridge(restored.page, { enabled: true, reason: null })
  await assertCreateButtons(restored.page, true)
  await closeNormally(restored)
}

async function runForcedOffScenario(
  paths: SmokePaths,
  runtimeRoot: string,
  session: ProjectSession,
  running: RunningApp[]
): Promise<void> {
  const forcedOff = await launch(paths, {
    injectSaveAsPath: false,
    environment: { PHI_OFFICE: '0' }
  })
  running.push(forcedOff)
  await restoreProjectChat(forcedOff.page, paths.projectDir, session)
  await assertOfficeBridge(forcedOff.page, { enabled: false, reason: 'forced-disabled' })
  await assertCreateButtons(forcedOff.page, false)
  await openGeneralSettings(forcedOff.page)
  const forcedSwitch = await forcedOff.page.$('input[name="officeEnabled"]')
  assert.ok(forcedSwitch)
  assert.equal(await forcedSwitch.evaluate((element) => element.disabled), true)
  await assertNoOfficeProcess(runtimeRoot)
  await closeNormally(forcedOff)
}

function writeElectronLogs(running: readonly RunningApp[]): void {
  const logs = running
    .map((app) => app.logs().trim())
    .filter(Boolean)
    .join('\n')
  if (logs) process.stderr.write(`Electron 输出（末尾）：\n${logs}\n`)
}

async function cleanup(runtimeRoot: string, running: readonly RunningApp[]): Promise<void> {
  for (const app of running) {
    app.browser.disconnect()
    await stopChild(app.child)
  }
  const processCheck = await cleanOfficeProcesses(runtimeRoot).finally(() =>
    rmSync(runtimeRoot, { recursive: true, force: true })
  )
  if (processCheck === 'ps_unavailable') {
    process.stderr.write('默认开启 smoke：ps 不可用，已降级为按已知 Electron 进程清理。\n')
  }
}

async function main(): Promise<void> {
  assert.ok(existsSync(join(repoRoot, 'out', 'main', 'index.mjs')), '请先构建 Electron 应用')
  assert.ok(existsSync(electronPath), 'Electron 可执行入口不存在')
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'phi-office-default-app-smoke-'))
  const paths = pathsFor(runtimeRoot)
  for (const path of [paths.agentDir, paths.projectDir, paths.userDataDir, paths.screenshotDir]) {
    mkdirSync(path, { recursive: true })
  }
  writeFileSync(join(paths.agentDir, 'onboarding.json'), '{"onboarded":true}\n')
  const running: RunningApp[] = []

  try {
    const session = await runDefaultEnabledScenario(paths, running)
    await runDisabledScenario(paths, runtimeRoot, session, running)
    await runRestoredScenario(paths, session, running)
    await runForcedOffScenario(paths, runtimeRoot, session, running)

    process.stdout.write(
      `OFFICE_APP_DEFAULT_SMOKE_RESULT ${JSON.stringify({ defaultEnabled: true, createdKinds: 3, restartCount: 4, forcedOff: true })}\n`
    )
  } catch (error) {
    writeElectronLogs(running)
    throw error
  } finally {
    await cleanup(runtimeRoot, running)
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
