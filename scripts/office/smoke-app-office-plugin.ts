import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { Page } from 'puppeteer-core'

import type { PhiPluginListItem } from '../../src/shared/phiPluginTypes'
import type { SkillSummary } from '../../src/shared/skillTypes'
import {
  closeNormally,
  electronPath,
  launch,
  readyTimeoutMs,
  repoRoot,
  stopChild,
  waitUntil,
  type RunningApp,
  type SmokePaths
} from './smoke-app-pptx-runtime'

const OFFICE_SKILLS = ['docx', 'office-workflow', 'pdf', 'pptx', 'xlsx'] as const
const APPROVAL_LABELS = { read: '只读', write: '写入', execute: '执行' } as const

interface SmokeApi {
  createProject(name: string, workingDirectory: string, permissionMode: 'auto'): Promise<unknown>
  listPhiPlugins(): Promise<PhiPluginListItem[]>
  listSkills(cwd?: string): Promise<SkillSummary[]>
}

function smokePaths(runtimeRoot: string, screenshotDir: string): SmokePaths {
  return {
    homeDir: join(runtimeRoot, 'home'),
    agentDir: join(runtimeRoot, 'home', '.phi'),
    projectDir: join(runtimeRoot, 'project'),
    userDataDir: join(runtimeRoot, 'electron-user-data'),
    saveAsPath: join(runtimeRoot, 'project', 'unused.xlsx'),
    screenshotDir
  }
}

async function waitForDialogsToClose(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const visible = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
        (dialog) => dialog.offsetParent !== null
      )
      for (const dialog of visible) {
        Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
          .find((button) => button.innerText.trim() === '知道了')
          ?.click()
      }
      return visible.length === 0
    },
    { timeout: readyTimeoutMs, polling: 250 }
  )
}

async function dismissFirstRunDialogs(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).some(
        (dialog) => dialog.offsetParent !== null && dialog.innerText.includes('工作台环境检测')
      ),
    { timeout: readyTimeoutMs, polling: 250 }
  )
  await waitForDialogsToClose(page)
}

async function openPluginDetail(page: Page, pluginId: string): Promise<void> {
  const row = `[data-phi-catalog-sidebar="plugins"] [data-phi-catalog-row="${pluginId}"]`
  await waitUntil(`打开 ${pluginId} 插件详情`, async () => {
    const opened = await page
      .$eval(
        '[data-phi-plugin-detail="true"]',
        (element, id) => (element.textContent ?? '').includes(`${id} · v`),
        pluginId
      )
      .catch(() => false)
    if (opened) return true
    await page.evaluate((selector) => {
      const visibleRow = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
        (candidate) => candidate.offsetParent !== null
      )
      visibleRow?.querySelector<HTMLElement>('[role="button"]')?.click()
    }, row)
    await delay(1_500)
    return (await page
      .$eval(
        '[data-phi-plugin-detail="true"]',
        (element, id) => (element.textContent ?? '').includes(`${id} · v`),
        pluginId
      )
      .catch(() => false))
      ? true
      : null
  })
}

async function startProjectChat(page: Page, projectDir: string): Promise<void> {
  const canonicalProjectDir = realpathSync(projectDir)
  await page.evaluate(async (cwd) => {
    await (window as unknown as { api: SmokeApi }).api.createProject(
      'Office Plugin Smoke',
      cwd,
      'auto'
    )
  }, canonicalProjectDir)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForDialogsToClose(page)
  await page.waitForSelector('[aria-label="项目"]', { visible: true })
  await page.click('[aria-label="项目"]')
  await waitUntil('办公插件 smoke 项目出现在侧栏', () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).some((element) =>
        element.textContent?.includes('Office Plugin Smoke')
      )
    )
  )
  await waitForDialogsToClose(page)
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (element) => element.textContent?.includes('Office Plugin Smoke')
    )
    const actions = row?.querySelectorAll<HTMLButtonElement>('button')
    const newChat = actions?.item((actions?.length ?? 0) - 1)
    if (!newChat) throw new Error('找不到项目的新对话动作')
    newChat.click()
  })
  await page.waitForSelector('[data-phi-focus="chat-input"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
}

async function assertOfficePlugin(page: Page, screenshotDir: string): Promise<PhiPluginListItem> {
  await waitForDialogsToClose(page)
  await page.click('[aria-label="插件"]')
  await page.waitForSelector('[data-phi-catalog-sidebar="plugins"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  await page.waitForSelector('[data-phi-catalog-row="office"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  await openPluginDetail(page, 'office')
  await page.waitForSelector('[data-phi-plugin-detail="true"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  await page.waitForSelector('[data-phi-plugin-component-details="true"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  await page.waitForSelector('[data-phi-plugin-environment="phi:python@1"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  const screenshotPath = join(screenshotDir, 'office-plugin-detail.png')
  await page.screenshot({ path: screenshotPath, fullPage: true })
  process.stdout.write(`OFFICE_APP_PLUGIN_DETAIL_SCREENSHOT ${screenshotPath}\n`)

  assert.equal(
    await page.$eval('[data-phi-catalog-row="office"] [data-phi-catalog-status]', (element) =>
      element.getAttribute('data-phi-catalog-status')
    ),
    'enabled'
  )
  assert.equal(
    await page.$eval('[data-phi-plugin-detail="true"] h4', (element) =>
      (element as HTMLElement).innerText.trim()
    ),
    '办公文档'
  )
  const detail = await page.$eval(
    '[data-phi-plugin-detail="true"]',
    (element) => (element as HTMLElement).innerText
  )
  assert.doesNotMatch(detail, /办公文档（Excel \/ Word \/ PowerPoint \/ PDF）/u)
  assert.doesNotMatch(detail, /此插件未声明托管环境/u)

  const plugin = await page.evaluate(async () => {
    const plugins = await (window as unknown as { api: SmokeApi }).api.listPhiPlugins()
    return plugins.find((candidate) => candidate.id === 'office') ?? null
  })
  assert.ok(plugin, '插件 API 未返回 office')
  assert.equal(plugin.title, '办公文档')
  assert.equal(plugin.version, '1.0.1')
  assert.equal(plugin.enabled, true)
  assert.deepEqual(plugin.environments, [])
  assert.equal(plugin.skillDetails?.length, OFFICE_SKILLS.length)
  assert.deepEqual(plugin.skillDetails?.map((skill) => skill.name).sort(), [...OFFICE_SKILLS])
  for (const skill of plugin.skillDetails ?? []) {
    assert.ok(skill.description, `${skill.name} 缺少技能描述`)
    assert.ok(detail.includes(skill.description), `${skill.name} 的技能描述未显示`)
    assert.ok(detail.includes(skill.name), `${skill.name} 未显示`)
  }
  assert.equal(plugin.scriptToolDetails?.length, 6)
  for (const tool of plugin.scriptToolDetails ?? []) {
    assert.ok(tool.description, `${tool.name} 缺少脚本工具描述`)
    assert.ok(detail.includes(tool.description), `${tool.name} 的脚本工具描述未显示`)
    assert.ok(detail.includes(tool.name), `${tool.name} 未显示`)
    assert.ok(
      detail.includes(`审批：${APPROVAL_LABELS[tool.approval]}`),
      `${tool.name} 未显示审批等级`
    )
    assert.ok(detail.includes(`所属技能：${tool.skillName}`), `${tool.name} 未显示所属技能`)
  }
  const environment = plugin.usedEnvironments?.find((candidate) => candidate.ref === 'phi:python@1')
  assert.ok(environment, 'office 未声明实际使用的 phi:python@1')
  assert.equal(environment.name, 'phi-python')
  assert.equal(environment.scope, 'builtin')
  assert.deepEqual(environment.skillNames, [...OFFICE_SKILLS])
  const environmentDetail = await page.$eval(
    '[data-phi-plugin-environment="phi:python@1"]',
    (element) => (element as HTMLElement).innerText
  )
  assert.match(environmentDetail, /内置 Python 环境 · phi-python/u)
  assert.match(environmentDetail, /与其他内置技能共享/u)
  assert.match(environmentDetail, /使用技能：docx、office-workflow、pdf、pptx、xlsx/u)
  assert.match(environmentDetail, /未构建/u)
  assert.match(environmentDetail, /查看估算并构建/u)
  return plugin
}

/** Plugin-provided skills sit in a "插件" group (an aria-expanded button) that starts collapsed. */
async function expandPluginGroup(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sidebar = document.querySelector('[data-phi-catalog-sidebar="skills"]')
    const header = Array.from(
      sidebar?.querySelectorAll<HTMLButtonElement>('button[aria-expanded]') ?? []
    ).find((button) => button.innerText.trim().startsWith('插件'))
    if (header?.getAttribute('aria-expanded') === 'false') header.click()
  })
}

async function assertOfficeSkills(page: Page, projectDir: string): Promise<void> {
  await waitForDialogsToClose(page)
  await page.click('[aria-label="技能"]')
  await page.waitForSelector('[data-phi-catalog-sidebar="skills"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  const input = '[aria-label="搜索技能"]'
  for (const skill of OFFICE_SKILLS) {
    await page.click(input, { count: 3 })
    await page.type(input, skill)
    const row = `[data-phi-catalog-row$="/skills/${skill}/SKILL.md"]`
    // Filtering re-renders the list, so open the group only once the row is in the DOM.
    await page.waitForSelector(row, { timeout: readyTimeoutMs })
    await expandPluginGroup(page)
    await page.waitForSelector(row, { visible: true, timeout: readyTimeoutMs })
    assert.equal(
      await page.$eval(`${row} [data-phi-catalog-status]`, (element) =>
        element.getAttribute('data-phi-catalog-status')
      ),
      'enabled',
      `${skill} 未在技能页显示为启用`
    )
  }

  const listed = await page.evaluate(async (cwd) => {
    const skills = await (window as unknown as { api: SmokeApi }).api.listSkills(cwd)
    return skills
      .filter((skill) => skill.sourceCategory === 'plugin' && skill.sourceId === 'office')
      .map((skill) => ({ name: skill.name, enabled: skill.enabled }))
  }, realpathSync(projectDir))
  assert.deepEqual(listed.map((skill) => skill.name).sort(), [...OFFICE_SKILLS])
  assert.equal(
    listed.every((skill) => skill.enabled),
    true
  )
}

function officeSkillDirectoryCount(): number {
  const root = join(repoRoot, 'resources', 'plugins', 'office', 'skills')
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
}

async function main(): Promise<void> {
  assert.ok(existsSync(join(repoRoot, 'out', 'main', 'index.mjs')), '请先构建 Electron 应用')
  assert.ok(existsSync(electronPath), 'Electron 可执行入口不存在')
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'phi-office-plugin-app-smoke-'))
  const screenshotDir = mkdtempSync(join(tmpdir(), 'phi-office-plugin-detail-shots-'))
  const paths = smokePaths(runtimeRoot, screenshotDir)
  for (const path of [paths.agentDir, paths.projectDir, paths.userDataDir, paths.screenshotDir]) {
    mkdirSync(path, { recursive: true })
  }
  writeFileSync(join(paths.homeDir, '.phi', 'onboarding.json'), '{"onboarded":true}\n')
  let app: RunningApp | undefined
  let completed = false
  try {
    app = await launch(paths)
    await dismissFirstRunDialogs(app.page)
    await startProjectChat(app.page, paths.projectDir)
    const plugin = await assertOfficePlugin(app.page, paths.screenshotDir)
    await assertOfficeSkills(app.page, paths.projectDir)
    const directoryCount = officeSkillDirectoryCount()
    assert.equal(plugin.skills.length, directoryCount)
    assert.equal(directoryCount, OFFICE_SKILLS.length)
    process.stdout.write(
      `OFFICE_APP_PLUGIN_SMOKE_RESULT ${JSON.stringify({ plugin: plugin.id, skills: plugin.skills, directoryCount, screenshotDir })}\n`
    )
    completed = true
    await closeNormally(app)
  } catch (error) {
    const logs = app?.logs().trim()
    if (logs) process.stderr.write(`Electron 输出（末尾）：\n${logs}\n`)
    throw error
  } finally {
    if (app) {
      app.browser.disconnect()
      await stopChild(app.child)
    }
    rmSync(runtimeRoot, { recursive: true, force: true })
    if (!completed) rmSync(screenshotDir, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
