import assert from 'node:assert/strict'

import type { Page } from 'puppeteer-core'

const SEND_BUTTON = '[data-phi-composer-action="send"]'
const COMPOSER = '[data-phi-focus="chat-input"]'
const PROVIDER_PROMPT_TIMEOUT_MS = 5_000

export async function officeChipText(page: Page, artifactId: string): Promise<string> {
  return page.$eval(
    `[data-phi-office-target="${artifactId}"]`,
    (element) => element.textContent ?? ''
  )
}

async function replaceComposerText(page: Page, text: string): Promise<void> {
  await page.focus(COMPOSER)
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.down(modifier)
  await page.keyboard.press('A')
  await page.keyboard.up(modifier)
  await page.keyboard.type(text)
}

/**
 * The isolated smoke profile has no model provider, so sending navigates to the provider
 * settings view before any IPC (existing behaviour). The preload API is a frozen contextBridge object a
 * page cannot wrap, so what is observable here is that the send was stopped by readiness, no
 * Office error surfaced, and the associated document chip survived. Target binding, cross-session
 * rejection, and missing-target refusal are covered by the real-service integration tests.
 */
export async function assertSendStoppedByReadiness(page: Page, artifactId: string): Promise<void> {
  await replaceComposerText(page, 'O05 固定第一份草稿')
  await page.click(SEND_BUTTON)
  await page.waitForFunction(() => document.body.innerText.includes('尚未配置任何 Provider'), {
    timeout: PROVIDER_PROMPT_TIMEOUT_MS
  })
  const body = await page.evaluate(() => document.body.innerText)
  assert.ok(!body.includes('关联的 Office 文档'), '发送被 readiness 拦截时不应出现 Office 错误')
  // Sending without a provider navigates to the settings view; return with the app's own
  // history control (the visible ×/−/⤢ glyphs are the macOS window controls, not a dialog).
  await page.click('[aria-label="后退"]')
  await page.waitForFunction(() => !document.body.innerText.includes('尚未配置任何 Provider'), {
    timeout: PROVIDER_PROMPT_TIMEOUT_MS
  })
  await page.waitForSelector(`[data-phi-office-target="${artifactId}"]`, { visible: true })
}
