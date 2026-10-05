import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { officePlatformId } from '../scripts/office/fetch-officecli.mjs'
import type { OfficeDocumentKind } from '../src/shared/officeProtocol'
import { OfficeDocxWriter } from '../src/main/agent/office/office-docx-write'
import { OfficePptxWriter } from '../src/main/agent/office/office-pptx-write'
import { releaseTransientOfficeResident } from '../src/main/agent/office/office-process'
import { OfficeRangeReader } from '../src/main/agent/office/office-read'
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
  'real XLSX, DOCX, and PPTX writes deliver independently readable native files',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'phi-office-deliver-'))
    const restoreAgentDir = withAgentDir(root)
    const service = createOfficeService()
    const outputs: string[] = []
    try {
      const session = createPhiSession({
        kind: 'ordinary',
        cwd: root,
        cwdRealPath: realpathSync(root),
        permissionMode: 'auto'
      })
      for (const kind of ['xlsx', 'docx', 'pptx'] as const) {
        const output = await createWriteDeliver(service, session.sessionId, root, kind)
        outputs.push(output)
        await assertIndependentRead(kind, output)
        await releaseTransientOfficeResident(binary!, output)
        assertNoResident(output)
      }
    } finally {
      await service.dispose().catch(() => undefined)
      for (const output of outputs) {
        await releaseTransientOfficeResident(binary!, output).catch(() => undefined)
      }
      restoreAgentDir()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

async function createWriteDeliver(
  service: ReturnType<typeof createOfficeService>,
  sessionId: string,
  root: string,
  kind: OfficeDocumentKind
): Promise<string> {
  const created = await service.create({
    requestId: `create-deliver-${kind}`,
    sessionId,
    projectId: null,
    kind
  })
  assert.equal(created.state, 'ready')
  if (created.state !== 'ready') throw new Error(created.message)
  const runId = `deliver-${kind}`
  service.bindRunTarget({
    runId,
    artifactId: created.document.artifactId,
    sessionId,
    projectId: null
  })
  await writeExpectedContent(service, runId, kind)
  const delivered = await service.deliverDocument(
    runId,
    root,
    realpathSync(root),
    `native-${kind}`,
    { operationId: `deliver-operation-${kind}` }
  )
  assert.equal(delivered.kind, kind)
  assert.deepEqual(
    delivered.checks.map((check) => check.name),
    ['schema', `${kind}_content`]
  )
  const contentCheck = delivered.checks[1]
  assert.equal(contentCheck?.sampled, 1)
  if (kind === 'pptx') assert.equal(contentCheck?.pageCount, 1)
  return delivered.absolutePath
}

async function writeExpectedContent(
  service: ReturnType<typeof createOfficeService>,
  runId: string,
  kind: OfficeDocumentKind
): Promise<void> {
  if (kind === 'xlsx') {
    await service.applyCellEdit(
      runId,
      { sheet: 'Sheet1', cell: 'A1', value: '交付表格', baseRevision: 0 },
      { operationId: 'delivery-xlsx-write' }
    )
    return
  }
  const operation: OfficeWriteRequest['operation'] =
    kind === 'docx'
      ? { type: 'add_paragraph', text: '交付文档正文' }
      : { type: 'add_slide', title: '交付演示标题', body: '交付演示正文' }
  await service.applyWriteRequest(
    runId,
    { operation, baseRevision: 0 },
    {
      operationId: `delivery-${kind}-write`
    }
  )
}

async function assertIndependentRead(kind: OfficeDocumentKind, outputPath: string): Promise<void> {
  const context = { binaryPath: binary!, draftPath: outputPath }
  if (kind === 'docx') {
    const snapshot = await new OfficeDocxWriter().read(context)
    assert.equal(snapshot.paragraphs[0]?.text, '交付文档正文')
    return
  }
  if (kind === 'pptx') {
    const snapshot = await new OfficePptxWriter().read(context)
    assert.equal(snapshot.slideCount, 1)
    assert.equal(snapshot.slides[0]?.title, '交付演示标题')
    return
  }
  const read = await new OfficeRangeReader().read(
    { artifactId: 'independent-output', revision: 1, ...context },
    { sheet: 'Sheet1', range: 'A1' }
  )
  assert.ok('cells' in read)
  assert.equal(read.cells[0]?.value, '交付表格')
}

function assertNoResident(path: string): void {
  try {
    const commands = execFileSync('/bin/ps', ['-axo', 'command'], { encoding: 'utf8' })
    assert.equal(
      commands
        .split('\n')
        .some((line) => line.includes('__resident-serve__') && line.includes(path)),
      false
    )
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error
  }
}

function withAgentDir(root: string): () => void {
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  return () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  }
}
