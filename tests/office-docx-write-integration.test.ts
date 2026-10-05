import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { officePlatformId } from '../scripts/office/fetch-officecli.mjs'
import { validateOfficeDocxOperation } from '../src/main/agent/office/office-docx-contract'
import type { OfficeDocxReadResult } from '../src/main/agent/office/office-docx-read'
import { OfficeDocxWriter } from '../src/main/agent/office/office-docx-write'
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
  'real DOCX Agent add/set is preview-confirmed, idempotent, saved, and restart-safe',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'phi-docx-agent-'))
    const restoreAgentDir = withAgentDir(root)
    const service = createOfficeService()
    let restarted: ReturnType<typeof createOfficeService> | undefined
    let draftPath = ''
    let previewEvents: Response | undefined
    const outputPath = join(root, '交付.docx')
    try {
      const session = createSession(root)
      const created = await service.create({
        requestId: 'create-docx-agent',
        sessionId: session.sessionId,
        projectId: null,
        kind: 'docx'
      })
      assert.equal(created.state, 'ready')
      if (created.state !== 'ready') throw new Error(created.message)
      draftPath = created.document.draftPath
      previewEvents = await fetch(`${created.document.previewUrl}events`)
      bind(service, 'run-docx', created.document.artifactId, session.sessionId)

      const initial = await readDocx(service, 'run-docx')
      assert.equal(initial.revision, 0)
      assert.equal(initial.total, 0)

      const firstRequest = request({ type: 'add_paragraph', text: '第一段 & <Phi>' }, 0)
      const first = await service.applyWriteRequest('run-docx', firstRequest, {
        operationId: 'real-docx-add-1'
      })
      assert.equal(first.previewConfirmed, true)
      assert.equal('paraId' in first, true)
      if (!('paraId' in first)) throw new Error('missing paraId')
      const firstParaId = first.paraId

      const replay = await service.applyWriteRequest('run-docx', firstRequest, {
        operationId: 'real-docx-add-1'
      })
      assert.equal(replay.deduplicated, true)

      const second = await service.applyWriteRequest(
        'run-docx',
        request(
          {
            type: 'add_paragraph',
            text: '第二段保持不变',
            position: { after: firstParaId }
          },
          1
        ),
        { operationId: 'real-docx-add-2' }
      )
      assert.equal(second.previewConfirmed, true)

      const setRequest = request(
        {
          type: 'set_paragraph_text',
          paraId: firstParaId,
          text: '第一段已修改 & <新>',
          expectedText: '第一段 & <Phi>'
        },
        2
      )
      const changed = await service.applyWriteRequest('run-docx', setRequest, {
        operationId: 'real-docx-set-1'
      })
      assert.equal(changed.previewConfirmed, true)

      await assert.rejects(
        service.applyWriteRequest(
          'run-docx',
          request(
            {
              type: 'set_paragraph_text',
              paraId: firstParaId,
              text: '不得覆盖',
              expectedText: '第一段 & <Phi>'
            },
            3
          ),
          { operationId: 'real-docx-stale' }
        ),
        { code: 'stale_target' }
      )

      const read = await readDocx(service, 'run-docx')
      assert.equal(read.revision, 3)
      assert.deepEqual(
        read.paragraphs.map((paragraph) => paragraph.text),
        ['第一段已修改 & <新>', '第二段保持不变']
      )
      assert.equal(read.paragraphs[0]?.paraId, firstParaId)
      const xml = documentXml(draftPath)
      assert.match(xml, /第一段已修改/u)
      assert.match(xml, /&amp;.*&lt;新&gt;/u)
      assert.match(xml, /第二段保持不变/u)
      assert.doesNotMatch(xml, /不得覆盖/u)

      const output = await service.saveAsDocument(
        created.document.artifactId,
        session.sessionId,
        root,
        outputPath
      )
      assert.equal(output.outputPath, '交付.docx')
      assert.equal(readFileSync(outputPath).equals(readFileSync(draftPath)), true)

      await service.dispose()
      restarted = createOfficeService()
      const reopened = await restarted.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath: draftPath,
        allowRoots: [session.dir]
      })
      assert.equal(reopened.state, 'ready')
      if (reopened.state !== 'ready') throw new Error(reopened.message)
      bind(restarted, 'run-restarted', reopened.document.artifactId, session.sessionId)
      const replayAfterRestart = await restarted.applyWriteRequest('run-restarted', setRequest, {
        operationId: 'real-docx-set-1'
      })
      assert.equal(replayAfterRestart.deduplicated, true)
      assert.equal((await readDocx(restarted, 'run-restarted')).revision, 3)
    } finally {
      await previewEvents?.body?.cancel().catch(() => undefined)
      await restarted?.dispose().catch(() => undefined)
      await service.dispose().catch(() => undefined)
      if (draftPath) await releaseTransientOfficeResident(binary!, draftPath).catch(() => undefined)
      await releaseTransientOfficeResident(binary!, outputPath).catch(() => undefined)
      restoreAgentDir()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'real multi-run DOCX paragraphs are non-editable and remain byte-for-byte unchanged',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'phi-docx-multirun-'))
    const path = join(root, 'multi-run.docx')
    try {
      await cli(['create', path])
      const added = await cli(['add', path, '/body', '--type', 'paragraph'])
      const match = /paraId=([0-9A-F]{8})/iu.exec(String(added.data))
      assert.ok(match)
      const paraId = match[1]!.toUpperCase()
      const paragraphPath = `/body/p[@paraId=${paraId}]`
      await cli([
        'add',
        path,
        paragraphPath,
        '--type',
        'run',
        '--prop',
        'text=粗体',
        '--prop',
        'bold=true'
      ])
      await cli([
        'add',
        path,
        paragraphPath,
        '--type',
        'run',
        '--prop',
        'text=斜体',
        '--prop',
        'italic=true'
      ])
      const before = readFileSync(path)
      const writer = new OfficeDocxWriter()
      const context = { binaryPath: binary!, draftPath: path }
      const snapshot = await writer.read(context)

      assert.equal(snapshot.paragraphs[0]?.editable, false)
      await assert.rejects(
        writer.apply(
          context,
          validateOfficeDocxOperation({
            type: 'set_paragraph_text',
            paraId,
            text: '不得扁平化',
            expectedText: '粗体斜体'
          }),
          snapshot
        ),
        { code: 'paragraph_not_plain' }
      )
      assert.equal(readFileSync(path).equals(before), true)
    } finally {
      await releaseTransientOfficeResident(binary!, path).catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test('a run-bound DOCX write never inserts into another session document', options, async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-docx-isolation-'))
  const restoreAgentDir = withAgentDir(root)
  const service = createOfficeService()
  let previewEvents: Response | undefined
  try {
    const firstSession = createSession(root)
    const secondSession = createSession(root)
    const first = await service.create({
      requestId: 'create-first-docx',
      sessionId: firstSession.sessionId,
      projectId: null,
      kind: 'docx'
    })
    const second = await service.create({
      requestId: 'create-second-docx',
      sessionId: secondSession.sessionId,
      projectId: null,
      kind: 'docx'
    })
    assert.equal(first.state, 'ready')
    assert.equal(second.state, 'ready')
    if (first.state !== 'ready' || second.state !== 'ready') throw new Error('create failed')
    previewEvents = await fetch(`${first.document.previewUrl}events`)
    const secondBefore = readFileSync(second.document.draftPath)
    bind(service, 'run-first', first.document.artifactId, firstSession.sessionId)
    bind(service, 'run-second', second.document.artifactId, secondSession.sessionId)

    await service.applyWriteRequest(
      'run-first',
      request({ type: 'add_paragraph', text: '只进入第一份文档' }, 0),
      { operationId: 'isolated-docx-add' }
    )

    assert.equal((await readDocx(service, 'run-first')).total, 1)
    assert.equal((await readDocx(service, 'run-second')).total, 0)
    assert.equal(readFileSync(second.document.draftPath).equals(secondBefore), true)
  } finally {
    await previewEvents?.body?.cancel().catch(() => undefined)
    await service.dispose().catch(() => undefined)
    restoreAgentDir()
    rmSync(root, { recursive: true, force: true })
  }
})

function request(
  operation: OfficeWriteRequest['operation'],
  baseRevision: number
): OfficeWriteRequest {
  return { operation, baseRevision }
}

async function readDocx(
  service: ReturnType<typeof createOfficeService>,
  runId: string
): Promise<OfficeDocxReadResult> {
  const value = await service.readRange(runId, {})
  if (!('paragraphs' in value)) throw new Error('missing DOCX paragraphs')
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

function documentXml(path: string): string {
  return execFileSync('/usr/bin/unzip', ['-p', path, 'word/document.xml'], { encoding: 'utf8' })
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
