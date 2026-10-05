import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Page } from 'puppeteer-core'

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
import { assertSingleChatSurface, reopenArtifactInBackend } from './smoke-app-highlight-runtime'
import {
  createSmokeProject,
  newProjectChat,
  officeArtifacts,
  runtimePids,
  switchSmokeSession,
  transientFiles,
  type ArtifactRecord
} from './smoke-app-deliver-runtime'

const titleHint = 'O23-import-smoke-session'
const csvName = 'o23-wide.csv'
const tsvName = 'o24-special.tsv'
const oversizedName = 'o23-too-many-rows.csv'
const csvLastValue = 'O23_CSV_LAST_1000_80'
const tsvLastValue = 'O24_TSV_LAST_VALUE'
const importReadyTimeoutMs = 120_000
const officeBinaryPath = join(
  repoRoot,
  'resources',
  'office',
  'officecli',
  `${process.platform}-${process.arch}`,
  'officecli'
)

interface ImportSourceRecord {
  readonly path: string
  readonly format: 'csv' | 'tsv'
  readonly delimiter: string
  readonly rows: number
  readonly columns: number
  readonly sha256: string
}

interface ImportedArtifact extends ArtifactRecord {
  readonly origin?: string
  readonly importSource?: ImportSourceRecord
}

interface ImportFixture {
  readonly name: string
  readonly path: string
  readonly format: 'csv' | 'tsv'
  readonly rows: number
  readonly columns: number
  readonly lastCell: string
  readonly lastValue: string
  readonly sha256: string
}

interface ImportedSession {
  readonly sessionId: string
  readonly sessionPath: string
  readonly officeRoot: string
  readonly csv: ImportedArtifact
  readonly tsv: ImportedArtifact
  readonly tsvDraftRealPath: string
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function wideCsv(): string {
  return Array.from({ length: 1_000 }, (_, row) =>
    Array.from({ length: 80 }, (_, column) => {
      if (row === 0 && column === 0) return '中文'
      if (row === 0 && column === 1) return '007'
      if (row === 0 && column === 2) return '=SUM(A1)'
      if (row === 0 && column === 3) return '含,逗号'
      if (row === 999 && column === 79) return csvLastValue
      return `${row + 1}-${column + 1}`
    })
      .map(csvCell)
      .join(',')
  ).join('\n')
}

function writeFixture(
  projectDir: string,
  input: Omit<ImportFixture, 'path' | 'sha256'>,
  content: string
): ImportFixture {
  const path = join(projectDir, input.name)
  writeFileSync(path, content)
  return { ...input, path, sha256: sha256(path) }
}

function createCsvFixture(projectDir: string): ImportFixture {
  return writeFixture(
    projectDir,
    {
      name: csvName,
      format: 'csv',
      rows: 1_000,
      columns: 80,
      lastCell: 'CB1000',
      lastValue: csvLastValue
    },
    wideCsv()
  )
}

function createTsvFixture(projectDir: string): ImportFixture {
  return writeFixture(
    projectDir,
    {
      name: tsvName,
      format: 'tsv',
      rows: 3,
      columns: 4,
      lastCell: 'D3',
      lastValue: tsvLastValue
    },
    `名称\t逗号文本\t空列\t公式样文本\n中文\t带,逗号\t\t=SUM(A1)\n"跨\n行"\t007\t\t${tsvLastValue}`
  )
}

function createOversizedFixture(projectDir: string): ImportFixture {
  return writeFixture(
    projectDir,
    {
      name: oversizedName,
      format: 'csv',
      rows: 1_001,
      columns: 1,
      lastCell: 'A1001',
      lastValue: 'overflow'
    },
    Array.from({ length: 1_001 }, (_, index) => `row-${index + 1}`).join('\n')
  )
}

function createFixtures(projectDir: string): {
  csv: ImportFixture
  tsv: ImportFixture
  oversized: ImportFixture
} {
  return {
    csv: createCsvFixture(projectDir),
    tsv: createTsvFixture(projectDir),
    oversized: createOversizedFixture(projectDir)
  }
}

function importedArtifacts(officeRoot: string): ImportedArtifact[] {
  return officeArtifacts(officeRoot) as ImportedArtifact[]
}

async function openDelimitedPreview(page: Page, fixture: ImportFixture): Promise<void> {
  await page.click('[aria-label="文件"]')
  await page.waitForSelector('[aria-label="项目目录树"]', { visible: true })
  const selector = `[data-phi-file-kind="csv"][title="${fixture.name}"]`
  await page.waitForSelector(selector, { visible: true, timeout: readyTimeoutMs })
  // The file tree opens a file on a slow double click: select, wait, then double click.
  await page.click(selector)
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  await page.click(selector, { count: 2, delay: 60 })
  await page.waitForSelector('[data-phi-office-import-button="true"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  assert.equal(await page.$('[data-phi-office-state]'), null, '导入前意外出现 Office 面板')
}

async function assertPreviewCell(app: RunningApp, cell: string, expected: string): Promise<void> {
  const guest = await officeGuest(app.browser, app.page)
  await guest.waitForFunction(
    (path, text) => document.querySelector(`td[data-path="/Sheet1/${path}"]`)?.textContent === text,
    { timeout: readyTimeoutMs },
    cell,
    expected
  )
}

function assertImportMetadata(artifact: ImportedArtifact, fixture: ImportFixture): void {
  assert.equal(artifact.kind, 'xlsx')
  assert.equal(artifact.origin, 'import')
  assert.ok(artifact.sourcePath, '导入草稿缺少来源路径')
  assert.equal(realpathSync(artifact.sourcePath), realpathSync(fixture.path))
  assert.deepEqual(artifact.importSource, {
    path: fixture.name,
    format: fixture.format,
    delimiter: fixture.format === 'csv' ? ',' : '\t',
    rows: fixture.rows,
    columns: fixture.columns,
    sha256: fixture.sha256
  })
}

async function importFixture(
  app: RunningApp,
  officeRoot: string,
  fixture: ImportFixture
): Promise<ImportedArtifact> {
  const known = new Set(importedArtifacts(officeRoot).map((artifact) => artifact.artifactId))
  await openDelimitedPreview(app.page, fixture)
  await app.page.click('[data-phi-office-import-button="true"]')
  await app.page.waitForSelector('[data-phi-office-state="ready"]', {
    visible: true,
    timeout: importReadyTimeoutMs
  })
  const artifact = await waitUntil(`${fixture.format} 导入草稿登记`, () =>
    importedArtifacts(officeRoot).find((candidate) => !known.has(candidate.artifactId))
  )
  assertImportMetadata(artifact, fixture)
  assert.equal(sha256(fixture.path), fixture.sha256, `${fixture.name} 原文件被改动`)
  await app.page.waitForSelector(`[data-phi-office-artifact="${artifact.artifactId}"]`, {
    visible: true,
    timeout: readyTimeoutMs
  })
  await assertSingleChatSurface(app.page)
  await assertPreviewCell(app, fixture.lastCell, fixture.lastValue)
  if (fixture.format === 'csv') {
    await assertPreviewCell(app, 'B1', '007')
    await assertPreviewCell(app, 'C1', '=SUM(A1)')
    await assertPreviewCell(app, 'D1', '含,逗号')
  } else {
    await assertPreviewCell(app, 'B3', '007')
    await assertPreviewCell(app, 'D2', '=SUM(A1)')
  }
  return artifact
}

async function persistSessionTitle(app: RunningApp, artifact: ImportedArtifact): Promise<void> {
  await app.page.focus('[data-phi-focus="chat-input"]')
  await app.page.keyboard.type(titleHint)
  await app.page.click('[data-phi-composer-action="send"]')
  await app.page.click('[aria-label="项目"]')
  await waitUntil('导入 smoke 会话标题持久化', () =>
    app.page.evaluate(
      (title) =>
        Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).some((element) =>
          element.textContent?.includes(title)
        ),
      titleHint
    )
  )
  await app.page.waitForSelector(`[data-phi-office-artifact="${artifact.artifactId}"]`, {
    visible: true,
    timeout: readyTimeoutMs
  })
}

async function rejectOversized(
  app: RunningApp,
  officeRoot: string,
  fixture: ImportFixture
): Promise<void> {
  const before = importedArtifacts(officeRoot).map((artifact) => artifact.artifactId)
  await openDelimitedPreview(app.page, fixture)
  await app.page.click('[data-phi-office-import-button="true"]')
  const message = await waitUntil('超限导入显示明确错误', () =>
    app.page.$eval('[data-phi-office-import-error="true"]', (element) => element.textContent)
  )
  assert.match(message, /1001 行 × 1 列/u)
  assert.match(message, /上限为 1000 行 × 100 列/u)
  assert.match(message, /80000 格/u)
  assert.deepEqual(
    importedArtifacts(officeRoot).map((artifact) => artifact.artifactId),
    before,
    '超限导入留下了产物'
  )
  assert.deepEqual(existsSync(officeRoot) ? readdirSync(officeRoot) : [], [], '超限导入留下了目录')
  assert.equal(await app.page.$('[data-phi-office-state]'), null, '超限导入打开了 Office 面板')
  assert.equal(
    await app.page.$('[data-phi-office-artifact]'),
    null,
    '超限导入留下了 Office 草稿面板'
  )
  assert.equal(sha256(fixture.path), fixture.sha256, '超限导入改动了原文件')
}

async function firstLaunch(
  paths: SmokePaths,
  fixtures: ReturnType<typeof createFixtures>,
  running: RunningApp[]
): Promise<ImportedSession> {
  const app = await launch(paths)
  running.push(app)
  await createSmokeProject(app.page, paths.projectDir)
  const session = await newProjectChat(app.page, paths.projectDir)
  const officeRoot = join(paths.agentDir, 'sessions', session.sessionId, 'artifacts', 'office')
  const csv = await importFixture(app, officeRoot, fixtures.csv)
  const tsv = await importFixture(app, officeRoot, fixtures.tsv)
  await persistSessionTitle(app, tsv)
  await assertPreviewCell(app, fixtures.tsv.lastCell, fixtures.tsv.lastValue)

  const failedSession = await newProjectChat(app.page, paths.projectDir)
  await waitUntil('新对话销毁旧 Office 面板', async () =>
    (await app.page.$('[data-phi-office-state]')) === null ? true : null
  )
  const failedOfficeRoot = join(
    paths.agentDir,
    'sessions',
    failedSession.sessionId,
    'artifacts',
    'office'
  )
  await rejectOversized(app, failedOfficeRoot, fixtures.oversized)
  await closeNormally(app)
  return {
    ...session,
    officeRoot,
    csv,
    tsv,
    tsvDraftRealPath: realpathSync(tsv.draftPath)
  }
}

async function secondLaunch(
  paths: SmokePaths,
  fixtures: ReturnType<typeof createFixtures>,
  first: ImportedSession,
  running: RunningApp[]
): Promise<void> {
  const app = await launch(paths)
  running.push(app)
  await switchSmokeSession(app.page, first.sessionPath, first.sessionId, titleHint)
  const restored = importedArtifacts(first.officeRoot).find(
    (artifact) => artifact.artifactId === first.tsv.artifactId
  )
  assert.ok(restored, '重启后丢失 TSV 导入草稿')
  assert.equal(realpathSync(restored.draftPath), first.tsvDraftRealPath)
  assert.ok(restored.sourcePath, '重启后的 TSV 草稿缺少来源')
  assert.equal(realpathSync(restored.sourcePath), realpathSync(fixtures.tsv.path))
  // Reopening a private draft after a restart restores the document but opens no tab for it, so the last
  // value is checked in the saved workbook itself rather than through a preview.
  await reopenArtifactInBackend(app.page, restored)
  assert.match(
    workbookText(restored.draftPath),
    new RegExp(escapeRegExp(fixtures.tsv.lastValue), 'u')
  )
  assert.equal(sha256(fixtures.csv.path), fixtures.csv.sha256, '重启后 CSV 原文件被改动')
  assert.equal(sha256(fixtures.tsv.path), fixtures.tsv.sha256, '重启后 TSV 原文件被改动')
  await closeNormally(app)
}

function workbookText(path: string): string {
  // Strings may be shared or inline depending on the writer, so a missing part is not an error.
  return ['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml']
    .map((entry) => {
      try {
        return execFileSync('/usr/bin/unzip', ['-p', path, entry], {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore']
        })
      } catch {
        return ''
      }
    })
    .join('\n')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function smokePaths(runtimeRoot: string): SmokePaths {
  return {
    homeDir: join(runtimeRoot, 'home'),
    agentDir: join(runtimeRoot, 'home', '.phi'),
    projectDir: join(runtimeRoot, 'project'),
    userDataDir: join(runtimeRoot, 'electron-user-data'),
    saveAsPath: join(runtimeRoot, 'project', 'unused-import-save-as.xlsx'),
    screenshotDir: join(runtimeRoot, 'screenshots'),
    ompWorkerPath: join(repoRoot, 'scripts', 'office', 'smoke-app-import-worker.mjs')
  }
}

async function assertProcessesStopped(runtimeRoot: string): Promise<void> {
  const initial = runtimePids(runtimeRoot)
  if (initial === null) {
    process.stderr.write('Office import smoke：ps 不可用，无法独立核对进程。\n')
    return
  }
  assert.deepEqual(
    await waitUntil('Electron/Office import smoke 进程退出', () => {
      const current = runtimePids(runtimeRoot)
      return current?.length === 0 ? current : null
    }),
    []
  )
}

async function main(): Promise<void> {
  assert.ok(existsSync(join(repoRoot, 'out', 'main', 'index.mjs')), '请先构建 Electron 应用')
  assert.ok(existsSync(electronPath), 'Electron 可执行入口不存在')
  assert.ok(existsSync(officeBinaryPath), 'OfficeCLI 可执行入口不存在')
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'phi-office-import-app-smoke-'))
  const paths = smokePaths(runtimeRoot)
  for (const path of [paths.agentDir, paths.projectDir, paths.userDataDir, paths.screenshotDir]) {
    mkdirSync(path, { recursive: true })
  }
  writeFileSync(join(paths.agentDir, 'onboarding.json'), '{"onboarded":true}\n')
  const fixtures = createFixtures(paths.projectDir)
  const running: RunningApp[] = []
  try {
    const first = await firstLaunch(paths, fixtures, running)
    await secondLaunch(paths, fixtures, first, running)
    assert.deepEqual(transientFiles(paths.projectDir), [], '项目目录残留 Office 临时文件')
    assert.deepEqual(transientFiles(join(paths.agentDir, 'sessions')), [], '会话目录残留临时文件')
    await assertProcessesStopped(runtimeRoot)
    process.stdout.write(
      `OFFICE_APP_IMPORT_SMOKE_RESULT ${JSON.stringify({ csvArtifactId: first.csv.artifactId, tsvArtifactId: first.tsv.artifactId, csvDimensions: [1_000, 80], oversizedRejected: true, restartCount: 2 })}\n`
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
