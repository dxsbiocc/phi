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

interface SmokeApi {
  createProject(name: string, workingDirectory: string, permissionMode: 'auto'): Promise<unknown>
  listPhiPlugins(): Promise<PhiPluginListItem[]>
  listSkills(cwd?: string): Promise<SkillSummary[]>
}

function smokePaths(runtimeRoot: string): SmokePaths {
  return {
    homeDir: join(runtimeRoot, 'home'),
    agentDir: join(runtimeRoot, 'home', '.phi'),
    projectDir: join(runtimeRoot, 'project'),
    userDataDir: join(runtimeRoot, 'electron-user-data'),
    saveAsPath: join(runtimeRoot, 'project', 'unused.xlsx'),
    screenshotDir: join(runtimeRoot, 'screenshots')
  }
}

/**
 * A fresh account opens the environment check once host detection finishes, at an unpredictable moment,
 * and "知道了" is its only way out. Dismiss it on every poll until no dialog is visible.
 */
async function waitForDialogsToClose(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const visible = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
        (dialog) => dialog.offsetParent !== null
      )
      for (const dialog of visible) {
        if (!dialog.innerText.includes('工作台环境检测')) continue
        Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
          .find((button) => button.innerText.trim() === '知道了')
          ?.click()
      }
      return visible.length === 0
    },
    { timeout: readyTimeoutMs, polling: 250 }
  )
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

async function assertOfficePlugin(page: Page): Promise<PhiPluginListItem> {
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
  assert.equal(
    await page.$eval('[data-phi-catalog-row="office"] [data-phi-catalog-status]', (element) =>
      element.getAttribute('data-phi-catalog-status')
    ),
    'enabled'
  )
  await page.click('[data-phi-catalog-row="office"] [role="button"]')
  await page.waitForSelector('[data-phi-plugin-detail="true"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  const detail = await page.$eval(
    '[data-phi-plugin-detail="true"]',
    (element) => element.textContent ?? ''
  )
  assert.match(detail, /办公文档（Excel \/ Word \/ PowerPoint \/ PDF）/u)
  assert.match(detail, /此插件未声明托管环境/u)
  for (const skill of OFFICE_SKILLS) assert.match(detail, new RegExp(skill, 'u'))

  const plugin = await page.evaluate(async () => {
    const plugins = await (window as unknown as { api: SmokeApi }).api.listPhiPlugins()
    return plugins.find((candidate) => candidate.id === 'office') ?? null
  })
  assert.ok(plugin, '插件 API 未返回 office')
  assert.equal(plugin.enabled, true)
  assert.deepEqual(plugin.environments, [])
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
  const paths = smokePaths(runtimeRoot)
  for (const path of [paths.agentDir, paths.projectDir, paths.userDataDir, paths.screenshotDir]) {
    mkdirSync(path, { recursive: true })
  }
  writeFileSync(join(paths.agentDir, 'onboarding.json'), '{"onboarded":true}\n')
  let app: RunningApp | undefined
  try {
    app = await launch(paths)
    await startProjectChat(app.page, paths.projectDir)
    const plugin = await assertOfficePlugin(app.page)
    await assertOfficeSkills(app.page, paths.projectDir)
    const directoryCount = officeSkillDirectoryCount()
    assert.equal(plugin.skills.length, directoryCount)
    assert.equal(directoryCount, OFFICE_SKILLS.length)
    process.stdout.write(
      `OFFICE_APP_PLUGIN_SMOKE_RESULT ${JSON.stringify({ plugin: plugin.id, skills: plugin.skills, directoryCount })}\n`
    )
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
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
