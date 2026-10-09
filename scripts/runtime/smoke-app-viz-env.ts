import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { connect, type Browser, type Page } from 'puppeteer-core'

import type { PhiPluginListItem } from '../../src/shared/phiPluginTypes'
import { parseContentSourceArgs } from '../content/source-roots.mjs'
import { installVisualizationSmokePlugin } from './install-smoke-visualization'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const electronPath = join(repoRoot, 'node_modules', '.bin', 'electron')
const readyTimeoutMs = 60_000
const APPROVAL_LABELS = { read: '只读', write: '写入', execute: '执行' } as const

class FatalSmokeError extends Error {}

interface RunningApp {
  readonly browser: Browser
  readonly page: Page
  readonly child: ChildProcess
  readonly logs: () => string
}

interface ManagedEnvironmentCard {
  readonly title: string
  readonly identity: string
}

interface SmokeApi {
  listPhiPlugins(): Promise<PhiPluginListItem[]>
}

function environment(homeDir: string, agentDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir
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

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolveExit(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolveExit(false)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (await waitForExit(child, 100)) return
  try {
    if (process.platform === 'win32' || !child.pid) child.kill('SIGTERM')
    else process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  if (await waitForExit(child, 10_000)) return
  try {
    if (process.platform === 'win32' || !child.pid) child.kill('SIGKILL')
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
  assert.equal(await waitForExit(child, 10_000), true, 'SIGKILL 后 Electron 仍未退出')
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
  let browser: Browser | null = null
  const collect = (chunk: Buffer): void => {
    output = `${output}${chunk.toString('utf8')}`.slice(-20_000)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  try {
    browser = await waitUntil('Electron CDP 启动', async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new FatalSmokeError(
          `Electron 已退出 code=${String(child.exitCode)} signal=${child.signalCode}\n${output}`
        )
      }
      return connect({ browserURL: `http://127.0.0.1:${port}` }).catch(() => null)
    })
    const page = await waitUntil('Phi renderer 页面', async () => {
      const pages = await browser?.pages()
      return pages?.find((candidate) => candidate.url() !== 'about:blank') ?? null
    })
    await page.setViewport({ width: 1500, height: 950 })
    return { browser, page, child, logs: () => output }
  } catch (error) {
    await browser?.close().catch(() => undefined)
    await stopChild(child)
    throw error
  }
}

async function clickExactControl(page: Page, scopeSelector: string, text: string): Promise<void> {
  await waitUntil(`点击“${text}”`, () =>
    page.evaluate(
      ({ scopeSelector, text }) => {
        const scope = document.querySelector(scopeSelector)
        const control = Array.from(
          scope?.querySelectorAll<HTMLElement>('button, [role="button"]') ?? []
        ).find((candidate) => candidate.innerText.trim() === text)
        if (!control) return false
        control.click()
        return true
      },
      { scopeSelector, text }
    )
  )
}

async function waitForDialogsToClose(page: Page): Promise<void> {
  await waitUntil('关闭所有可见对话框', () =>
    page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
        (dialog) => dialog.offsetParent !== null
      )
      for (const dialog of dialogs) {
        Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
          .find((button) => button.innerText.trim() === '知道了')
          ?.click()
      }
      return dialogs.length === 0
    })
  )
}

async function dismissFirstRunEnvironmentSummary(page: Page): Promise<void> {
  await waitUntil('首次工作台环境检测对话框', () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).some((dialog) =>
        dialog.innerText.includes('工作台环境检测')
      )
    )
  )
  await waitForDialogsToClose(page)
}

async function assertVisualizationPlugin(
  page: Page,
  screenshotDir: string
): Promise<PhiPluginListItem> {
  await waitForDialogsToClose(page)
  await page.click('button[aria-label="插件"]')
  await page.waitForSelector('[data-phi-catalog-sidebar="plugins"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  const visualizationRow =
    '[data-phi-catalog-sidebar="plugins"] [data-phi-catalog-row="visualization"]'
  await page.waitForSelector(visualizationRow, { visible: true, timeout: readyTimeoutMs })
  // The sidebar is first shown as a hover preview (two copies of the row exist) and the first click only
  // settles it, so click again until the detail opens. The row's [role="button"] opens the plugin; matching
  // by aria-label hits the enable switch's neighbour instead.
  await waitUntil('打开 visualization 插件详情', async () => {
    const opened = await page
      .$eval('[data-phi-plugin-detail="true"]', (element) =>
        (element.textContent ?? '').includes('visualization · v')
      )
      .catch(() => false)
    if (opened) return true
    await page.evaluate((selector) => {
      const visibleRow = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
        (candidate) => candidate.offsetParent !== null
      )
      visibleRow?.querySelector<HTMLElement>('[role="button"]')?.click()
    }, visualizationRow)
    await delay(1_500)
    return (await page
      .$eval('[data-phi-plugin-detail="true"]', (element) =>
        (element.textContent ?? '').includes('visualization · v')
      )
      .catch(() => false))
      ? true
      : null
  })
  await page.waitForSelector('[data-phi-plugin-detail="true"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  await page.waitForSelector('[data-phi-plugin-component-details="true"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  await page.waitForSelector('[data-phi-plugin-environment="phi:r@1"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  const screenshotPath = join(screenshotDir, 'visualization-plugin-detail.png')
  await page.screenshot({ path: screenshotPath, fullPage: true })
  process.stdout.write(`VIZ_APP_PLUGIN_DETAIL_SCREENSHOT ${screenshotPath}\n`)

  const detail = await waitUntil('visualization 插件详情', async () => {
    const text = await page.$eval(
      '[data-phi-plugin-detail="true"]',
      (element) => (element as HTMLElement).innerText
    )
    return text.includes('visualization · v') ? text : null
  })
  assert.equal(
    await page.$eval('[data-phi-plugin-detail="true"] h4', (element) =>
      (element as HTMLElement).innerText.trim()
    ),
    '科研绘图'
  )
  assert.doesNotMatch(detail, /此插件未声明托管环境/u)
  const plugin = await page.evaluate(async () => {
    const plugins = await (window as unknown as { api: SmokeApi }).api.listPhiPlugins()
    return plugins.find((candidate) => candidate.id === 'visualization') ?? null
  })
  assert.ok(plugin, '插件 API 未返回 visualization')
  assert.equal(plugin.agentDetails?.length, 1)
  assert.equal(plugin.skillDetails?.length, 1)
  assert.equal(plugin.scriptToolDetails?.length, 4)
  for (const agent of plugin.agentDetails ?? []) {
    assert.ok(agent.description, `${agent.name} 缺少智能体描述`)
    assert.ok(detail.includes(agent.description), `${agent.name} 的智能体描述未显示`)
  }
  for (const skill of plugin.skillDetails ?? []) {
    assert.ok(skill.description, `${skill.name} 缺少技能描述`)
    assert.ok(detail.includes(skill.description), `${skill.name} 的技能描述未显示`)
  }
  for (const tool of plugin.scriptToolDetails ?? []) {
    assert.ok(tool.description, `${tool.name} 缺少脚本工具描述`)
    assert.ok(detail.includes(tool.description), `${tool.name} 的脚本工具描述未显示`)
    assert.ok(
      detail.includes(`审批：${APPROVAL_LABELS[tool.approval]}`),
      `${tool.name} 未显示审批等级`
    )
    assert.ok(detail.includes(`所属技能：${tool.skillName}`), `${tool.name} 未显示所属技能`)
  }
  const environment = plugin.usedEnvironments?.find((candidate) => candidate.ref === 'phi:r@1')
  assert.ok(environment, 'visualization 未声明实际使用的 phi:r@1')
  assert.equal(environment.name, 'phi-r')
  assert.equal(environment.scope, 'builtin')
  assert.deepEqual(environment.skillNames, ['omics-visualization'])
  assert.deepEqual(environment.agentNames, ['Visualization'])
  const environmentDetail = await page.$eval(
    '[data-phi-plugin-environment="phi:r@1"]',
    (element) => (element as HTMLElement).innerText
  )
  assert.match(environmentDetail, /内置 R 环境 · phi-r/u)
  assert.match(environmentDetail, /与其他内置技能共享/u)
  assert.match(environmentDetail, /使用技能：omics-visualization/u)
  assert.match(environmentDetail, /使用智能体：Visualization/u)
  assert.match(environmentDetail, /未构建/u)
  assert.match(environmentDetail, /查看估算并构建/u)
  return plugin
}

async function assertManagedEnvironments(page: Page): Promise<ManagedEnvironmentCard[]> {
  await waitForDialogsToClose(page)
  await page.click('button[aria-label="设置"]')
  await page.waitForSelector('[role="dialog"]', { visible: true, timeout: readyTimeoutMs })
  await clickExactControl(page, '[role="dialog"]', '环境')
  await page.waitForSelector('section[aria-labelledby="managed-environments-title"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  const cards = await waitUntil('托管环境列表显示 phi-r', async () => {
    const values = await page.evaluate(() => {
      const section = document.querySelector(
        'section[aria-labelledby="managed-environments-title"]'
      )
      return Array.from(section?.querySelectorAll<HTMLElement>('.MuiPaper-root') ?? []).map(
        (card) => {
          const lines = card.innerText
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
          return {
            title: lines[0] ?? '',
            identity: lines.find((line) => line.includes(' · ')) ?? ''
          }
        }
      )
    })
    return values.some((card) => card.title === 'phi-r') ? values : null
  })
  assert.ok(
    cards.some((card) => card.title === 'phi-r'),
    '托管环境列表缺少 phi-r'
  )
  assert.equal(
    cards.some((card) => card.title === 'viz'),
    false,
    '托管环境列表仍包含 viz'
  )
  assert.equal(
    cards.some(
      (card) =>
        card.identity.includes('plugin:viz') || card.identity.includes('plugin-visualization-viz')
    ),
    false,
    '托管环境列表仍包含 plugin:viz'
  )
  return cards
}

async function assertVisualizationSkill(page: Page): Promise<void> {
  await page.click('button[aria-label="关闭设置"]')
  await page.waitForSelector('button[aria-label="关闭设置"]', {
    hidden: true,
    timeout: readyTimeoutMs
  })
  await page.click('button[aria-label="技能"]')
  await page.waitForSelector('[data-phi-catalog-sidebar="skills"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  await waitUntil('展开插件技能分组', () =>
    page.evaluate(() => {
      const sidebar = document.querySelector('[data-phi-catalog-sidebar="skills"]')
      const summary = Array.from(
        sidebar?.querySelectorAll<HTMLElement>('button[aria-expanded]') ?? []
      ).find((candidate) => candidate.innerText.trim().startsWith('插件'))
      if (!summary) return false
      if (summary.getAttribute('aria-expanded') !== 'true') summary.click()
      return true
    })
  )
  await page.waitForSelector(
    '[data-phi-catalog-sidebar="skills"] [aria-label^="打开 omics-visualization，"]',
    { visible: true, timeout: readyTimeoutMs }
  )
}

async function main(): Promise<void> {
  const sourceRoot = parseContentSourceArgs(process.argv.slice(2), { defaultToPackages: true })
  const smokeRoot = mkdtempSync(join(tmpdir(), 'phi-app-viz-env-smoke-'))
  const homeDir = join(smokeRoot, 'home')
  // Phi startup normalizes its account to HOME/.phi; install into that exact isolated account.
  const agentDir = join(homeDir, '.phi')
  const userDataDir = join(smokeRoot, 'user-data')
  const screenshotDir = mkdtempSync(join(tmpdir(), 'phi-viz-plugin-detail-shots-'))
  for (const path of [homeDir, agentDir, userDataDir]) mkdirSync(path, { recursive: true })
  // Without this a fresh account opens the persona onboarding dialog right after the environment check.
  writeFileSync(join(agentDir, 'onboarding.json'), '{"onboarded":true}\n')

  let app: RunningApp | null = null
  let completed = false
  try {
    installVisualizationSmokePlugin({ agentDir, sourceRoot })
    app = await launch(homeDir, agentDir, userDataDir)
    await dismissFirstRunEnvironmentSummary(app.page)
    const plugin = await assertVisualizationPlugin(app.page, screenshotDir)
    const environments = await assertManagedEnvironments(app.page)
    await assertVisualizationSkill(app.page)
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          plugin: plugin.id,
          pluginEnvironment: 'phi:r@1',
          managedEnvironments: environments.map((environment) => environment.title),
          skill: 'omics-visualization',
          screenshotDir
        },
        null,
        2
      )}\n`
    )
    completed = true
  } catch (error) {
    if (app?.logs()) process.stderr.write(`${app.logs()}\n`)
    throw error
  } finally {
    await app?.browser.close().catch(() => undefined)
    if (app) await stopChild(app.child)
    rmSync(smokeRoot, { recursive: true, force: true })
    if (!completed) rmSync(screenshotDir, { recursive: true, force: true })
  }
}

await main()
