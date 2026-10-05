import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

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
  activateSheet,
  activeView,
  assertFollow,
  assertFollowTargetVisible,
  assertSingleChatSurface,
  fileHash,
  openEditor,
  operationRevision,
  reopenArtifactInBackend,
  setFollow,
  setMeaningfulScroll,
  startApply,
  waitForHighlights,
  waitForPrompt,
  waitForRevision,
  type ApplyCommand
} from './smoke-app-highlight-runtime'
import {
  createDraft,
  createSmokeProject,
  newProjectChat,
  officeArtifacts,
  runtimePids,
  switchSmokeSession,
  transientFiles,
  type ArtifactRecord
} from './smoke-app-deliver-runtime'

const officeBinaryPath = join(
  repoRoot,
  'resources',
  'office',
  'officecli',
  `${process.platform}-${process.arch}`,
  'officecli'
)
// A session is titled after its first message, which is now the seed write.
const titleHint = '"id":"highlight-seed"'
const highlightPaths = [
  '/Sheet1/A1',
  '/Sheet1/A2',
  '/Sheet1/A3',
  '/Sheet1/B1',
  '/Sheet1/B2',
  '/Sheet1/B3'
]

interface SessionSmokeApi {
  getCurrentSession(): Promise<{ phiSessionId?: string }>
}

interface FirstLaunchResult {
  readonly sessionId: string
  readonly sessionPath: string
  readonly artifact: ArtifactRecord
  readonly draftRealPath: string
  readonly officeRoot: string
  readonly backgroundSessionId: string
}

async function exerciseHighlightAndFollow(
  app: RunningApp,
  paths: SmokePaths,
  artifact: ArtifactRecord
): Promise<string> {
  const guest = await officeGuest(app.browser, app.page)
  // A blank workbook renders no data cells yet, so wait for the sheet itself.
  await guest.waitForSelector('.sheet-tab[role="tab"]', {
    visible: true,
    timeout: readyTimeoutMs
  })
  await assertFollow(app.page, true, null)

  // The first write into a blank workbook is answered by a full refresh, which Phi cannot yet attribute to
  // that write, so it is reported unconfirmed and not highlighted. Seed one cell so the real checks below
  // run against a workbook the preview has already rendered once.
  await startApply(app.page, {
    id: 'highlight-seed',
    apply: {
      operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'J1', value: 'seed' },
      baseRevision: 0
    }
  })
  await waitForRevision(artifact.draftPath, 1)
  await waitForPrompt(app.page)

  await startApply(app.page, {
    id: 'highlight-primary',
    apply: {
      operation: {
        type: 'set_range',
        sheet: 'Sheet1',
        range: 'A1:B3',
        values: [
          ['a', 'b'],
          ['c', 'd'],
          ['e', 'f']
        ]
      },
      baseRevision: 1
    }
  })
  await waitForRevision(artifact.draftPath, 2)
  await waitForHighlights(guest, highlightPaths)
  await app.page.screenshot({ path: join(paths.screenshotDir, '01-highlight-a1-b3.png') })
  const contentHash = fileHash(artifact.draftPath)
  await delay(9_250)
  await waitForHighlights(guest, [])
  assert.equal(fileHash(artifact.draftPath), contentHash, '高亮淡出改变了 XLSX 字节')
  assert.equal(operationRevision(artifact.draftPath), 2, '高亮淡出改变了 contentRevision')
  await waitForPrompt(app.page)

  for (const command of [
    {
      id: 'highlight-scroll-anchor',
      apply: {
        operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'A150', value: 'anchor' },
        baseRevision: 2
      }
    },
    {
      id: 'highlight-add-sheet',
      apply: { operation: { type: 'add_sheet', name: 'Sheet2' }, baseRevision: 3 }
    }
  ] satisfies ApplyCommand[]) {
    await startApply(app.page, command)
    await waitForRevision(artifact.draftPath, command.apply.baseRevision + 1)
    await waitForPrompt(app.page)
  }

  await activateSheet(guest, 'Sheet1')
  const beforeFollowOff = await setMeaningfulScroll(guest)
  await setFollow(app.page, false)
  await startApply(app.page, {
    id: 'highlight-follow-off',
    apply: {
      operation: { type: 'set_cell', sheet: 'Sheet2', cell: 'B120', value: 'follow off' },
      baseRevision: 4
    }
  })
  await waitForRevision(artifact.draftPath, 5)
  await waitForHighlights(guest, ['/Sheet2/B120'])
  assert.deepEqual(await activeView(guest), beforeFollowOff, '关闭跟随后用户视角发生变化')
  await waitForPrompt(app.page)

  await setFollow(app.page, true)
  await startApply(app.page, {
    id: 'highlight-follow-on',
    apply: {
      operation: { type: 'set_cell', sheet: 'Sheet2', cell: 'C150', value: 'follow on' },
      baseRevision: 5
    }
  })
  await waitForRevision(artifact.draftPath, 6)
  await waitForHighlights(guest, ['/Sheet2/C150'])
  await assertFollowTargetVisible(guest, '/Sheet2/C150')
  await app.page.screenshot({ path: join(paths.screenshotDir, '02-follow-on-sheet2.png') })
  await waitForPrompt(app.page)

  await startApply(app.page, {
    // Sheet2!C150 already exists, so this is a cell patch; a new row or column would make the upstream page re-render
    // everything, which discards an open editor regardless of Phi.
    id: 'highlight-editor-suppression',
    apply: {
      operation: { type: 'set_cell', sheet: 'Sheet2', cell: 'C150', value: 'editor guard' },
      baseRevision: 6
    },
    delayMs: 5_000
  })
  await openEditor(guest)
  await waitForRevision(artifact.draftPath, 7)
  await waitForHighlights(guest, ['/Sheet2/C150'])
  assert.equal((await activeView(guest)).activeSheet, 'Sheet1', '人工编辑时被切走工作表')
  assert.equal(
    await guest.$eval(
      'td[data-path="/Sheet1/A1"] input',
      (input) => (input as HTMLInputElement).value
    ),
    'manual draft'
  )
  await guest.keyboard.press('Escape')
  await guest.waitForSelector('td[data-path="/Sheet1/A1"] input', {
    hidden: true,
    timeout: readyTimeoutMs
  })
  await delay(500)
  assert.equal(operationRevision(artifact.draftPath), 7, '取消人工编辑产生了额外写入')
  await waitForPrompt(app.page)
  return titleHint
}

async function firstLaunch(paths: SmokePaths, running: RunningApp[]): Promise<FirstLaunchResult> {
  const app = await launch(paths)
  running.push(app)
  await createSmokeProject(app.page, paths.projectDir)
  const session = await newProjectChat(app.page, paths.projectDir)
  const officeRoot = join(paths.agentDir, 'sessions', session.sessionId, 'artifacts', 'office')
  const artifact = await createDraft(app.page, officeRoot, 'xlsx', 'O21 高亮与跟随')
  const draftRealPath = realpathSync(artifact.draftPath)
  // macOS temp dirs sit behind the /var -> /private/var symlink, so the registered path need not be canonical.
  assert.equal(realpathSync(artifact.draftPath), draftRealPath)
  const persistedTitleHint = await exerciseHighlightAndFollow(app, paths, artifact)

  // Starting a new chat disposes the previous session and its run, so a run cannot keep writing in the
  // background; what remains to check is that opening a fresh chat leaves no Office panel behind.
  const backgroundSession = await newProjectChat(app.page, paths.projectDir)
  await assertSingleChatSurface(app.page)
  assert.equal(
    await app.page.$(`[data-phi-office-artifact="${artifact.artifactId}"]`),
    null,
    '后台会话的 Office 面板仍占用当前界面'
  )
  assert.equal(operationRevision(artifact.draftPath), 7, '新对话改变了草稿内容')
  const current = await app.page.evaluate(async () =>
    (window as unknown as { api: SessionSmokeApi }).api.getCurrentSession()
  )
  assert.equal(current.phiSessionId, backgroundSession.sessionId, '回到了旧会话')
  await switchSmokeSession(app.page, session.sessionPath, session.sessionId, persistedTitleHint)
  await closeNormally(app)
  return {
    ...session,
    artifact,
    draftRealPath,
    officeRoot,
    backgroundSessionId: backgroundSession.sessionId
  }
}

async function secondLaunch(
  paths: SmokePaths,
  running: RunningApp[],
  first: FirstLaunchResult
): Promise<void> {
  const app = await launch(paths)
  running.push(app)
  await switchSmokeSession(app.page, first.sessionPath, first.sessionId, titleHint)
  const restored = officeArtifacts(first.officeRoot).find(
    (candidate) => candidate.artifactId === first.artifact.artifactId
  )
  assert.ok(restored, '重启后丢失原 Office artifact')
  assert.equal(realpathSync(restored.draftPath), first.draftRealPath)
  await reopenArtifactInBackend(app.page, restored)
  // The follow preference is global and must survive the restart even before a panel is open.
  assert.equal(
    await app.page.evaluate(() => localStorage.getItem('phi.office.followAi.v1')),
    'true'
  )
  assert.equal(operationRevision(restored.draftPath), 7)
  await closeNormally(app)
}

function smokePaths(runtimeRoot: string): SmokePaths {
  return {
    homeDir: join(runtimeRoot, 'home'),
    agentDir: join(runtimeRoot, 'home', '.phi'),
    projectDir: join(runtimeRoot, 'project'),
    userDataDir: join(runtimeRoot, 'electron-user-data'),
    saveAsPath: join(runtimeRoot, 'project', 'unused-highlight-save-as.xlsx'),
    screenshotDir: join(runtimeRoot, 'screenshots'),
    ompWorkerPath: join(repoRoot, 'scripts', 'office', 'smoke-app-highlight-worker.mjs')
  }
}

async function assertProcessesStopped(runtimeRoot: string): Promise<void> {
  const initial = runtimePids(runtimeRoot)
  if (initial === null) {
    process.stderr.write('Office highlight smoke：ps 不可用，无法独立核对进程。\n')
    return
  }
  assert.deepEqual(
    await waitUntil('Electron/Office highlight smoke 进程退出', () => {
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
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'phi-office-highlight-app-smoke-'))
  const paths = smokePaths(runtimeRoot)
  for (const path of [paths.agentDir, paths.projectDir, paths.userDataDir, paths.screenshotDir]) {
    mkdirSync(path, { recursive: true })
  }
  writeFileSync(join(paths.agentDir, 'onboarding.json'), '{"onboarded":true}\n')
  const running: RunningApp[] = []
  try {
    const first = await firstLaunch(paths, running)
    await secondLaunch(paths, running, first)
    assert.deepEqual(transientFiles(paths.projectDir), [], '项目目录残留 Office 临时文件')
    assert.deepEqual(transientFiles(join(paths.agentDir, 'sessions')), [], '会话目录残留临时文件')
    await assertProcessesStopped(runtimeRoot)
    process.stdout.write(
      `OFFICE_APP_HIGHLIGHT_SMOKE_RESULT ${JSON.stringify({ artifactId: first.artifact.artifactId, revision: 7, restartCount: 2, backgroundSessionId: first.backgroundSessionId })}\n`
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
