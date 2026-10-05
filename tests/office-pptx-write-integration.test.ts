import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { officePlatformId } from '../scripts/office/fetch-officecli.mjs'
import { validateOfficePptxOperation } from '../src/main/agent/office/office-pptx-contract'
import type { OfficePptxReadResult } from '../src/main/agent/office/office-pptx-read'
import { OfficePptxWriter } from '../src/main/agent/office/office-pptx-write'
import { officeCliEnv, runOfficeCli } from '../src/main/agent/office/office-driver'
import { releaseTransientOfficeResident } from '../src/main/agent/office/office-process'
import { officeBinaryCandidates } from '../src/main/agent/office/office-runtime'
import { createOfficeService } from '../src/main/agent/office/office-service'
import type { OfficeWriteRequest } from '../src/main/agent/office/office-write-contract'
import { createPhiSession } from '../src/main/agent/session/session-store'

const platformId = officePlatformId()
const binary = platformId
  ? officeBinaryCandidates(platformId, {
      bundledOfficeDir: join(process.cwd(), 'resources', 'office')
    })[0]
  : undefined
const enabled = process.env.PHI_OFFICE_INTEGRATION === '1' && Boolean(binary && existsSync(binary))
const options = {
  skip: enabled ? false : 'set PHI_OFFICE_INTEGRATION=1 and run bun run office:fetch'
}

test(
  'real PPTX Agent add/set is stable-id based, idempotent, saved, and restart-safe',
  options,
  async () => {
    const harness = await startAgentHarness()
    try {
      const setRequest = await exerciseAgentWrites(harness)
      await restartAndReplay(harness, setRequest)
    } finally {
      await cleanupAgentHarness(harness)
    }
  }
)

interface AgentHarness {
  readonly root: string
  readonly restoreAgentDir: () => void
  readonly service: ReturnType<typeof createOfficeService>
  readonly session: ReturnType<typeof createPhiSession>
  readonly draftPath: string
  previewEvents?: Response
  restarted?: ReturnType<typeof createOfficeService>
}

async function startAgentHarness(): Promise<AgentHarness> {
  const root = mkdtempSync(join(tmpdir(), 'phi-pptx-agent-'))
  const restoreAgentDir = withAgentDir(root)
  const service = createOfficeService()
  try {
    const session = createSession(root)
    const created = await service.create({
      requestId: 'create-pptx-agent',
      sessionId: session.sessionId,
      projectId: null,
      kind: 'pptx'
    })
    assert.equal(created.state, 'ready')
    if (created.state !== 'ready') throw new Error(created.message)
    const previewEvents = await fetch(`${created.document.previewUrl}events`)
    bind(service, 'run-pptx', created.document.artifactId, session.sessionId)
    assert.equal((await readPptx(service, 'run-pptx')).total, 0)
    return {
      root,
      restoreAgentDir,
      service,
      session,
      draftPath: created.document.draftPath,
      previewEvents
    }
  } catch (error) {
    await service.dispose().catch(() => undefined)
    restoreAgentDir()
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

async function exerciseAgentWrites(harness: AgentHarness): Promise<OfficeWriteRequest> {
  const slideId = await addSlides(harness.service)
  const setRequest = await setFirstSlideTitle(harness.service, slideId)
  await assertRejectedTargets(harness.service, slideId, setRequest)
  await assertFinalPresentation(harness.service, harness.draftPath)
  return setRequest
}

async function addSlides(service: AgentHarness['service']): Promise<string> {
  const firstRequest = request(
    { type: 'add_slide', title: '中文标题 & <Phi>', body: '中文正文 & < >' },
    0
  )
  const first = await service.applyWriteRequest('run-pptx', firstRequest, {
    operationId: 'real-pptx-add-1'
  })
  assert.equal(first.previewConfirmed, true)
  if (!('slideId' in first)) throw new Error('missing slideId')
  const replay = await service.applyWriteRequest('run-pptx', firstRequest, {
    operationId: 'real-pptx-add-1'
  })
  assert.equal(replay.deduplicated, true)
  const second = await service.applyWriteRequest(
    'run-pptx',
    request(
      {
        type: 'add_slide',
        title: '第二页保持不变',
        body: '第二页正文',
        position: { after: first.slideId }
      },
      1
    ),
    { operationId: 'real-pptx-add-2' }
  )
  assert.equal('slideId' in second, true)
  assert.equal(second.previewConfirmed, true)
  return first.slideId
}

async function setFirstSlideTitle(
  service: AgentHarness['service'],
  slideId: string
): Promise<OfficeWriteRequest> {
  const before = await readPptx(service, 'run-pptx')
  const title = before.slides[0]?.elements.find((element) => element.kind === 'title')
  assert.ok(title?.editable)
  const setRequest = request(
    {
      type: 'set_slide_text',
      slideId,
      elementId: title.elementId,
      text: '标题已修改 & <新>',
      expectedText: title.text
    },
    2
  )
  const changed = await service.applyWriteRequest('run-pptx', setRequest, {
    operationId: 'real-pptx-set-1'
  })
  assert.equal(changed.previewConfirmed, true)
  return setRequest
}

async function assertRejectedTargets(
  service: AgentHarness['service'],
  slideId: string,
  setRequest: OfficeWriteRequest
): Promise<void> {
  if (setRequest.operation.type !== 'set_slide_text') throw new Error('missing set request')
  const cases = [
    {
      operation: { ...setRequest.operation, text: '不得覆盖' },
      id: 'real-pptx-stale',
      code: 'stale_target'
    },
    {
      operation: {
        type: 'set_slide_text' as const,
        slideId: '4294967295',
        elementId: '2',
        text: '不存在'
      },
      id: 'real-pptx-missing-slide',
      code: 'slide_not_found'
    },
    {
      operation: {
        type: 'set_slide_text' as const,
        slideId,
        elementId: '4294967295',
        text: '不存在'
      },
      id: 'real-pptx-missing-element',
      code: 'element_not_found'
    }
  ]
  for (const entry of cases) {
    await assert.rejects(
      service.applyWriteRequest('run-pptx', request(entry.operation, 3), {
        operationId: entry.id
      }),
      { code: entry.code }
    )
  }
}

async function assertFinalPresentation(
  service: AgentHarness['service'],
  draftPath: string
): Promise<void> {
  const read = await readPptx(service, 'run-pptx')
  assert.equal(read.revision, 3)
  assert.deepEqual(
    read.slides.map((slide) => slide.title),
    ['标题已修改 & <新>', '第二页保持不变']
  )
  assert.equal(
    read.slides[0]?.elements.find((element) => element.kind === 'body')?.text,
    '中文正文 & < >'
  )
  const xml = slideXml(draftPath, 1)
  assert.match(xml, /标题已修改/u)
  assert.match(xml, /&amp;.*&lt;新&gt;/u)
  assert.doesNotMatch(xml, /不得覆盖/u)
}

async function restartAndReplay(
  harness: AgentHarness,
  setRequest: OfficeWriteRequest
): Promise<void> {
  await harness.previewEvents?.body?.cancel().catch(() => undefined)
  harness.previewEvents = undefined
  await harness.service.dispose()
  harness.restarted = createOfficeService()
  const reopened = await harness.restarted.open({
    sessionId: harness.session.sessionId,
    projectId: null,
    sourcePath: harness.draftPath,
    allowRoots: [harness.session.dir]
  })
  assert.equal(reopened.state, 'ready')
  if (reopened.state !== 'ready') throw new Error(reopened.message)
  bind(harness.restarted, 'run-restarted', reopened.document.artifactId, harness.session.sessionId)
  const replay = await harness.restarted.applyWriteRequest('run-restarted', setRequest, {
    operationId: 'real-pptx-set-1'
  })
  assert.equal(replay.deduplicated, true)
  const read = await readPptx(harness.restarted, 'run-restarted')
  assert.equal(read.revision, 3)
  if (setRequest.operation.type !== 'set_slide_text') throw new Error('missing set request')
  assert.equal(read.slides[0]?.slideId, setRequest.operation.slideId)
  const title = read.slides[0]?.elements.find((element) => element.kind === 'title')
  assert.equal(title?.elementId, setRequest.operation.elementId)
  assert.equal(title?.text, setRequest.operation.text)
}

async function cleanupAgentHarness(harness: AgentHarness): Promise<void> {
  await harness.previewEvents?.body?.cancel().catch(() => undefined)
  await harness.restarted?.dispose().catch(() => undefined)
  await harness.service.dispose().catch(() => undefined)
  await releaseTransientOfficeResident(binary!, harness.draftPath).catch(() => undefined)
  harness.restoreAgentDir()
  rmSync(harness.root, { recursive: true, force: true })
}

test('real multi-run PPTX text is non-editable and remains unchanged', options, async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-pptx-multirun-'))
  const path = join(root, 'multi-run.pptx')
  try {
    await createMultiRunPresentation(path)
    await assertMultiRunRejected(path)
  } finally {
    await releaseTransientOfficeResident(binary!, path).catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

async function createMultiRunPresentation(path: string): Promise<void> {
  await cli(['create', path, '--type', 'pptx'])
  await cli(['add', path, '/', '--type', 'slide', '--prop', 'title=第一段', '--prop', 'text=正文'])
  await cli([
    'add',
    path,
    '/slide[1]/shape[@id=2]/paragraph[1]',
    '--type',
    'run',
    '--prop',
    'text=第二段',
    '--prop',
    'bold=true'
  ])
}

async function assertMultiRunRejected(path: string): Promise<void> {
  const writer = new OfficePptxWriter()
  const context = { binaryPath: binary!, draftPath: path }
  const snapshot = await writer.read(context)
  const title = snapshot.slides[0]?.elements.find((element) => element.kind === 'title')
  assert.equal(title?.editable, false)
  const before = readFileSync(path)
  await assert.rejects(
    writer.apply(
      context,
      validateOfficePptxOperation({
        type: 'set_slide_text',
        slideId: snapshot.slides[0]!.slideId,
        elementId: title!.elementId,
        text: '不得扁平化',
        expectedText: title!.text
      }),
      snapshot
    ),
    { code: 'element_not_plain' }
  )
  assert.equal(readFileSync(path).equals(before), true)
}

function request(
  operation: OfficeWriteRequest['operation'],
  baseRevision: number
): OfficeWriteRequest {
  return { operation, baseRevision }
}

async function readPptx(
  service: ReturnType<typeof createOfficeService>,
  runId: string
): Promise<OfficePptxReadResult> {
  const value = await service.readRange(runId, {})
  if (!('slides' in value)) throw new Error('missing PPTX slides')
  return value
}

function bind(
  service: ReturnType<typeof createOfficeService>,
  runId: string,
  artifactId: string,
  sessionId: string
): void {
  service.bindRunTarget({ runId, artifactId, sessionId, projectId: null })
}

function createSession(root: string): ReturnType<typeof createPhiSession> {
  return createPhiSession({
    kind: 'ordinary',
    cwd: root,
    cwdRealPath: root,
    permissionMode: 'auto'
  })
}

function withAgentDir(root: string): () => void {
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  return () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  }
}

function slideXml(path: string, index: number): string {
  return execFileSync('/usr/bin/unzip', ['-p', path, `ppt/slides/slide${index}.xml`], {
    encoding: 'utf8'
  })
}

async function cli(args: readonly string[]): Promise<Record<string, unknown>> {
  const result = await runOfficeCli(binary!, [...args, '--json'], {
    timeoutMs: 30_000,
    env: officeCliEnv(process.env, { OFFICECLI_RESIDENT_FLUSH: 'each' })
  })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  const value = JSON.parse(result.stdout) as Record<string, unknown>
  assert.equal(value.success, true)
  return value
}
