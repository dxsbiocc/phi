import assert from 'node:assert/strict'
import { join } from 'node:path'

import type { Browser, Page } from 'puppeteer-core'

import { officeCliEnv, runOfficeCli } from '../../src/main/agent/office/office-driver'
import { officeChipText } from './smoke-app-prompt'

const READY_TIMEOUT_MS = 60_000

export async function seedSelectionCells(
  binaryPath: string,
  draftPath: string,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  for (const [cell, value] of [
    ['A1', 'A1'],
    ['B1', 'B1'],
    ['A2', 'A2'],
    ['B2', 'B2'],
    ['A3', 'A3'],
    ['B3', 'B3']
  ]) {
    const result = await runOfficeCli(
      binaryPath,
      ['set', draftPath, `/Sheet1/${cell}`, '--prop', `value=${value}`, '--json'],
      {
        timeoutMs: 30_000,
        env: officeCliEnv(environment, { OFFICECLI_RESIDENT_FLUSH: 'each' })
      }
    )
    assert.equal(result.exitCode, 0, `无法写入 smoke 单元格 ${cell}: ${result.stderr}`)
    assert.equal((JSON.parse(result.stdout) as { success?: unknown }).success, true)
  }
}

export async function officeGuest(browser: Browser, page: Page): Promise<Page> {
  const previewUrl = await page.$eval(
    '[data-phi-office-webview="true"]',
    (element) => element.getAttribute('src') ?? ''
  )
  assert.ok(previewUrl, 'Office webview 缺少预览地址')
  const target = await browser.waitForTarget((candidate) => candidate.url() === previewUrl, {
    timeout: READY_TIMEOUT_MS
  })
  const guest = await target.page()
  assert.ok(guest, '无法连接 Office webview CDP target')
  return guest
}

async function dragCells(guest: Page, startPath: string, endPath: string): Promise<void> {
  const start = await guest.waitForSelector(`td[data-path="${startPath}"]`, {
    visible: true,
    timeout: READY_TIMEOUT_MS
  })
  const end = await guest.waitForSelector(`td[data-path="${endPath}"]`, {
    visible: true,
    timeout: READY_TIMEOUT_MS
  })
  const [startBox, endBox] = await Promise.all([start?.boundingBox(), end?.boundingBox()])
  assert.ok(startBox && endBox, '无法读取 Office 单元格坐标')
  await guest.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height / 2)
  await guest.mouse.down({ button: 'left' })
  await guest.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2, {
    steps: 8
  })
  await guest.mouse.up({ button: 'left' })
}

async function waitForChip(page: Page, artifactId: string, expected: string): Promise<void> {
  await page.waitForFunction(
    (selector, text) => document.querySelector(selector)?.textContent?.includes(text) === true,
    { timeout: READY_TIMEOUT_MS },
    `[data-phi-office-target="${artifactId}"]`,
    expected
  )
}

export async function exerciseOfficeSelection(
  browser: Browser,
  page: Page,
  artifactId: string,
  screenshotDir: string
): Promise<void> {
  const guest = await officeGuest(browser, page)
  await guest.waitForSelector('td[data-path="/Sheet1/B3"]', {
    visible: true,
    timeout: READY_TIMEOUT_MS
  })

  await dragCells(guest, '/Sheet1/A1', '/Sheet1/B3')
  await waitForChip(page, artifactId, '选区：Sheet1!A1:B3')
  await page.screenshot({ path: join(screenshotDir, '06-selection-a1-b3.png') })

  await dragCells(guest, '/Sheet1/A2', '/Sheet1/B3')
  await waitForChip(page, artifactId, '选区：Sheet1!A2:B3')
  assert.ok(!(await officeChipText(page, artifactId)).includes('A1:B3'))
  await page.screenshot({ path: join(screenshotDir, '07-selection-a2-b3.png') })

  await page.click(`[data-phi-office-clear-selection="${artifactId}"]`)
  await page.waitForFunction(
    (selector) => !document.querySelector(selector)?.textContent?.includes('选区：'),
    { timeout: READY_TIMEOUT_MS },
    `[data-phi-office-target="${artifactId}"]`
  )
  await page.screenshot({ path: join(screenshotDir, '08-selection-cleared.png') })
}
