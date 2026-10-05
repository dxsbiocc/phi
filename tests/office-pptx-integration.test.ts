import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { officePlatformId } from '../scripts/office/fetch-officecli.mjs'
import { officeCliEnv, runOfficeCli } from '../src/main/agent/office/office-driver'
import { releaseTransientOfficeResident } from '../src/main/agent/office/office-process'
import { officeBinaryCandidates } from '../src/main/agent/office/office-runtime'
import {
  createOfficeService,
  type OfficeDocumentStatus
} from '../src/main/agent/office/office-service'
import {
  artifactDirectories,
  createOfficeRecoverySession,
  officeRecoveryIntegrationOptions as options,
  sha256
} from './helpers/officeReopenRecoveryHarness'

const platformId = officePlatformId()
const binary = platformId
  ? officeBinaryCandidates(platformId, {
      bundledOfficeDir: join(process.cwd(), 'resources', 'office')
    })[0]
  : undefined
const CLI_ENV = officeCliEnv(process.env, { OFFICECLI_RESIDENT_FLUSH: 'each' })
const SLIDE_NAME = '生命周期封面'
const SLIDE_TITLE = 'Phi 中文演示'
const SLIDE_TEXT = '中文内容：真实 PPTX 集成测试'

interface TrackedPreview {
  readonly draftPath: string
  readonly watchPort?: number
  readonly gatewayPort?: number
}

type OfficeServiceInstance = ReturnType<typeof createOfficeService>
type OfficeSession = ReturnType<typeof createOfficeRecoverySession>
type ReadyOfficeDocument = Extract<OfficeDocumentStatus, { state: 'ready' }>['document']

interface PptxLifecycleContext {
  readonly root: string
  readonly previousAgentDir: string | undefined
  readonly session: OfficeSession
  readonly service: OfficeServiceInstance
  readonly outputReader: OfficeServiceInstance
  readonly previews: TrackedPreview[]
  readonly paths: Set<string>
  readonly outputPath: string
  readonly wrongOutputPath: string
  restarted?: OfficeServiceInstance
  completed: boolean
}

async function cli(args: readonly string[]): Promise<Record<string, unknown>> {
  const result = await runOfficeCli(binary!, [...args, '--json'], {
    timeoutMs: 30_000,
    env: CLI_ENV
  })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  const value = JSON.parse(result.stdout) as Record<string, unknown>
  assert.equal(value.success, true)
  return value
}

function classCount(html: string, name: string): number {
  const classes = [...html.matchAll(/\bclass=(?:"([^"]*)"|'([^']*)')/giu)]
  return classes.filter((match) => (match[1] ?? match[2] ?? '').split(/\s+/u).includes(name)).length
}

async function waitForPreview(
  url: string,
  matches: (html: string) => boolean,
  description: string
): Promise<string> {
  const deadline = Date.now() + 8_000
  let html = ''
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      html = await response.text()
      if (response.ok && matches(html)) return html
    } catch {
      // The watch page can briefly reconnect while applying an SSE refresh.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`PPTX preview did not render ${description}`)
}

function slideXml(path: string): string {
  return execFileSync('/usr/bin/unzip', ['-p', path, 'ppt/slides/slide1.xml'], {
    encoding: 'utf8'
  })
}

function lsof(...args: readonly string[]): string {
  try {
    return execFileSync('/usr/sbin/lsof', [...args], { encoding: 'utf8' })
  } catch {
    return ''
  }
}

function assertNoOfficeResources(
  previews: readonly TrackedPreview[],
  paths: readonly string[]
): void {
  for (const preview of previews) {
    for (const port of [preview.watchPort, preview.gatewayPort]) {
      if (port) assert.equal(lsof('-nP', `-iTCP:${port}`, '-sTCP:LISTEN'), '')
    }
  }
  for (const path of paths) {
    if (path) assert.equal(lsof('-t', '-a', '-c', 'officecli', '--', path), '')
  }
}

function restoreAgentDir(previous: string | undefined): void {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previous
}

function startLifecycleContext(): PptxLifecycleContext {
  const root = mkdtempSync(join(tmpdir(), 'office pptx lifecycle '))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  return {
    root,
    previousAgentDir,
    session: createOfficeRecoverySession(root),
    service: createOfficeService(),
    outputReader: createOfficeService(),
    previews: [],
    paths: new Set<string>(),
    outputPath: join(root, '交付演示.pptx'),
    wrongOutputPath: join(root, '错误类型.docx'),
    completed: false
  }
}

async function createAndCheckBlankPptx(
  context: PptxLifecycleContext
): Promise<ReadyOfficeDocument> {
  const created = await context.service.create({
    requestId: 'create-pptx',
    sessionId: context.session.sessionId,
    projectId: null,
    kind: 'pptx'
  })
  assert.equal(created.state, 'ready')
  if (created.state !== 'ready') throw new Error(created.message)
  const document = created.document
  context.previews.push(document)
  context.paths.add(document.draftPath)
  assert.equal(document.kind, 'pptx')
  assert.equal(document.previewState, 'ready')
  assert.equal(document.slideCount, 0)
  assert.equal(document.draftPath.endsWith('未命名演示文稿.pptx'), true)
  const html = await waitForPreview(
    document.previewUrl,
    (value) => classCount(value, 'main') === 1 && /class="page-counter">\s*1\s*\/\s*0/u.test(value),
    'the real zero-slide state'
  )
  assert.equal(classCount(html, 'slide-container'), 0)
  assert.equal(classCount(html, 'thumb'), 0)
  const opened = await context.service.open({
    sessionId: context.session.sessionId,
    projectId: null,
    sourcePath: document.draftPath,
    allowRoots: [context.session.dir]
  })
  assert.equal(opened.state, 'ready')
  if (opened.state !== 'ready') throw new Error(opened.message)
  assert.equal(opened.document.artifactId, document.artifactId)
  await cli(['validate', opened.document.draftPath])
  return opened.document
}

async function addAndSaveSlide(
  context: PptxLifecycleContext,
  document: ReadyOfficeDocument
): Promise<void> {
  const added = await cli([
    'add',
    document.draftPath,
    '/',
    '--type',
    'slide',
    '--prop',
    `name=${SLIDE_NAME}`,
    '--prop',
    `title=${SLIDE_TITLE}`,
    '--prop',
    `text=${SLIDE_TEXT}`
  ])
  assert.equal(added.data, 'Added slide at /slide[1]')
  const html = await waitForPreview(
    document.previewUrl,
    (value) =>
      value.includes(SLIDE_TITLE) &&
      value.includes(SLIDE_TEXT) &&
      /class="page-counter">\s*1\s*\/\s*1/u.test(value),
    'Chinese slide content and the 1 / 1 page counter'
  )
  assert.equal(classCount(html, 'slide-container'), 1)
  assert.equal(classCount(html, 'thumb'), 1)
  const saved = await context.service.saveDocument(document.artifactId, context.session.sessionId)
  assert.equal(saved.saved, true)
  const xml = slideXml(document.draftPath)
  assert.match(xml, new RegExp(SLIDE_NAME, 'u'))
  assert.match(xml, new RegExp(SLIDE_TITLE, 'u'))
  assert.match(xml, new RegExp(SLIDE_TEXT, 'u'))
}

async function saveAsAndReopenOutput(
  context: PptxLifecycleContext,
  document: ReadyOfficeDocument
): Promise<void> {
  await assert.rejects(
    context.service.saveAsDocument(
      document.artifactId,
      context.session.sessionId,
      context.root,
      context.wrongOutputPath
    ),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'invalid_extension')
      return true
    }
  )
  assert.equal(existsSync(context.wrongOutputPath), false)
  const output = await context.service.saveAsDocument(
    document.artifactId,
    context.session.sessionId,
    context.root,
    context.outputPath
  )
  context.paths.add(context.outputPath)
  assert.equal(output.outputPath, '交付演示.pptx')
  assert.equal(output.sha256, sha256(context.outputPath))
  assert.equal(sha256(context.outputPath), sha256(document.draftPath))
  await cli(['validate', context.outputPath])
  await releaseTransientOfficeResident(binary!, context.outputPath)
  const reopened = await context.outputReader.open({
    sessionId: context.session.sessionId,
    projectId: null,
    sourcePath: context.outputPath,
    allowRoots: [context.root]
  })
  assert.equal(reopened.state, 'ready')
  if (reopened.state !== 'ready') throw new Error(reopened.message)
  context.previews.push(reopened.document)
  context.paths.add(reopened.document.draftPath)
  assert.equal(reopened.document.kind, 'pptx')
  assert.equal(reopened.document.slideCount, 1)
  await waitForPreview(
    reopened.document.previewUrl,
    (html) => html.includes(SLIDE_TEXT) && /class="page-counter">\s*1\s*\/\s*1/u.test(html),
    'the saved PowerPoint output'
  )
}

async function restartAndRecoverPptx(
  context: PptxLifecycleContext,
  document: ReadyOfficeDocument
): Promise<void> {
  await context.outputReader.dispose()
  await context.service.dispose()
  context.restarted = createOfficeService()
  const recovered = await context.restarted.open({
    sessionId: context.session.sessionId,
    projectId: null,
    sourcePath: document.draftPath,
    allowRoots: [context.session.dir]
  })
  assert.equal(recovered.state, 'ready')
  if (recovered.state !== 'ready') throw new Error(recovered.message)
  context.previews.push(recovered.document)
  context.paths.add(recovered.document.draftPath)
  assert.equal(recovered.document.artifactId, document.artifactId)
  assert.equal(recovered.document.kind, 'pptx')
  assert.equal(recovered.document.slideCount, 1)
  assert.equal(recovered.restoreNotice?.kind, 'recovered')
  await waitForPreview(
    recovered.document.previewUrl,
    (html) => html.includes(SLIDE_TEXT),
    'the recovered PowerPoint draft'
  )
}

async function cleanupLifecycle(context: PptxLifecycleContext): Promise<void> {
  await context.restarted?.dispose().catch(() => undefined)
  await context.outputReader.dispose().catch(() => undefined)
  await context.service.dispose().catch(() => undefined)
  for (const path of context.paths) {
    await releaseTransientOfficeResident(binary!, path).catch(() => undefined)
  }
  if (context.completed) assertNoOfficeResources(context.previews, [...context.paths])
  restoreAgentDir(context.previousAgentDir)
  rmSync(context.root, { recursive: true, force: true })
  assert.equal(existsSync(context.root), false)
}

test(
  'real PPTX create, zero-slide preview, slide update, save, save-as, reopen, and restart recovery form one lifecycle',
  options,
  async () => {
    const context = startLifecycleContext()
    try {
      const document = await createAndCheckBlankPptx(context)
      await addAndSaveSlide(context, document)
      await saveAsAndReopenOutput(context, document)
      await restartAndRecoverPptx(context, document)
      context.completed = true
    } finally {
      await cleanupLifecycle(context)
    }
  }
)

test(
  'a real XLSX renamed as PPTX fails inspection without creating an artifact',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office pptx mismatch '))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    const sourcePath = join(root, '伪装演示.pptx')
    copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'office', 'sample.xlsx'), sourcePath)
    const original = readFileSync(sourcePath)
    const session = createOfficeRecoverySession(root)
    const service = createOfficeService()
    try {
      const result = await service.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath,
        allowRoots: [root]
      })
      assert.equal(result.state, 'error')
      if (result.state !== 'error') throw new Error('mismatched PPTX package unexpectedly opened')
      assert.equal(result.code, 'inspection_failed')
      assert.match(result.message, /PowerPoint/u)
      assert.deepEqual(readFileSync(sourcePath), original)
      assert.deepEqual(artifactDirectories(session.dir), [])
    } finally {
      await service.dispose().catch(() => undefined)
      await releaseTransientOfficeResident(binary!, sourcePath).catch(() => undefined)
      restoreAgentDir(previousAgentDir)
      rmSync(root, { recursive: true, force: true })
      assert.equal(existsSync(root), false)
    }
  }
)
