import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectSessionRows } from '../../gui-e2e/ui.ts'

export async function focusDesktopSession(page, project, sessionId, changes) {
  const chat = page
    .locator(`[data-phi-chat-session-id=${JSON.stringify(sessionId)}]:visible`)
    .last()
  if (await chat.isVisible()) return chat
  // A fresh tab can briefly render the previous view while the host binds its session UUID.
  if (
    await chat.waitFor({ state: 'visible', timeout: 400 }).then(
      () => true,
      () => false
    )
  )
    return chat
  const from = await page
    .locator('[data-phi-chat-session-id]:visible')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-phi-chat-session-id')))
  const rows = await projectSessionRows(page, project)
  const target = rows.and(page.locator(`[data-phi-session-id=${JSON.stringify(sessionId)}]`))
  await target.first().click({ timeout: 10_000 })
  await chat.waitFor({ state: 'visible', timeout: 10_000 })
  changes?.push({ from, to: sessionId, at: new Date().toISOString() })
  return chat
}

const STRIP = '[data-phi-workspace-resource-tabs]'
const TAB = '[data-phi-workspace-resource-tab]'
const CHROME = '[data-phi-workspace-top-right-chrome]'
const CARD = '[data-agent-card-id]'
const EPSILON = 1

async function showDelegations(chat) {
  const fold = chat.locator('[role="button"][aria-expanded="false"]').filter({
    has: chat.page().locator('[data-phi-outer-fold-chevron]')
  })
  for (let i = 0; i < 20 && (await fold.count()); i++) await fold.first().click()
  await chat.locator(CARD).first().waitFor({ state: 'visible', timeout: 5_000 })
}

async function cardState(chat) {
  return chat.locator(CARD + ':visible').evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute('data-agent-card-id'),
      name: el.querySelector('[title]')?.getAttribute('title'),
      status: el.getAttribute('data-agent-status'),
      loader: Boolean(el.querySelector('[data-phi-agent-run-loader="true"]'))
    }))
  )
}

async function assertCardRows(chat) {
  const cards = await cardState(chat)
  assert(cards.length)
  assert(
    cards.every((c) => c.status === 'done' && !c.loader),
    'A finished delegation still appears to be running'
  )
  const toolRows = await chat
    .locator('[data-phi-tool-call-name]:visible')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-phi-tool-call-name')))
  assert(
    !toolRows.some((name) =>
      name.split(',').some((n) => /^(?:DifferentialExpression|Wrapper)$/i.test(n.trim()))
    ),
    'The ordinary tool row duplicates a delegation card'
  )
  return { cards, ordinaryRows: toolRows }
}

async function geometry(page) {
  return page.evaluate(
    ({ STRIP, TAB, CHROME }) => {
      const strip = document.querySelector(STRIP),
        chrome = document.querySelector(CHROME)
      const active = strip?.querySelector(TAB + '[aria-selected="true"]')
      const buttons = [
        ...(chrome?.querySelectorAll('button[data-phi-workspace-panel-toggle]') ?? [])
      ].filter((e) => e.getBoundingClientRect().width)
      if (!active || !buttons.length) throw new Error('Active tab or panel buttons missing')
      const rect = (e) => {
        const r = e.getBoundingClientRect()
        const actual = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          hit: actual === e || e.contains(actual)
        }
      }
      return {
        width: innerWidth,
        tabs: strip.querySelectorAll(TAB).length,
        strip: rect(strip),
        active: rect(active),
        toolbar: rect(chrome),
        buttons: buttons.map((b) => ({
          name: b.getAttribute('data-phi-workspace-panel-toggle'),
          ...rect(b)
        })),
        sidebar: document
          .querySelector('[data-phi-window-sidebar-toggle-icon]')
          ?.getAttribute('data-phi-window-sidebar-toggle-icon'),
        panel:
          document
            .querySelector('[data-phi-workspace-side-panel-presentation]')
            ?.getAttribute('data-phi-workspace-side-panel-presentation') ?? 'closed',
        selected: active.getAttribute('data-phi-workspace-resource-key')
      }
    },
    { STRIP, TAB, CHROME }
  )
}

export function assertDesktopGeometry(g) {
  assert(g.tabs >= 5, 'Multiple session and child tabs must be open')
  assert(g.strip.right <= g.toolbar.left + EPSILON, 'The tab strip overlaps pinned header controls')
  assert(
    g.active.left >= g.strip.left - EPSILON && g.active.right <= g.strip.right + EPSILON,
    'The selected tab is clipped'
  )
  assert(
    g.active.hit && g.buttons.every((b) => b.hit),
    'Tab or toolbar center click is intercepted'
  )
  assert.deepEqual(g.buttons.map((b) => b.name).sort(), ['browser', 'jobs', 'messages', 'terminal'])
}

export function desktopLayoutCheck({ page, profile, evidenceDir, auditText, resizeContent }) {
  assert(resizeContent, 'The visual acceptance needs a native Electron BrowserWindow')
  async function setWidth(width) {
    await resizeContent(width, await page.evaluate(() => innerHeight))
    await page.waitForFunction((w) => Math.abs(innerWidth - w) <= 2, width, { timeout: 3000 })
  }
  const project = { id: profile.projectId, name: profile.projectName }
  const buffers = new Map()
  const measures = []
  let atQuestion
  async function capture(label, headerOnly = false) {
    auditText(await page.locator('body').innerText(), 'layout screenshot')
    const clip = headerOnly
      ? await page.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: 56 }))
      : undefined
    buffers.set(label, await page.screenshot({ clip, animations: 'disabled' }))
  }
  async function measure(label) {
    // Allow the resize observer to scroll the active tab into view.
    let value, error
    for (let i = 0; i < 15; i++) {
      value = await geometry(page)
      try {
        assertDesktopGeometry(value)
        error = undefined
        break
      } catch (e) {
        error = e
        await page.waitForTimeout(100)
      }
    }
    measures.push({ label, ...value })
    if (error) throw error
    await capture(label, true)
  }
  return {
    async onQuestion({ sessionId, question }) {
      const chat = await focusDesktopSession(page, project, sessionId)
      await showDelegations(chat)
      atQuestion = await assertCardRows(chat)
      assert((await question.isVisible()) && (await question.getByRole('radio').count()) >= 2)
      const card = chat.locator(CARD).first()
      await card.scrollIntoViewIfNeeded()
      await page.waitForFunction(
        (id) => {
          const item = document.querySelector(`[data-agent-card-id="${id}"]`)
          if (!item) return false
          const r = item.getBoundingClientRect()
          return (
            r.height > 20 &&
            item.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
          )
        },
        atQuestion.cards[0].id,
        { timeout: 5000 }
      )
      await capture('layout-parent-awaiting')
    },
    async onCase(kind, result) {
      if (kind !== 'paired' || result.status !== 'passed' || result.rawContentDetected) {
        buffers.clear()
        return
      }
      const sessionId = result.sessionId
      const chat = await focusDesktopSession(page, project, sessionId)
      const initial = await page.evaluate(() => innerWidth)
      try {
        await showDelegations(chat)
        const final = await assertCardRows(chat)
        assert(
          final.cards.some((c) => c.name === 'Wrapper') &&
            final.cards.some((c) => c.name === 'DifferentialExpression')
        )
        const ids = final.cards.map((c) => c.id)
        for (const id of ids) {
          await focusDesktopSession(page, project, sessionId)
          await showDelegations(chat)
          await chat.locator(`[data-agent-card-id=${JSON.stringify(id)}]`).click()
          await page.locator(`[data-phi-subagent-session=${JSON.stringify(id)}]:visible`).waitFor()
        }
        await setWidth(1280)
        await measure('layout-wide')
        const job = page.locator(CHROME + ' [data-phi-workspace-panel-toggle="jobs"]:visible')
        await job.click()
        await page.locator('[data-phi-workspace-side-panel-presentation="dock"]:visible').waitFor()
        await measure('layout-wide-panel')
        await setWidth(900)
        await page
          .locator('[data-phi-workspace-side-panel-presentation="overlay"]:visible')
          .waitFor()
        await measure('layout-narrow-panel')
        await job.click()
        await measure('layout-narrow')
        const sidebar = page.locator('[data-phi-window-sidebar-toggle-icon]:visible')
        await sidebar.click()
        await measure('layout-narrow-sidebar-toggled')
        await sidebar.click()
        for (const [name, buffer] of buffers)
          writeFileSync(join(evidenceDir, name + '.png'), buffer)
        writeFileSync(
          join(evidenceDir, 'layout.json'),
          JSON.stringify({ status: 'passed', atQuestion, final, measures }, null, 2) + '\n'
        )
      } catch (error) {
        writeFileSync(
          join(evidenceDir, 'layout.json'),
          JSON.stringify(
            { status: 'failed', reason: error.message.split('\n')[0], atQuestion, measures },
            null,
            2
          ) + '\n'
        )
        throw error
      } finally {
        buffers.clear()
        await setWidth(initial).catch(() => {})
        await focusDesktopSession(page, project, sessionId)
      }
    }
  }
}
