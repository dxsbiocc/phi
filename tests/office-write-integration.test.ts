import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { get as getHttp } from 'node:http'
import test from 'node:test'

import { officePlatformId } from '../scripts/office/fetch-officecli.mjs'
import { officeCliEnv, runOfficeCli } from '../src/main/agent/office/office-driver'
import { officeBinaryCandidates } from '../src/main/agent/office/office-runtime'
import { createOfficeService } from '../src/main/agent/office/office-service'
import { assertSuccessfulCellBatch } from '../src/main/agent/office/office-write-parser'
import { createPhiSession } from '../src/main/agent/session/session-store'

const platformId = officePlatformId()
const bundledOfficeDir = join(process.cwd(), 'resources', 'office')
const binary = platformId ? officeBinaryCandidates(platformId, { bundledOfficeDir })[0] : undefined
const enabled = process.env.PHI_OFFICE_INTEGRATION === '1' && !!binary && existsSync(binary)
const options = {
  skip: enabled ? false : 'set PHI_OFFICE_INTEGRATION=1 and run bun run office:fetch'
}

function withAgentDir(root: string): () => void {
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  return () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  }
}

async function json(args: readonly string[]): Promise<{ success?: unknown }> {
  const result = await runOfficeCli(binary!, [...args, '--json'], {
    env: officeCliEnv(),
    timeoutMs: 30_000
  })
  assert.equal(result.exitCode, 0, result.stderr)
  const value = JSON.parse(result.stdout) as { success?: unknown }
  assert.equal(value.success, true)
  return value
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function worksheetXml(path: string): string {
  return execFileSync('/usr/bin/unzip', ['-p', path, 'xl/worksheets/sheet1.xml'], {
    encoding: 'utf8'
  })
}

function lsof(path: string): string {
  try {
    return execFileSync('/usr/sbin/lsof', ['-t', '-a', '-c', 'officecli', '--', path], {
      encoding: 'utf8'
    })
  } catch {
    return ''
  }
}

function connectEventStream(url: string): Promise<{ close: () => void; ready: Promise<void> }> {
  return new Promise((resolve, reject) => {
    let body = ''
    let markReady!: () => void
    const ready = new Promise<void>((resolveReady) => {
      markReady = resolveReady
    })
    const request = getHttp(url, (response) => {
      response.on('data', (chunk: Buffer) => {
        body = `${body}${chunk.toString('utf8')}`.slice(-64 * 1024)
        if (body.includes('"action":"full"')) markReady()
      })
      response.once('error', () => undefined)
      resolve({ close: () => request.destroy(), ready })
    })
    request.once('error', reject)
  })
}

async function waitForPreviewReady(ready: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('preview SSE did not become ready')), 5_000)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

test(
  'real applyCellEdit writes, verifies, saves, previews, and increments revision',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office write engine '))
    const restoreAgentDir = withAgentDir(root)
    const sourcePath = join(root, 'source.xlsx')
    const service = createOfficeService()
    let eventStream: Awaited<ReturnType<typeof connectEventStream>> | undefined
    let draftPath = ''
    try {
      await json(['create', sourcePath])
      await json(['close', sourcePath])
      const sourceDigest = digest(sourcePath)
      const session = createPhiSession({
        kind: 'ordinary',
        cwd: root,
        cwdRealPath: root,
        permissionMode: 'auto'
      })
      const opened = await service.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath,
        allowRoots: [root]
      })
      assert.equal(opened.state, 'ready')
      if (opened.state !== 'ready') throw new Error(opened.message)
      draftPath = opened.document.draftPath
      service.bindRunTarget({
        runId: 'write-run',
        artifactId: opened.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })
      await (await fetch(opened.document.previewUrl)).text()
      eventStream = await connectEventStream(`${opened.document.previewUrl}events`)
      await json([
        'set',
        draftPath,
        '/Sheet1/J10',
        '--prop',
        'value=preview-ready',
        '--prop',
        'type=string'
      ])
      await waitForPreviewReady(eventStream.ready)

      const first = await service.applyCellEdit(
        'write-run',
        { sheet: 'Sheet1', cell: 'A1', value: '实验编号', baseRevision: 0 },
        { operationId: 'write-a1' }
      )
      assert.deepEqual(first, {
        sheet: 'Sheet1',
        cell: 'A1',
        before: null,
        after: '实验编号',
        revision: 1,
        applied: true,
        saved: true,
        previewConfirmed: true
      })
      const stringResult = await service.applyCellEdit(
        'write-run',
        { sheet: 'Sheet1', cell: 'A2', value: '123', baseRevision: 1 },
        { operationId: 'write-a2' }
      )
      const numberResult = await service.applyCellEdit(
        'write-run',
        { sheet: 'Sheet1', cell: 'A3', value: 123, baseRevision: 2 },
        { operationId: 'write-a3' }
      )
      const booleanResult = await service.applyCellEdit(
        'write-run',
        { sheet: 'Sheet1', cell: 'A4', value: true, baseRevision: 3 },
        { operationId: 'write-a4' }
      )
      assert.deepEqual(
        [stringResult.revision, numberResult.revision, booleanResult.revision],
        [2, 3, 4]
      )

      const read = await service.readRange('write-run', { sheet: 'Sheet1', range: 'A1:A4' })
      assert.ok('cells' in read)
      assert.deepEqual(
        read.cells.map(({ value, valueType }) => ({ value, valueType })),
        [
          { value: '实验编号', valueType: 'string' },
          { value: '123', valueType: 'string' },
          { value: 123, valueType: 'number' },
          { value: true, valueType: 'boolean' }
        ]
      )
      assert.equal(read.revision, 4)
      assert.match(worksheetXml(draftPath), /实验编号/)
      assert.equal(digest(sourcePath), sourceDigest)
      assert.doesNotMatch(worksheetXml(sourcePath), /实验编号/)

      await assert.rejects(
        service.applyCellEdit(
          'write-run',
          { sheet: 'Sheet1', cell: 'A1', value: 'stale', baseRevision: 0 },
          { operationId: 'write-stale' }
        ),
        { code: 'revision_conflict' }
      )
      await assert.rejects(
        service.applyCellEdit(
          'write-run',
          { sheet: 'Missing', cell: 'A1', value: 'x', baseRevision: 4 },
          { operationId: 'write-invalid-sheet' }
        ),
        { code: 'invalid_sheet' }
      )
      await assert.rejects(
        service.applyCellEdit(
          'write-run',
          { sheet: 'Sheet1', cell: 'XFE1', value: 'x', baseRevision: 4 },
          { operationId: 'write-invalid-cell' }
        ),
        { code: 'invalid_cell' }
      )
      await assert.rejects(
        service.applyCellEdit(
          'write-run',
          { sheet: 'Sheet1', cell: 'A1', value: '=SUM(A1:A4)', baseRevision: 4 },
          { operationId: 'write-formula' }
        ),
        { code: 'formula_not_supported' }
      )
      const unchanged = await service.readRange('write-run', { sheet: 'Sheet1', range: 'A1' })
      assert.ok('cells' in unchanged)
      assert.equal(unchanged.cells[0]?.value, '实验编号')

      const otherSession = createPhiSession({
        kind: 'ordinary',
        cwd: root,
        cwdRealPath: root,
        permissionMode: 'auto'
      })
      assert.throws(
        () =>
          service.bindRunTarget({
            runId: 'cross-session',
            artifactId: opened.document.artifactId,
            sessionId: otherSession.sessionId,
            projectId: null
          }),
        { code: 'target_session_mismatch' }
      )
    } finally {
      eventStream?.close()
      await service.dispose()
      if (draftPath) assert.equal(lsof(draftPath), '')
      await runOfficeCli(binary!, ['close', sourcePath, '--json'], { timeoutMs: 15_000 }).catch(
        () => undefined
      )
      assert.equal(lsof(sourcePath), '')
      restoreAgentDir()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test('real OfficeCLI exit 2 and discarded batch properties are rejected', options, async () => {
  const root = mkdtempSync(join(tmpdir(), 'office write warnings '))
  const draftPath = join(root, 'warnings.xlsx')
  try {
    await json(['create', draftPath])
    const direct = await runOfficeCli(
      binary!,
      ['set', draftPath, '/Sheet1/A1', '--prop', 'color=red', '--json'],
      { env: officeCliEnv(), timeoutMs: 30_000 }
    )
    assert.equal(direct.exitCode, 2)
    assert.equal((JSON.parse(direct.stdout) as { success: boolean }).success, false)

    const commands = JSON.stringify([
      {
        command: 'set',
        path: '/Sheet1/A1',
        props: { value: 'kept', type: 'string', color: 'red' }
      }
    ])
    const batch = await runOfficeCli(
      binary!,
      ['batch', draftPath, '--commands', commands, '--json'],
      { env: officeCliEnv(), timeoutMs: 30_000 }
    )
    assert.equal(batch.exitCode, 0)
    assert.match(batch.stdout, /UNSUPPORTED props: color/)
    assert.throws(() => assertSuccessfulCellBatch(batch), {
      code: 'write_failed'
    })
  } finally {
    await runOfficeCli(binary!, ['close', draftPath, '--json'], { timeoutMs: 15_000 }).catch(
      () => undefined
    )
    assert.equal(lsof(draftPath), '')
    rmSync(root, { recursive: true, force: true })
  }
})

test(
  'killing this test resident during a write reconciles without replaying the batch',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office write resident death '))
    const restoreAgentDir = withAgentDir(root)
    const sourcePath = join(root, 'source.xlsx')
    let residentPid = 0
    let batchCalls = 0
    const service = createOfficeService({
      runOfficeCli: (binaryPath, args, runOptions = {}) => {
        if (args[0] !== 'batch' || residentPid <= 0) {
          return runOfficeCli(binaryPath, args, runOptions)
        }
        batchCalls += 1
        return runOfficeCli(binaryPath, args, {
          ...runOptions,
          onSpawn: (pid) => {
            runOptions.onSpawn?.(pid)
            process.kill(residentPid, 'SIGTERM')
          }
        })
      }
    })
    let draftPath = ''
    try {
      await json(['create', sourcePath])
      await json(['close', sourcePath])
      const session = createPhiSession({
        kind: 'ordinary',
        cwd: root,
        cwdRealPath: root,
        permissionMode: 'auto'
      })
      const opened = await service.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath,
        allowRoots: [root]
      })
      assert.equal(opened.state, 'ready')
      if (opened.state !== 'ready') throw new Error(opened.message)
      draftPath = opened.document.draftPath
      residentPid = opened.document.residentPid
      service.bindRunTarget({
        runId: 'resident-death-run',
        artifactId: opened.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })

      await assert.rejects(
        service.applyCellEdit(
          'resident-death-run',
          { sheet: 'Sheet1', cell: 'A1', value: '不得重放', baseRevision: 0 },
          { operationId: 'resident-death-write' }
        ),
        { code: 'write_not_applied' }
      )
      assert.equal(batchCalls, 1)
      const status = service.statusForSource(session.sessionId, sourcePath)
      assert.equal(status?.state, 'ready')
      if (status?.state === 'ready') assert.equal(status.freezeState, undefined)
      assert.doesNotThrow(() => service.assertWritable(opened.document.artifactId))
    } finally {
      await service.dispose().catch(() => undefined)
      if (draftPath) assert.equal(lsof(draftPath), '')
      await runOfficeCli(binary!, ['close', sourcePath, '--json'], { timeoutMs: 15_000 }).catch(
        () => undefined
      )
      restoreAgentDir()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
