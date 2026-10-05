import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Page } from 'puppeteer-core'

import { readyTimeoutMs, waitUntil } from './smoke-app-pptx-runtime'
import type { ArtifactRecord } from './smoke-app-deliver-runtime'

const followSelector = 'input[aria-label="跟随 AI"]'

interface SmokeApi {
  office: {
    open(input: { sourcePath: string }): Promise<{
      ok?: boolean
      value?: { state?: string; document?: { artifactId?: string } }
    }>
  }
}

export interface ApplyCommand {
  readonly id: string
  readonly apply: {
    readonly operation: Readonly<Record<string, unknown>>
    readonly baseRevision: number
  }
  readonly delayMs?: number
}

export interface ViewSnapshot {
  readonly activeSheet: string
  readonly scrollTop: number
  readonly scrollLeft: number
}

export function operationRevision(draftPath: string): number {
  const logPath = join(dirname(draftPath), 'operations.json')
  // A draft that has never been written to (blank or freshly imported) has no operation log yet.
  if (!existsSync(logPath)) return 0
  const value = JSON.parse(readFileSync(logPath, 'utf8')) as { contentRevision?: number }
  return value.contentRevision ?? 0
}

export function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export async function startApply(page: Page, command: ApplyCommand): Promise<void> {
  await page.waitForSelector('[data-phi-composer-action="send"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  await page.focus('[data-phi-focus="chat-input"]')
  await page.keyboard.type(JSON.stringify(command))
  await page.click('[data-phi-composer-action="send"]')
}

export async function waitForRevision(draftPath: string, expected: number): Promise<void> {
  await waitUntil(`Office revision ${expected}`, () =>
    operationRevision(draftPath) === expected ? true : null
  )
}

export async function waitForPrompt(page: Page): Promise<void> {
  await page.waitForSelector('[data-phi-composer-action="send"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
}

export async function assertSingleChatSurface(page: Page): Promise<void> {
  const counts = await page.evaluate(() => ({
    split: document.querySelectorAll('[data-phi-chat-artifact-split="enabled"]').length,
    chat: document.querySelectorAll('[data-phi-chat-artifact-pane="chat"]').length,
    composer: document.querySelectorAll('[data-phi-focus="chat-input"]').length
  }))
  assert.equal(counts.composer, 1, 'Office smoke 出现重复输入框')
  assert.equal(counts.split, counts.chat, 'Office smoke 出现半挂载并排视图')
  assert.ok(counts.split <= 1, 'Office smoke 出现重复并排视图')
}

export async function assertFollow(
  page: Page,
  enabled: boolean,
  persisted: string | null
): Promise<void> {
  await page.waitForSelector('[data-phi-office-follow-toggle="true"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  const state = await page.$eval(followSelector, (input) => (input as HTMLInputElement).checked)
  assert.equal(state, enabled)
  assert.equal(await page.evaluate(() => localStorage.getItem('phi.office.followAi.v1')), persisted)
}

export async function setFollow(page: Page, enabled: boolean): Promise<void> {
  const current = await page.$eval(followSelector, (input) => (input as HTMLInputElement).checked)
  if (current !== enabled) await page.click(followSelector)
  await page.waitForFunction(
    (selector, expected) =>
      (document.querySelector<HTMLInputElement>(selector)?.checked ?? null) === expected,
    { timeout: readyTimeoutMs },
    followSelector,
    enabled
  )
  await waitUntil('跟随 AI 偏好持久化', () =>
    page.evaluate(
      (expected) => localStorage.getItem('phi.office.followAi.v1') === String(expected),
      enabled
    )
  )
}

export async function waitForHighlights(guest: Page, expected: readonly string[]): Promise<void> {
  await guest.waitForFunction(
    (paths) => {
      const current = Array.from(document.querySelectorAll<HTMLElement>('td.phi-ai-highlight'))
        .map((cell) => cell.getAttribute('data-path') ?? '')
        .sort()
      return JSON.stringify(current) === JSON.stringify(paths)
    },
    { timeout: readyTimeoutMs },
    [...expected].sort()
  )
}

export async function activeView(guest: Page): Promise<ViewSnapshot> {
  return guest.evaluate(() => {
    const tab = document.querySelector<HTMLElement>('.sheet-tab[role="tab"].active')
    const content = document.querySelector<HTMLElement>('.sheet-content.active[data-sheet]')
    const wrapper = content?.querySelector<HTMLElement>('.table-wrapper')
    return {
      activeSheet: tab?.textContent?.trim() ?? '',
      scrollTop: wrapper?.scrollTop ?? -1,
      scrollLeft: wrapper?.scrollLeft ?? -1
    }
  })
}

export async function activateSheet(guest: Page, sheet: string): Promise<void> {
  await guest.evaluate((name) => {
    const tab = Array.from(document.querySelectorAll<HTMLElement>('.sheet-tab[role="tab"]')).find(
      (candidate) => candidate.textContent?.trim() === name
    )
    if (!tab) throw new Error(`找不到工作表 ${name}`)
    tab.click()
  }, sheet)
  await guest.waitForFunction(
    (name) =>
      document.querySelector<HTMLElement>('.sheet-tab[role="tab"].active')?.textContent?.trim() ===
      name,
    { timeout: readyTimeoutMs },
    sheet
  )
}

export async function setMeaningfulScroll(guest: Page): Promise<ViewSnapshot> {
  const snapshot = await guest.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>(
      '.sheet-content.active[data-sheet] .table-wrapper'
    )
    if (!wrapper) throw new Error('活动工作表缺少滚动容器')
    wrapper.scrollTop = Math.min(320, wrapper.scrollHeight - wrapper.clientHeight)
    wrapper.dispatchEvent(new Event('scroll', { bubbles: true }))
    return {
      activeSheet:
        document.querySelector<HTMLElement>('.sheet-tab[role="tab"].active')?.textContent?.trim() ??
        '',
      scrollTop: wrapper.scrollTop,
      scrollLeft: wrapper.scrollLeft
    }
  })
  assert.equal(snapshot.activeSheet, 'Sheet1')
  assert.ok(snapshot.scrollTop > 0, 'Sheet1 没有形成可验证的滚动位置')
  return snapshot
}

export async function assertFollowTargetVisible(guest: Page, path: string): Promise<void> {
  await guest.waitForFunction(
    (targetPath) => {
      const target = document.querySelector<HTMLElement>(`td[data-path="${targetPath}"]`)
      const wrapper = target
        ?.closest('.sheet-content')
        ?.querySelector<HTMLElement>('.table-wrapper')
      if (!target || !wrapper) return false
      const targetRect = target.getBoundingClientRect()
      const wrapperRect = wrapper.getBoundingClientRect()
      return (
        document.querySelector('.sheet-tab[role="tab"].active')?.textContent?.trim() === 'Sheet2' &&
        wrapper.scrollTop > 0 &&
        targetRect.top >= wrapperRect.top &&
        targetRect.bottom <= wrapperRect.bottom
      )
    },
    { timeout: readyTimeoutMs },
    path
  )
}

export async function openEditor(guest: Page): Promise<void> {
  await activateSheet(guest, 'Sheet1')
  const cell = await guest.waitForSelector('td[data-path="/Sheet1/A1"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  assert.ok(cell)
  await cell.click({ count: 2, delay: 40 })
  const input = await guest.waitForSelector('td[data-path="/Sheet1/A1"] input', {
    visible: true,
    timeout: readyTimeoutMs
  })
  assert.ok(input)
  await input.click({ count: 3 })
  await guest.keyboard.press('Backspace')
  await guest.keyboard.type('manual draft')
}

export async function reopenArtifact(page: Page, artifact: ArtifactRecord): Promise<void> {
  await reopenArtifactInBackend(page, artifact)
  await page.waitForSelector(`[data-phi-office-artifact="${artifact.artifactId}"]`, {
    visible: true,
    timeout: readyTimeoutMs
  })
  await assertSingleChatSurface(page)
}

/** Reopening through the API restores the document without opening a tab for it. */
export async function reopenArtifactInBackend(page: Page, artifact: ArtifactRecord): Promise<void> {
  const result = await page.evaluate(async (sourcePath) => {
    const response = await (window as unknown as { api: SmokeApi }).api.office.open({ sourcePath })
    return {
      ok: response.ok === true,
      state: response.value?.state,
      artifactId: response.value?.document?.artifactId
    }
  }, artifact.draftPath)
  assert.deepEqual(result, { ok: true, state: 'ready', artifactId: artifact.artifactId })
}
