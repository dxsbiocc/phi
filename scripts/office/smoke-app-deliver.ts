import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { Browser, Page } from 'puppeteer-core'

import {
  cleanOfficeProcesses,
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
import { officeGuest } from './smoke-app-selection'
import {
  clickCard,
  createDraft,
  createSmokeProject,
  deliveryRecords,
  newProjectChat,
  officeArtifacts,
  runtimePids,
  sendDeliveryCommand,
  switchSmokeSession,
  transientFiles,
  waitForCard,
  type ArtifactRecord,
  type DeliveryRecord,
  type OfficeKind
} from './smoke-app-deliver-runtime'

interface DeliverySpec {
  readonly id: string
  readonly kind: OfficeKind
  readonly draftName: string
  readonly outputName: string
  readonly kindLabel: string
  readonly expectedText: string
  readonly apply: Record<string, unknown>
}

interface DeliveredSession {
  readonly sessionId: string
  readonly sessionPath: string
  readonly artifact: ArtifactRecord
  readonly spec: DeliverySpec
  readonly record: DeliveryRecord
  readonly outputPath: string
}

const spreadsheetText = 'O33 Excel 交付内容'
const documentText = 'O33 Word 交付内容 & <重新打开>'
const presentationTitle = `O33 PowerPoint ${'中'.repeat(72)}`
const presentationBody = 'O33 PowerPoint 正文 & <重新打开>'
const specs: readonly DeliverySpec[] = [
  {
    id: 'xlsx',
    kind: 'xlsx',
    draftName: 'O33 Excel 草稿',
    outputName: 'O33-Excel.xlsx',
    kindLabel: 'Excel 表格',
    expectedText: spreadsheetText,
    apply: {
      operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: spreadsheetText },
      baseRevision: 0
    }
  },
  {
    id: 'docx',
    kind: 'docx',
    draftName: 'O33 Word 草稿',
    outputName: 'O33-Word.docx',
    kindLabel: 'Word 文档',
    expectedText: documentText,
    apply: {
      operation: { type: 'add_paragraph', text: documentText, position: 'end' },
      baseRevision: 0
    }
  },
  {
    id: 'pptx',
    kind: 'pptx',
    draftName: 'O33 PowerPoint 草稿',
    outputName: 'O33-PowerPoint.pptx',
    kindLabel: 'PowerPoint 演示文稿',
    expectedText: presentationTitle,
    apply: {
      operation: {
        type: 'add_slide',
        title: presentationTitle,
        body: presentationBody,
        position: 'end'
      },
      baseRevision: 0
    }
  }
]

function verifyOutput(
  projectDir: string,
  artifact: ArtifactRecord,
  spec: DeliverySpec
): { record: DeliveryRecord; outputPath: string } {
  const record = deliveryRecords(artifact.draftPath).find(
    (candidate) => candidate.outputPath === spec.outputName
  )
  assert.ok(record, `outputs.json 缺少 ${spec.outputName}`)
  const outputPath = join(projectDir, record.outputPath)
  assert.equal(realpathSync(outputPath), realpathSync(join(projectDir, spec.outputName)))
  assert.notEqual(realpathSync(outputPath), realpathSync(artifact.draftPath))
  assert.notEqual(
    statSync(outputPath).ino,
    statSync(artifact.draftPath).ino,
    '交付文件是草稿硬链接'
  )
  assert.equal(lstatSync(outputPath).isSymbolicLink(), false)
  assert.equal(record.sha256, createHash('sha256').update(readFileSync(outputPath)).digest('hex'))
  assert.equal(record.size, statSync(outputPath).size)
  assert.equal(record.kind, spec.kind)
  assert.equal(record.revision, 1)
  assert.ok(record.checks.some((check) => check.name === 'schema' && check.status === 'passed'))
  const content = record.checks.find((check) => check.name === `${spec.kind}_content`)
  assert.equal(content?.sampled, 1)
  if (spec.kind === 'pptx') {
    assert.equal(content?.pageCount, 1)
    assert.ok(record.warnings.includes('text_may_overflow'))
  }
  return { record, outputPath }
}

async function firstLaunch(paths: SmokePaths, running: RunningApp[]): Promise<DeliveredSession[]> {
  const app = await launch(paths)
  running.push(app)
  await createSmokeProject(app.page, paths.projectDir)
  const delivered: DeliveredSession[] = []
  for (const spec of specs) {
    const session = await newProjectChat(app.page, paths.projectDir)
    const officeRoot = join(paths.agentDir, 'sessions', session.sessionId, 'artifacts', 'office')
    const artifact = await createDraft(app.page, officeRoot, spec.kind, spec.draftName)
    await sendDeliveryCommand(app.page, {
      id: `${spec.id}-primary`,
      outputName: spec.outputName,
      apply: spec.apply
    })
    const output = verifyOutput(paths.projectDir, artifact, spec)
    const card = await waitForCard(app.page, spec.outputName)
    assert.ok(card.includes(spec.kindLabel), `${spec.kind} 交付卡缺少类型文案`)
    if (spec.kind === 'pptx') assert.ok(card.includes('文本可能溢出'))
    delivered.push({ ...session, artifact, spec, ...output })
    if (spec.kind === 'xlsx') {
      await sendDeliveryCommand(app.page, {
        id: 'xlsx-tamper',
        outputName: 'O33-被篡改.xlsx'
      })
    }
  }
  assert.equal(
    await app.page.$$eval('[data-phi-presented-file-row="true"]', (rows) => rows.length),
    1,
    '当前 PPTX 会话应只有一张交付卡'
  )
  await closeNormally(app)
  return delivered
}

async function assertPreview(
  browser: Browser,
  page: Page,
  delivery: DeliveredSession
): Promise<void> {
  const guest = await officeGuest(browser, page)
  if (delivery.spec.kind === 'xlsx') {
    await guest.waitForFunction(
      (text) => document.querySelector('td[data-path="/Sheet1/A1"]')?.textContent === text,
      { timeout: readyTimeoutMs },
      delivery.spec.expectedText
    )
    return
  }
  if (delivery.spec.kind === 'docx') {
    await guest.waitForFunction(
      (text) => document.querySelector('.page-body')?.textContent?.includes(text) === true,
      { timeout: readyTimeoutMs },
      delivery.spec.expectedText
    )
    return
  }
  await guest.waitForFunction(
    (text) =>
      document.querySelector('.slide-container[data-slide="1"]')?.textContent?.includes(text),
    { timeout: readyTimeoutMs },
    delivery.spec.expectedText
  )
  await guest.waitForSelector('.thumb[data-slide="1"]', { timeout: readyTimeoutMs })
}

async function openValidDelivery(
  app: RunningApp,
  paths: SmokePaths,
  delivery: DeliveredSession
): Promise<void> {
  await switchSmokeSession(
    app.page,
    delivery.sessionPath,
    delivery.sessionId,
    `"id":"${delivery.spec.id}-primary"`
  )
  const card = await waitForCard(app.page, delivery.spec.outputName)
  assert.ok(card.includes(delivery.spec.kindLabel))
  await clickCard(app.page, delivery.spec.outputName)
  await app.page.waitForSelector('[data-phi-office-state="ready"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  const officeRoot = join(paths.agentDir, 'sessions', delivery.sessionId, 'artifacts', 'office')
  const opened = await waitUntil(`${delivery.spec.kind} 交付输出登记为有源草稿`, () =>
    officeArtifacts(officeRoot).find(
      (artifact) => artifact.sourcePath === realpathSync(delivery.outputPath)
    )
  )
  assert.equal(realpathSync(opened.sourcePath!), realpathSync(delivery.outputPath))
  assert.notEqual(realpathSync(opened.draftPath), realpathSync(delivery.artifact.draftPath))
  await assertPreview(app.browser, app.page, delivery)
}

async function assertTamperedEntryFails(
  page: Page,
  paths: SmokePaths,
  delivery: DeliveredSession
): Promise<void> {
  await switchSmokeSession(
    page,
    delivery.sessionPath,
    delivery.sessionId,
    `"id":"${delivery.spec.id}-primary"`
  )
  const tamperedPath = join(paths.projectDir, 'O33-被篡改.xlsx')
  appendFileSync(tamperedPath, Buffer.from('tampered-after-restart'))
  await clickCard(page, basename(tamperedPath))
  const text = await waitUntil('篡改后的交付入口失效', () =>
    page.evaluate((name) => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>('[data-phi-presented-file-row="true"]')
      ).find((candidate) => candidate.innerText.includes(name))
      return row?.innerText.includes('Office 输出已被更改，交付入口已失效') ? row.innerText : null
    }, basename(tamperedPath))
  )
  assert.match(text, /交付文件已失效/u)
}

async function secondLaunch(
  paths: SmokePaths,
  running: RunningApp[],
  delivered: DeliveredSession[]
): Promise<void> {
  const app = await launch(paths)
  running.push(app)
  const xlsx = delivered.find((entry) => entry.spec.kind === 'xlsx')!
  await assertTamperedEntryFails(app.page, paths, xlsx)
  for (const delivery of delivered) await openValidDelivery(app, paths, delivery)
  await closeNormally(app)
}

function smokePaths(runtimeRoot: string): SmokePaths {
  return {
    homeDir: join(runtimeRoot, 'home'),
    agentDir: join(runtimeRoot, 'home', '.phi'),
    projectDir: join(runtimeRoot, 'project'),
    userDataDir: join(runtimeRoot, 'electron-user-data'),
    saveAsPath: join(runtimeRoot, 'project', 'unused-save-as.xlsx'),
    screenshotDir: join(runtimeRoot, 'screenshots'),
    ompWorkerPath: join(repoRoot, 'scripts', 'office', 'smoke-app-deliver-worker.mjs')
  }
}

async function main(): Promise<void> {
  assert.ok(existsSync(join(repoRoot, 'out', 'main', 'index.mjs')), '请先构建 Electron 应用')
  assert.ok(existsSync(electronPath), 'Electron 可执行入口不存在')
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'phi-office-deliver-app-smoke-'))
  const paths = smokePaths(runtimeRoot)
  for (const path of [paths.agentDir, paths.projectDir, paths.userDataDir, paths.screenshotDir]) {
    mkdirSync(path, { recursive: true })
  }
  writeFileSync(join(paths.agentDir, 'onboarding.json'), '{"onboarded":true}\n')
  const running: RunningApp[] = []
  try {
    const delivered = await firstLaunch(paths, running)
    await secondLaunch(paths, running, delivered)
    assert.deepEqual(transientFiles(paths.projectDir), [], '项目目录残留 Office 临时输出')
    assert.deepEqual(transientFiles(join(paths.agentDir, 'sessions')), [], '会话目录残留临时文件')
    const initialPids = runtimePids(runtimeRoot)
    if (initialPids === null) {
      process.stderr.write('Office deliver smoke：ps 不可用，无法独立核对进程与监听端口。\n')
    } else {
      const pids = await waitUntil('Electron/Office 进程退出', () => {
        const current = runtimePids(runtimeRoot)
        return current?.length === 0 ? current : null
      })
      assert.deepEqual(pids, [])
    }
    process.stdout.write(
      `OFFICE_APP_DELIVER_SMOKE_RESULT ${JSON.stringify({ kinds: delivered.map((item) => item.spec.kind), restartCount: 2, tamperRejected: true })}\n`
    )
  } catch (error) {
    const logs = running
      .map((app) => app.logs().trim())
      .filter(Boolean)
      .join('\n')
    if (logs) process.stderr.write(`Electron 输出（末尾）：\n${logs}\n`)
    throw error
  } finally {
    for (const app of running) {
      app.browser.disconnect()
      await stopChild(app.child)
    }
    await cleanOfficeProcesses(runtimeRoot).finally(() =>
      rmSync(runtimeRoot, { recursive: true, force: true })
    )
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
