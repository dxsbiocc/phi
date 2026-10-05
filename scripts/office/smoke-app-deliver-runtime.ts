import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'

import type { Page } from 'puppeteer-core'

import { readyTimeoutMs, waitUntil } from './smoke-app-pptx-runtime'

export type OfficeKind = 'xlsx' | 'docx' | 'pptx'

interface SmokeApi {
  createProject(name: string, workingDirectory: string, permissionMode: 'auto'): Promise<unknown>
  getCurrentSession(): Promise<{ phiSessionId?: string }>
  listProjectSessions(
    workingDirectory: string
  ): Promise<Array<{ path: string; phiSessionId?: string }>>
  switchSession(path: string): Promise<unknown>
}

export interface ArtifactRecord {
  readonly artifactId: string
  readonly draftPath: string
  readonly kind?: OfficeKind
  readonly sourcePath?: string | null
}

export interface DeliveryRecord {
  readonly outputId: string
  readonly outputPath: string
  readonly revision: number
  readonly sha256: string
  readonly size: number
  readonly kind: OfficeKind
  readonly operationId: string
  readonly warnings: string[]
  readonly checks: Array<{ name: string; status: string; sampled?: number; pageCount?: number }>
}

export function officeArtifacts(officeRoot: string): ArtifactRecord[] {
  if (!existsSync(officeRoot)) return []
  return readdirSync(officeRoot, { withFileTypes: true }).flatMap((entry) => {
    const metadata = join(officeRoot, entry.name, 'artifact.json')
    return entry.isDirectory() && existsSync(metadata)
      ? [JSON.parse(readFileSync(metadata, 'utf8')) as ArtifactRecord]
      : []
  })
}

export function deliveryRecords(draftPath: string): DeliveryRecord[] {
  const value = JSON.parse(readFileSync(join(dirname(draftPath), 'outputs.json'), 'utf8')) as {
    outputs?: DeliveryRecord[]
  }
  return value.outputs ?? []
}

export async function createSmokeProject(page: Page, projectDir: string): Promise<void> {
  await page.evaluate(async (cwd) => {
    await (window as unknown as { api: SmokeApi }).api.createProject(
      'Office Deliver Smoke',
      cwd,
      'auto'
    )
  }, projectDir)
  await page.reload({ waitUntil: 'domcontentloaded' })
}

async function projectVisible(page: Page, projectName: string): Promise<boolean> {
  return page.evaluate(
    (name) =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).some((element) =>
        element.textContent?.includes(name)
      ),
    projectName
  )
}

async function openProjectSidebar(page: Page): Promise<void> {
  if (!(await projectVisible(page, 'Office Deliver Smoke'))) {
    await page.click('[aria-label="项目"]')
  }
  await waitUntil('交付 smoke 项目出现在侧栏', () => projectVisible(page, 'Office Deliver Smoke'))
}

export async function newProjectChat(
  page: Page,
  projectDir: string
): Promise<{ sessionId: string; sessionPath: string }> {
  await openProjectSidebar(page)
  const previous = await page.evaluate(async () =>
    (window as unknown as { api: SmokeApi }).api.getCurrentSession()
  )
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (element) => element.textContent?.includes('Office Deliver Smoke')
    )
    const actions = row?.querySelectorAll<HTMLButtonElement>('button')
    const newChat = actions?.item((actions?.length ?? 0) - 1)
    if (!newChat) throw new Error('找不到项目的新对话动作')
    newChat.click()
  })
  await page.waitForSelector('[data-phi-focus="chat-input"]', { visible: true })
  return waitUntil('交付 smoke 新会话建立', () => currentNewSession(page, projectDir, previous))
}

async function currentNewSession(
  page: Page,
  projectDir: string,
  previous: { phiSessionId?: string }
): Promise<{ sessionId: string; sessionPath: string } | null> {
  return page.evaluate(
    async ({ cwd, previousId }) => {
      const api = (window as unknown as { api: SmokeApi }).api
      const current = await api.getCurrentSession()
      const session = (await api.listProjectSessions(cwd)).find(
        (candidate) => candidate.phiSessionId === current.phiSessionId
      )
      return session?.phiSessionId && session.phiSessionId !== previousId
        ? { sessionId: session.phiSessionId, sessionPath: session.path }
        : null
    },
    { cwd: projectDir, previousId: previous.phiSessionId }
  )
}

export async function createDraft(
  page: Page,
  officeRoot: string,
  kind: OfficeKind,
  draftName: string
): Promise<ArtifactRecord> {
  const known = new Set(officeArtifacts(officeRoot).map((artifact) => artifact.artifactId))
  await page.click(`[data-phi-office-create-kind="${kind}"]`)
  await page.waitForSelector('[data-phi-office-create-dialog="true"]', { visible: true })
  await page.type('[data-phi-office-create-name="true"]', draftName)
  await page.click('[data-phi-office-create-submit="true"]')
  await page.waitForSelector('[data-phi-office-state="ready"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  await assertSingleChatSurface(page)
  const artifact = await waitUntil(`${kind} 草稿登记`, () =>
    officeArtifacts(officeRoot).find((candidate) => !known.has(candidate.artifactId))
  )
  assert.equal(artifact.kind, kind)
  assert.equal(extname(artifact.draftPath), `.${kind}`)
  return artifact
}

async function assertSingleChatSurface(page: Page): Promise<void> {
  const counts = await page.evaluate(() => ({
    split: document.querySelectorAll('[data-phi-chat-artifact-split="enabled"]').length,
    chat: document.querySelectorAll('[data-phi-chat-artifact-pane="chat"]').length,
    composer: document.querySelectorAll('[data-phi-focus="chat-input"]').length
  }))
  // Creating a draft opens the dock panel, not the file-tab split, so the split is absent; what must
  // never happen is a second composer or a half-mounted split.
  assert.equal(counts.composer, 1, '新建 Office 后出现重复对话输入框')
  assert.equal(counts.split, counts.chat, '并排视图只挂载了一半')
  assert.ok(counts.split <= 1, '新建 Office 后出现重复并排视图')
}

export async function sendDeliveryCommand(
  page: Page,
  command: { id: string; outputName: string; apply?: Record<string, unknown> }
): Promise<void> {
  await page.focus('[data-phi-focus="chat-input"]')
  await page.keyboard.type(JSON.stringify(command))
  await page.click('[data-phi-composer-action="send"]')
  await waitForCard(page, command.outputName)
}

export async function waitForCard(page: Page, fileName: string): Promise<string> {
  return waitUntil(`交付卡 ${fileName}`, () =>
    page.evaluate((name) => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>('[data-phi-presented-file-row="true"]')
      ).find((candidate) => candidate.innerText.includes(name))
      return row?.innerText || null
    }, fileName)
  )
}

export async function clickCard(page: Page, fileName: string): Promise<void> {
  await page.evaluate((name) => {
    const row = Array.from(
      document.querySelectorAll<HTMLElement>('[data-phi-presented-file-row="true"]')
    ).find((candidate) => candidate.innerText.includes(name))
    if (!row) throw new Error(`找不到交付卡 ${name}`)
    row.click()
  }, fileName)
}

async function clickSessionRow(page: Page, titleHint: string): Promise<boolean> {
  return page.evaluate((hint) => {
    const row = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (element) => element.textContent?.includes(hint)
    )
    row?.click()
    return Boolean(row)
  }, titleHint)
}

export async function switchSmokeSession(
  page: Page,
  sessionPath: string,
  expectedSessionId: string,
  titleHint: string
): Promise<void> {
  await page.evaluate(async (path) => {
    await (window as unknown as { api: SmokeApi }).api.switchSession(path)
  }, sessionPath)
  await page.reload({ waitUntil: 'domcontentloaded' })
  // A reload lands on the home view, so reopen the session from the project sidebar by its title.
  await page.waitForSelector('[aria-label="项目"]', { visible: true })
  await page.click('[aria-label="项目"]')
  await waitUntil('侧栏出现目标会话', () => clickSessionRow(page, titleHint))
  await page.waitForSelector('[data-phi-focus="chat-input"]', { visible: true })
  const sessionId = await waitUntil('重启会话恢复', async () => {
    const current = await page.evaluate(async () =>
      (window as unknown as { api: SmokeApi }).api.getCurrentSession()
    )
    return current.phiSessionId || null
  })
  assert.equal(sessionId, expectedSessionId)
}

export function transientFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const pending = [root]
  const found: string[] = []
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.name.includes('.phi-') || entry.name.includes('.tmp-')) found.push(path)
    }
  }
  return found
}

export function runtimePids(root: string): number[] | null {
  try {
    return execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes(root))
      .map((line) => Number(/^\s*(\d+)/u.exec(line)?.[1]))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid)
  } catch {
    return null
  }
}
