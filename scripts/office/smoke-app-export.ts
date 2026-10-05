import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Page } from 'puppeteer-core'

import { parseOfficeDelimitedBytes } from '../../src/main/agent/office/office-import-csv'
import {
  cleanOfficeProcesses,
  closeNormally,
  electronPath,
  readyTimeoutMs,
  repoRoot,
  stopChild,
  waitUntil,
  type RunningApp
} from './smoke-app-pptx-runtime'
import { launchExport, type ExportSmokePaths } from './smoke-app-export-runtime'
import {
  activateSheet,
  operationRevision,
  startApply,
  waitForRevision
} from './smoke-app-highlight-runtime'
import { officeGuest } from './smoke-app-selection'
import {
  createSmokeProject,
  newProjectChat,
  officeArtifacts,
  runtimePids,
  transientFiles,
  type ArtifactRecord
} from './smoke-app-deliver-runtime'

const fixtureName = 'o25-export-source.csv'
const csvName = 'o25-current-sheet.csv'
const tsvName = 'o26-current-sheet.tsv'
const latestValue = 'latest-manual-edit'
const otherSheetValue = 'MUST_NOT_LEAK_FROM_OTHER_SHEET'
const expectedValues = [
  [latestValue, '含,逗号', '他说 "你好"'],
  ['第一行\n第二行', '中文😀', '=SUM(A1)'],
  ['007', '', '含\t制表符']
] as const

interface ExportRecord {
  readonly outputId: string
  readonly outputPath: string
  readonly revision: number
  readonly sha256: string
  readonly size: number
  readonly source: 'draft'
  readonly requestId: string
  readonly format: 'csv' | 'tsv'
  readonly sheet: string
  readonly rows: number
  readonly columns: number
}

interface OutputLog {
  readonly version: number
  readonly outputs: readonly ExportRecord[]
}

interface ExportSession {
  readonly revision: number
  readonly outputLogPath: string
  readonly outputLogHash: string
}

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path))
}

function csvField(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function fixtureValues(): readonly (readonly string[])[] {
  return expectedValues.map((row, rowIndex) =>
    row.map((value, columnIndex) => (rowIndex === 0 && columnIndex === 0 ? 'before-edit' : value))
  )
}

function writeFixture(projectDir: string): void {
  const path = join(projectDir, fixtureName)
  const body = fixtureValues()
    .map((row) => row.map(csvField).join(','))
    .join('\n')
  writeFileSync(path, body)
}

async function openFixture(page: Page): Promise<void> {
  await page.click('[aria-label="文件"]')
  await page.waitForSelector('[aria-label="项目目录树"]', { visible: true })
  const selector = `[data-phi-file-kind="csv"][title="${fixtureName}"]`
  await page.waitForSelector(selector, { visible: true, timeout: readyTimeoutMs })
  await page.click(selector)
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  await page.click(selector, { count: 2, delay: 60 })
  await page.waitForSelector('[data-phi-office-import-button="true"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
}

async function importFixture(app: RunningApp, officeRoot: string): Promise<ArtifactRecord> {
  const known = new Set(officeArtifacts(officeRoot).map((artifact) => artifact.artifactId))
  await openFixture(app.page)
  await app.page.click('[data-phi-office-import-button="true"]')
  await app.page.waitForSelector('[data-phi-office-state="ready"]', {
    visible: true,
    timeout: 120_000
  })
  const artifact = await waitUntil('导出 smoke 的 XLSX 草稿登记', () =>
    officeArtifacts(officeRoot).find((candidate) => !known.has(candidate.artifactId))
  )
  assert.equal(artifact.kind, 'xlsx')
  return artifact
}

async function applyOperation(
  page: Page,
  artifact: ArtifactRecord,
  id: string,
  operation: Readonly<Record<string, unknown>>
): Promise<number> {
  const revision = operationRevision(artifact.draftPath)
  await startApply(page, { id, apply: { operation, baseRevision: revision } })
  await waitForRevision(artifact.draftPath, revision + 1)
  return revision + 1
}

async function makeWorkbookMultiSheet(page: Page, artifact: ArtifactRecord): Promise<void> {
  await applyOperation(page, artifact, 'export-add-sheet', { type: 'add_sheet', name: 'Other' })
  await applyOperation(page, artifact, 'export-seed-other', {
    type: 'set_cell',
    sheet: 'Other',
    cell: 'A1',
    value: otherSheetValue
  })
}

async function editLatestValue(app: RunningApp, artifact: ArtifactRecord): Promise<number> {
  const guest = await officeGuest(app.browser, app.page)
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
  await guest.keyboard.type(latestValue)
  const revision = operationRevision(artifact.draftPath) + 1
  await guest.keyboard.press('Enter')
  await waitForRevision(artifact.draftPath, revision)
  await guest.waitForFunction(
    (value) => document.querySelector('td[data-path="/Sheet1/A1"]')?.textContent === value,
    { timeout: readyTimeoutMs },
    latestValue
  )
  await guest.click('td[data-path="/Sheet1/A1"]')
  await app.page.waitForFunction(
    () => {
      const menu = document.querySelector<HTMLElement>('[data-phi-office-export-menu="true"]')
      const button = document.querySelector<HTMLButtonElement>('[data-phi-office-export-csv]')
      return menu?.innerText.includes('当前工作表：Sheet1') === true && button?.disabled === false
    },
    { timeout: readyTimeoutMs }
  )
  return revision
}

async function clickExport(page: Page, format: 'csv' | 'tsv'): Promise<void> {
  await page.click(`[data-phi-office-export-${format}]`)
  await page.waitForFunction(
    (label) =>
      document
        .querySelector<HTMLElement>('[data-phi-office-export-success="true"]')
        ?.innerText.includes(`已导出 ${label.toUpperCase()}：Sheet1`) === true,
    { timeout: readyTimeoutMs },
    format
  )
}

function readOutputLog(path: string): OutputLog {
  return JSON.parse(readFileSync(path, 'utf8')) as OutputLog
}

function verifyDelimited(path: string, format: 'csv' | 'tsv'): void {
  const bytes = readFileSync(path)
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${format} 不应写 BOM`)
  const parsed = parseOfficeDelimitedBytes(bytes, format)
  assert.equal(parsed.rows, 3)
  assert.equal(parsed.columns, 3)
  assert.deepEqual(parsed.values, expectedValues)
  assert.ok(!bytes.includes(Buffer.from(otherSheetValue)), `${format} 混入了未选中的工作表`)
}

function verifyRecord(
  record: ExportRecord,
  projectDir: string,
  targetPath: string,
  revision: number,
  format: 'csv' | 'tsv'
): void {
  assert.equal(record.format, format)
  assert.equal(record.sheet, 'Sheet1')
  assert.equal(record.rows, 3)
  assert.equal(record.columns, 3)
  assert.equal(record.revision, revision)
  assert.equal(record.source, 'draft')
  assert.equal(realpathSync(join(projectDir, record.outputPath)), realpathSync(targetPath))
  assert.equal(record.sha256, sha256File(targetPath))
  assert.equal(record.size, statSync(targetPath).size)
}

async function exportBoth(
  page: Page,
  paths: ExportSmokePaths,
  artifact: ArtifactRecord,
  revision: number
): Promise<ExportSession> {
  await clickExport(page, 'csv')
  verifyDelimited(paths.exportCsvPath, 'csv')
  await clickExport(page, 'tsv')
  verifyDelimited(paths.exportTsvPath, 'tsv')
  const outputLogPath = join(dirname(artifact.draftPath), 'outputs.json')
  const log = readOutputLog(outputLogPath)
  const csv = log.outputs.find((record) => record.format === 'csv')
  const tsv = log.outputs.find((record) => record.format === 'tsv')
  assert.ok(csv && tsv, 'outputs.json 缺少 CSV/TSV 导出记录')
  assert.equal(log.outputs.length, 2)
  verifyRecord(csv, paths.projectDir, paths.exportCsvPath, revision, 'csv')
  verifyRecord(tsv, paths.projectDir, paths.exportTsvPath, revision, 'tsv')
  const csvHash = sha256File(paths.exportCsvPath)
  await page.click('[data-phi-office-export-csv]')
  await page.waitForSelector('[data-phi-office-export-error="target_exists"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  assert.equal(sha256File(paths.exportCsvPath), csvHash, 'target_exists 改写了现有 CSV')
  assert.equal(readOutputLog(outputLogPath).outputs.length, 2, '失败导出被写入 outputs.json')
  return { revision, outputLogPath, outputLogHash: sha256File(outputLogPath) }
}

async function firstLaunch(paths: ExportSmokePaths, running: RunningApp[]): Promise<ExportSession> {
  const app = await launchExport(paths)
  running.push(app)
  await createSmokeProject(app.page, paths.projectDir)
  const session = await newProjectChat(app.page, paths.projectDir)
  const officeRoot = join(paths.agentDir, 'sessions', session.sessionId, 'artifacts', 'office')
  const artifact = await importFixture(app, officeRoot)
  await makeWorkbookMultiSheet(app.page, artifact)
  const revision = await editLatestValue(app, artifact)
  const result = await exportBoth(app.page, paths, artifact, revision)
  await closeNormally(app)
  return result
}

async function secondLaunch(
  paths: ExportSmokePaths,
  running: RunningApp[],
  exported: ExportSession
): Promise<void> {
  const app = await launchExport(paths)
  running.push(app)
  assert.equal(sha256File(exported.outputLogPath), exported.outputLogHash)
  const log = readOutputLog(exported.outputLogPath)
  assert.equal(log.outputs.length, 2, '重启后 CSV/TSV 文件级记录丢失')
  verifyDelimited(paths.exportCsvPath, 'csv')
  verifyDelimited(paths.exportTsvPath, 'tsv')
  await closeNormally(app)
}

function smokePaths(runtimeRoot: string): ExportSmokePaths {
  const projectDir = join(runtimeRoot, 'project')
  return {
    homeDir: join(runtimeRoot, 'home'),
    agentDir: join(runtimeRoot, 'home', '.phi'),
    projectDir,
    userDataDir: join(runtimeRoot, 'electron-user-data'),
    saveAsPath: join(projectDir, 'unused-export-save-as.xlsx'),
    screenshotDir: join(runtimeRoot, 'screenshots'),
    ompWorkerPath: join(repoRoot, 'scripts', 'office', 'smoke-app-highlight-worker.mjs'),
    exportCsvPath: join(projectDir, csvName),
    exportTsvPath: join(projectDir, tsvName)
  }
}

async function assertClean(paths: ExportSmokePaths, runtimeRoot: string): Promise<void> {
  assert.deepEqual(transientFiles(paths.projectDir), [], '项目目录残留导出临时文件')
  assert.deepEqual(transientFiles(join(paths.agentDir, 'sessions')), [], '会话目录残留临时文件')
  const initial = runtimePids(runtimeRoot)
  if (initial === null) {
    process.stderr.write('Office export smoke：ps 不可用，无法独立核对进程。\n')
    return
  }
  assert.deepEqual(
    await waitUntil('Electron/Office export smoke 进程退出', () => {
      const current = runtimePids(runtimeRoot)
      return current?.length === 0 ? current : null
    }),
    []
  )
}

async function main(): Promise<void> {
  assert.ok(existsSync(join(repoRoot, 'out', 'main', 'index.mjs')), '请先构建 Electron 应用')
  assert.ok(existsSync(electronPath), 'Electron 可执行入口不存在')
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'phi-office-export-app-smoke-'))
  const paths = smokePaths(runtimeRoot)
  for (const path of [paths.agentDir, paths.projectDir, paths.userDataDir, paths.screenshotDir]) {
    mkdirSync(path, { recursive: true })
  }
  writeFileSync(join(paths.agentDir, 'onboarding.json'), '{"onboarded":true}\n')
  writeFixture(paths.projectDir)
  const running: RunningApp[] = []
  try {
    const exported = await firstLaunch(paths, running)
    await secondLaunch(paths, running, exported)
    await assertClean(paths, runtimeRoot)
    process.stdout.write(
      `OFFICE_APP_EXPORT_SMOKE_RESULT ${JSON.stringify({ formats: ['csv', 'tsv'], sheet: 'Sheet1', rows: 3, columns: 3, revision: exported.revision, restartCount: 2, targetExistsRejected: true })}\n`
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
