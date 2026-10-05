import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { Browser, Page } from 'puppeteer-core'

import { officeCliEnv, runOfficeCli } from '../../src/main/agent/office/office-driver'
import { officeGuest } from './smoke-app-selection'

const READY_TIMEOUT_MS = 60_000

interface HumanEditSmokeArtifact {
  artifactId: string
  draftPath: string
}

interface OfficeCliGetResult {
  success?: boolean
  data?: { results?: OfficeCliCell[] }
}

interface OfficeCliCell {
  text?: string
  format?: { empty?: boolean }
}

async function waitUntil<T>(
  label: string,
  probe: () => T | false | null | Promise<T | false | null>
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

async function beginEdit(guest: Page, path: string): Promise<void> {
  const selector = `td[data-path="${path}"]`
  const cell = await guest.waitForSelector(selector, { visible: true, timeout: READY_TIMEOUT_MS })
  assert.ok(cell, `找不到可编辑单元格 ${path}`)
  await cell.click({ count: 2, delay: 40 })
  await guest.waitForSelector(`${selector} input`, { visible: true, timeout: READY_TIMEOUT_MS })
}

async function replaceEditorText(guest: Page, path: string, text: string): Promise<void> {
  const selector = `td[data-path="${path}"] input`
  const input = await guest.waitForSelector(selector, { visible: true, timeout: READY_TIMEOUT_MS })
  assert.ok(input)
  await input.click({ count: 3 })
  await guest.keyboard.press('Backspace')
  if (text) await guest.keyboard.type(text)
}

async function cellText(guest: Page, path: string): Promise<string> {
  return guest.$eval(`td[data-path="${path}"]`, (cell) => cell.textContent?.trim() ?? '')
}

async function waitForCellText(guest: Page, path: string, expected: string): Promise<void> {
  await waitUntil(`${path} 内容更新`, async () => (await cellText(guest, path)) === expected)
}

async function readWithOfficeCli(
  binaryPath: string,
  draftPath: string,
  path: string,
  environment: NodeJS.ProcessEnv
): Promise<OfficeCliCell> {
  const result = await runOfficeCli(binaryPath, ['get', draftPath, path, '--json'], {
    timeoutMs: 30_000,
    env: officeCliEnv(environment)
  })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  const parsed = JSON.parse(result.stdout) as OfficeCliGetResult
  assert.equal(parsed.success, true)
  const cell = parsed.data?.results?.[0]
  assert.ok(cell, `OfficeCLI 未返回 ${path}`)
  return cell
}

export async function exerciseOfficeHumanEdit(
  browser: Browser,
  page: Page,
  artifact: HumanEditSmokeArtifact,
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  screenshotDir: string
): Promise<void> {
  const guest = await officeGuest(browser, page)
  await guest.waitForSelector('td[data-path="/Sheet1/B4"]', {
    visible: true,
    timeout: READY_TIMEOUT_MS
  })
  const requests: string[] = []
  guest.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/send') {
      requests.push(request.postData() ?? '')
    }
  })

  await beginEdit(guest, '/Sheet1/A1')
  await replaceEditorText(guest, '/Sheet1/A1', 'ManualEnter')
  await guest.keyboard.press('Enter')
  await waitForCellText(guest, '/Sheet1/A1', 'ManualEnter')

  await beginEdit(guest, '/Sheet1/A2')
  await replaceEditorText(guest, '/Sheet1/A2', 'ManualTab')
  await guest.keyboard.press('Tab')
  await waitForCellText(guest, '/Sheet1/A2', 'ManualTab')

  const escapeBefore = await cellText(guest, '/Sheet1/A3')
  const requestsBeforeEscape = requests.length
  await beginEdit(guest, '/Sheet1/A3')
  await replaceEditorText(guest, '/Sheet1/A3', 'MustNotCommit')
  await guest.keyboard.press('Escape')
  await guest.waitForSelector('td[data-path="/Sheet1/A3"] input', { hidden: true })
  await guest.click('td[data-path="/Sheet1/B3"]')
  await delay(250)
  assert.equal(requests.length, requestsBeforeEscape, 'Escape 后仍发送了 /api/send')
  assert.equal(await cellText(guest, '/Sheet1/A3'), escapeBefore)

  await beginEdit(guest, '/Sheet1/B4')
  const formulaText = await guest.$eval(
    'td[data-path="/Sheet1/B4"] input',
    (input) => (input as HTMLInputElement).value
  )
  assert.ok(formulaText.startsWith('='), '公式单元格编辑器没有显示公式文本')
  await guest.keyboard.press('Escape')

  await beginEdit(guest, '/Sheet1/A2')
  await replaceEditorText(guest, '/Sheet1/A2', '')
  await guest.keyboard.press('Enter')
  await waitForCellText(guest, '/Sheet1/A2', '')

  await beginEdit(guest, '/Sheet1/A1')
  await replaceEditorText(guest, '/Sheet1/A1', '=1/0')
  await guest.keyboard.press('Enter')
  await page.waitForSelector('[data-phi-office-human-edit-failure="formula_invalid"]', {
    visible: true,
    timeout: READY_TIMEOUT_MS
  })
  await waitForCellText(guest, '/Sheet1/A1', 'ManualEnter')

  assert.deepEqual(
    requests.map((body) => JSON.parse(body)),
    [
      { path: '/Sheet1/A1', prop: 'text', value: 'ManualEnter' },
      { path: '/Sheet1/A2', prop: 'text', value: 'ManualTab' },
      { path: '/Sheet1/A2', prop: 'text', value: '' },
      { path: '/Sheet1/A1', prop: 'text', value: '=1/0' }
    ]
  )

  const log = JSON.parse(
    readFileSync(join(dirname(artifact.draftPath), 'operations.json'), 'utf8')
  ) as {
    contentRevision: number
    operations: Record<string, { source?: string; status?: string }>
  }
  assert.equal(log.contentRevision, 3)
  assert.equal(
    Object.values(log.operations).filter((operation) => operation.source === 'human').length,
    4
  )
  const [a1, a2] = await Promise.all([
    readWithOfficeCli(binaryPath, artifact.draftPath, '/Sheet1/A1', environment),
    readWithOfficeCli(binaryPath, artifact.draftPath, '/Sheet1/A2', environment)
  ])
  assert.equal(a1.text, 'ManualEnter')
  // A single-cell get reports a cleared cell as the literal "(empty)"; only range reads carry
  // `format.empty`.
  assert.ok(a2.format?.empty === true || a2.text === '(empty)', '清除后的单元格磁盘上仍有内容')
  await page.screenshot({ path: join(screenshotDir, '02-human-edit-feedback.png') })
}
