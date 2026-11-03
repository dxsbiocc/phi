import type { Locator, Page } from 'playwright-core'

import type { DryRunProbe, RemoteProject } from './types'

const PROJECT_ROW = '[data-phi-project-row="true"]'
const SESSION_ROW = '[data-phi-session-row]'
const CHAT_EDITOR = '[data-phi-chat-placement] [data-phi-composer-editor] [role="textbox"]'
const HOME_EDITOR = '[data-phi-home-prompt] [data-phi-composer-editor] [role="textbox"]'
const SEND_BUTTON = '[data-phi-composer-action="send"]'
const MODE_TRIGGER =
  '[data-testid="gui-e2e-session-mode-trigger"], form button[aria-describedby]:not([data-phi-model-thinking])'
const VISIBLE_OVERLAY = '.MuiPopover-root:visible, .MuiModal-root:visible, [role="dialog"]:visible'
const MAX_OVERLAY_DISMISS_ATTEMPTS = 8

function projectsNavigation(page: Page): Locator {
  return page.locator('.app-activity-bar > button').nth(1)
}

function filesNavigation(page: Page): Locator {
  return page.locator('.app-activity-bar > button').nth(2)
}

async function visibleProjectRow(page: Page, projectId: string): Promise<Locator | undefined> {
  const rows = page.locator(`${PROJECT_ROW}:visible`)
  for (let index = 0; index < (await rows.count()); index += 1) {
    const row = rows.nth(index)
    if ((await row.getAttribute('data-phi-project-id')) === projectId) return row
  }
  return undefined
}

async function waitForVisibleProjectRow(
  page: Page,
  projectId: string
): Promise<Locator | undefined> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const row = await visibleProjectRow(page, projectId)
    if (row) return row
    await page.waitForTimeout(50)
  }
  return undefined
}

async function projectRow(page: Page, project: RemoteProject): Promise<Locator> {
  let row = await visibleProjectRow(page, project.id)
  if (!row) {
    await projectsNavigation(page).click()
    row = await waitForVisibleProjectRow(page, project.id)
  }
  if (!row) throw new Error(`Project row not found for id ${project.id}`)
  await row.waitFor({ state: 'visible', timeout: 15_000 })
  return row
}

export async function hoverProjectRow(page: Page, project: RemoteProject): Promise<void> {
  await (await projectRow(page, project)).hover()
}

export async function dismissUiOverlays(
  page: Page,
  maxAttempts = MAX_OVERLAY_DISMISS_ATTEMPTS
): Promise<boolean> {
  const overlays = page.locator(VISIBLE_OVERLAY)
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if ((await overlays.count()) === 0) return true
    await page.keyboard.press('Escape')
    await page.waitForTimeout(50)
  }
  return (await overlays.count()) === 0
}

async function newProjectSessionButton(row: Locator): Promise<Locator> {
  const stable = row.locator('[data-testid="gui-e2e-new-project-session"]')
  if ((await stable.count()) > 0) return stable
  return row.locator('button').last()
}

async function waitForProjectHomeScope(prompt: Locator, project: RemoteProject): Promise<void> {
  const scope = prompt.locator('[data-phi-home-project-id]').first()
  const deadline = Date.now() + 15_000
  let actual: string | null = null
  while (Date.now() < deadline) {
    actual = await scope.getAttribute('data-phi-home-project-id').catch(() => null)
    if (actual === project.id) return
    await prompt.page().waitForTimeout(50)
  }
  throw new Error(
    `Project home scope mismatch: expected ${project.name} (${project.id}), got ${actual || 'no project'}; refusing to submit prompt`
  )
}

export async function openProjectHome(page: Page, project: RemoteProject): Promise<void> {
  const row = await projectRow(page, project)
  await row.hover()
  await (await newProjectSessionButton(row)).click({ force: true })
  const prompt = page.locator('[data-phi-home-prompt="true"]:visible').last()
  await prompt.waitFor({ state: 'visible', timeout: 15_000 })
  await waitForProjectHomeScope(prompt, project)
}

export async function selectModel(page: Page, model: string): Promise<void> {
  const trigger = page.locator('[data-phi-model-thinking="true"]:visible').last()
  await trigger.click()
  const popover = page.locator('.MuiPopover-root:visible').last()
  await popover.waitFor({ state: 'visible', timeout: 10_000 })
  const search = popover
    .locator('input:not([type]), input[type="text"], input[type="search"]')
    .first()
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(model)
  // Models sit in collapsed provider groups; a search narrows the groups but may not open them.
  const collapsed = popover.locator('.MuiAccordionSummary-root[aria-expanded="false"]')
  for (let attempt = 0; attempt < 8 && (await collapsed.count()) > 0; attempt += 1) {
    await collapsed.first().click()
  }
  const option = popover
    .locator('.MuiListItemText-primary')
    .getByText(model, { exact: true })
    .first()
  await option.waitFor({ state: 'attached', timeout: 10_000 }).catch(async () => {
    const shown = await popover
      .locator('.MuiListItemText-primary, .MuiAccordionSummary-root')
      .allTextContents()
    throw new Error(`Model "${model}" not listed; picker shows: ${shown.join(', ').slice(0, 240)}`)
  })
  // The group may still be animating open; a DOM click selects it, and the label check below
  // confirms the right model was chosen.
  await option.evaluate((element) =>
    (element.closest('.MuiListItemButton-root') as HTMLElement | null)?.click()
  )
  await page.keyboard.press('Escape')
  await popover.waitFor({ state: 'hidden', timeout: 10_000 })
  if ((await page.locator('.MuiPopover-root:visible').count()) > 0) {
    throw new Error('Model picker remained open after selection')
  }
  await verifySelectedModelLabel(trigger, model)
}

async function verifySelectedModelLabel(trigger: Locator, model: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const [label, text] = await Promise.all([
      trigger.getAttribute('aria-label'),
      trigger.textContent()
    ])
    if (label?.includes(model) || text?.includes(model)) return
    await trigger.page().waitForTimeout(50)
  }
  throw new Error(`Selected model label did not update to ${model}`)
}

async function fillEditor(editor: Locator, prompt: string): Promise<void> {
  await editor.waitFor({ state: 'visible', timeout: 15_000 })
  await editor.fill(prompt)
}

export async function submitHomePrompt(page: Page, prompt: string, model: string): Promise<void> {
  await selectModel(page, model)
  await fillEditor(page.locator(HOME_EDITOR), prompt)
  await page.locator(`[data-phi-home-send="true"]${SEND_BUTTON}`).click()
  await page.locator('[data-phi-chat-placement]').waitFor({ state: 'visible', timeout: 30_000 })
}

export async function submitChatPrompt(page: Page, prompt: string): Promise<void> {
  await fillEditor(page.locator(CHAT_EDITOR).last(), prompt)
  await page.locator(`[data-phi-chat-placement] ${SEND_BUTTON}`).last().click()
}

async function expandProject(row: Locator): Promise<void> {
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click()
  await row.page().waitForTimeout(250)
}

export async function projectSessionRows(page: Page, project: RemoteProject): Promise<Locator> {
  const row = await projectRow(page, project)
  await expandProject(row)
  return row.locator('xpath=..').locator(SESSION_ROW)
}

export async function selectProjectSession(
  page: Page,
  project: RemoteProject,
  index: number
): Promise<void> {
  const rows = await projectSessionRows(page, project)
  const target = rows.nth(index)
  await target.waitFor({ state: 'visible', timeout: 15_000 })
  await target.click()
  await page.locator('[data-phi-chat-placement]').waitFor({ state: 'visible', timeout: 30_000 })
}

export async function selectPlanMode(page: Page): Promise<{ trigger: string; option: string }> {
  const trigger = page.locator(MODE_TRIGGER).last()
  if ((await trigger.count()) === 0) {
    const fallback = page
      .locator('form button[aria-describedby]:not([data-phi-model-thinking])')
      .first()
    await fallback.click()
  } else {
    await trigger.click()
  }
  const stableOption = page.locator('[data-testid="gui-e2e-session-mode-plan"]:visible')
  const option =
    (await stableOption.count()) > 0 ? stableOption : page.locator('ul[role="list"] > *').nth(2)
  await option.click()
  const activeTrigger =
    (await trigger.count()) > 0 ? trigger : page.locator('form button[aria-describedby]').first()
  const triggerColor = await activeTrigger.evaluate((element) => getComputedStyle(element).color)
  await activeTrigger.click()
  const reopened =
    (await stableOption.count()) > 0 ? stableOption : page.locator('ul[role="list"] > *').nth(2)
  const optionColor = await reopened
    .locator('.MuiListItemText-primary')
    .evaluate((element) => getComputedStyle(element).color)
  if (!(await dismissUiOverlays(page))) throw new Error('Session mode menu did not close')
  return { trigger: triggerColor, option: optionColor }
}

export async function approvePlanReview(
  page: Page
): Promise<{ reviewShown: boolean; planVisible: boolean }> {
  const review = page.locator('[data-testid="gui-e2e-plan-review"]:visible').last()
  await review.waitFor({ state: 'visible', timeout: 180_000 })
  const content = review.locator('[data-testid="gui-e2e-plan-review-content"]')
  await content.waitFor({ state: 'visible', timeout: 10_000 })
  const planVisible = (await content.innerText()).trim().length > 0
  if (!planVisible) throw new Error('Plan review appeared without visible plan text')
  await review.locator('[data-testid="gui-e2e-plan-review-approve"]').click()
  await review.waitFor({ state: 'hidden', timeout: 10_000 })
  return { reviewShown: true, planVisible }
}

export async function openAndCloseSessionModeMenu(page: Page): Promise<boolean> {
  const trigger = page.locator(MODE_TRIGGER).last()
  await trigger.waitFor({ state: 'visible', timeout: 10_000 })
  await trigger.click()
  const option = page.locator('[data-testid="gui-e2e-session-mode-plan"]:visible')
  await option.waitFor({ state: 'visible', timeout: 10_000 })
  return await dismissUiOverlays(page)
}

export async function clickLastFork(page: Page): Promise<void> {
  const stable = page.locator('[data-testid="gui-e2e-fork-message"]')
  const button =
    (await stable.count()) > 0
      ? stable.last()
      : page.locator('[data-phi-user-message-actions] button').last()
  await button.scrollIntoViewIfNeeded()
  await button.click({ force: true })
  await page.waitForTimeout(250)
}

export async function clickApproval(page: Page, approved: boolean): Promise<string> {
  const alert = page.locator('[data-testid="gui-e2e-tool-approval"], [role="alert"]').last()
  await alert.waitFor({ state: 'visible', timeout: 30_000 })
  const summary = (await alert.innerText()).slice(0, 500)
  const testId = approved ? 'gui-e2e-approval-approve' : 'gui-e2e-approval-deny'
  const stable = alert.locator(`[data-testid="${testId}"]`)
  const buttons = alert.getByRole('button')
  const fallbackIndex = Math.max(0, (await buttons.count()) - (approved ? 1 : 2))
  const button = (await stable.count()) > 0 ? stable : buttons.nth(fallbackIndex)
  await button.click()
  return summary
}

/** Denies an approval request if one is showing; does nothing otherwise. */
export async function denyPendingApproval(page: Page): Promise<void> {
  const alert = page.locator('[data-testid="gui-e2e-tool-approval"]:visible').last()
  if ((await alert.count()) === 0) return
  await alert
    .locator('[data-testid="gui-e2e-approval-deny"]')
    .click({ timeout: 2_000 })
    .catch(() => undefined)
}

export function connectionProgressVisible(page: Page): Promise<boolean> {
  return page
    .locator('body')
    .innerText()
    .then((text) =>
      /(connecting|deploying|opening notebook|正在连接|正在部署|正在打开 notebook)/i.test(text)
    )
}

export async function listNotebooks(
  page: Page,
  cwd: string
): Promise<Array<{ path: string; name: string; relativePath?: string }>> {
  return await page.evaluate(async (projectCwd) => {
    const api = (
      window as unknown as {
        api: {
          listAnalysisNotebooks: (
            value: string
          ) => Promise<{ notebooks?: Array<{ path: string; name: string; relativePath?: string }> }>
        }
      }
    ).api
    return (await api.listAnalysisNotebooks(projectCwd)).notebooks ?? []
  }, cwd)
}

export async function openNotebookFromFiles(page: Page, notebookName: string): Promise<void> {
  await filesNavigation(page).click()
  const tree = page.locator('[aria-label] [data-phi-file-tree-root="true"]').last()
  await tree.waitFor({ state: 'visible', timeout: 30_000 })
  if ((await tree.getAttribute('aria-expanded')) !== 'true') await tree.click()
  const notebooksDirectory = page
    .locator('[data-phi-file-path]')
    .filter({ hasText: 'notebooks' })
    .first()
  if ((await notebooksDirectory.count()) > 0) await notebooksDirectory.click()
  const notebook = page.locator('[data-phi-file-path]').filter({ hasText: notebookName }).first()
  await notebook.waitFor({ state: 'visible', timeout: 30_000 })
  await notebook.click()
  await page
    .locator('[data-phi-notebook-virtual-list="true"]')
    .waitFor({ state: 'visible', timeout: 30_000 })
}

export async function probeDryRunSelectors(page: Page): Promise<DryRunProbe[]> {
  const probes: Array<[string, string, boolean]> = [
    ['home prompt', '[data-phi-home-prompt="true"]', true],
    ['composer editor', '[data-phi-composer-editor="codemirror"]', true],
    ['send action', '[data-phi-composer-action="send"]', true],
    ['model selector', '[data-phi-model-thinking="true"]', true],
    ['session mode trigger', MODE_TRIGGER, true],
    ['project row', PROJECT_ROW, false],
    ['session row', SESSION_ROW, false],
    ['fork action', '[data-testid="gui-e2e-fork-message"]', false],
    ['approval', '[data-testid="gui-e2e-tool-approval"]', false],
    ['plan review', '[data-testid="gui-e2e-plan-review"]', false],
    ['tool call status', '[data-testid="gui-e2e-tool-call"]', false],
    ['home project scope', '[data-phi-home-project-id]', true],
    ['notebook canvas', '[data-phi-notebook-virtual-list="true"]', false]
  ]
  const results: DryRunProbe[] = []
  for (const [name, selector, required] of probes) {
    const found = (await page.locator(selector).count()) > 0
    results.push({ name, selector, state: found ? 'found' : required ? 'missing' : 'dynamic' })
  }
  return results
}
