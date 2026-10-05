import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { officePlatformId } from '../scripts/office/fetch-officecli.mjs'
import { officeCliEnv, runOfficeCli } from '../src/main/agent/office/office-driver'
import { OfficeRangeReader } from '../src/main/agent/office/office-read'
import type { OfficeReadParams, OfficeReadResponse } from '../src/main/agent/office/office-read'
import { officeBinaryCandidates } from '../src/main/agent/office/office-runtime'
import { createOfficeReadHostHandler } from '../src/main/agent/office/office-tool-host'
import {
  createOfficeService,
  OfficeService,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'
import { createPhiSession } from '../src/main/agent/session/session-store'

const platformId = officePlatformId()
const bundledOfficeDir = join(process.cwd(), 'resources', 'office')
const binary = platformId ? officeBinaryCandidates(platformId, { bundledOfficeDir })[0] : undefined
const enabled = process.env.PHI_OFFICE_INTEGRATION === '1' && !!binary && existsSync(binary)
const options = {
  skip: enabled ? false : 'set PHI_OFFICE_INTEGRATION=1 and run bun run office:fetch'
}

interface CliEnvelope {
  success: boolean
  data: {
    results: Array<{ children?: Array<{ text: string }> }>
  }
}

async function json(args: readonly string[], env = officeCliEnv()): Promise<CliEnvelope> {
  const result = await runOfficeCli(binary!, [...args, '--json'], { env, timeoutMs: 30_000 })
  assert.equal(result.exitCode, 0, result.stderr)
  const value = JSON.parse(result.stdout) as CliEnvelope
  assert.equal(value.success, true)
  return value
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

function workbookXml(path: string): string {
  return execFileSync('/usr/bin/unzip', ['-p', path, 'xl/worksheets/sheet1.xml'], {
    encoding: 'utf8'
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

function integrationHost(
  service: OfficeService,
  runs: Readonly<Record<string, string>>
): ReturnType<typeof createOfficeReadHostHandler> {
  return createOfficeReadHostHandler({
    resolveActiveRun: (originSessionId) => {
      const runId = runs[originSessionId]
      return runId ? { runId } : undefined
    },
    readRange: (runId, params) => service.readRange(runId, params)
  })
}

async function hostRead(
  host: ReturnType<typeof createOfficeReadHostHandler>,
  originSessionId: string,
  params: OfficeReadParams
): Promise<OfficeReadResponse> {
  const result = await host(params, { originSessionId })
  assert.equal(result.ok, true, JSON.stringify(result))
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

test(
  'real readRange maps A1:B3, uses the bound selection, and returns overview guidance',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office read range '))
    const restoreAgentDir = withAgentDir(root)
    const sourcePath = join(root, 'read-range.xlsx')
    const service = createOfficeService()
    let draftPath = ''
    try {
      await json(['create', sourcePath])
      await json(['set', sourcePath, '/Sheet1/A1', '--prop', 'value=10'])
      await json(['set', sourcePath, '/Sheet1/B1', '--prop', 'value=中文'])
      await json(['set', sourcePath, '/Sheet1/A2', '--prop', 'formula=SUM(A1,5)'])
      await json(['set', sourcePath, '/Sheet1/B2', '--prop', 'formula=NOSUCHFN(A1)'])
      await json(['set', sourcePath, '/Sheet1/B3', '--prop', 'value= '])
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
      service.bindRunTarget({
        runId: 'read-selection',
        artifactId: opened.document.artifactId,
        sessionId: session.sessionId,
        projectId: null,
        selection: {
          sheet: 'Sheet1',
          range: 'A1:B3',
          paths: ['/Sheet1/A1:B3'],
          resolvedAt: '2026-10-04T12:00:00.000Z'
        }
      })

      const host = integrationHost(service, {
        'runtime-selection': 'read-selection',
        'runtime-overview': 'read-overview',
        'runtime-other-session': 'other-session-run'
      })
      const read = await hostRead(host, 'runtime-selection', {})
      assert.ok('cells' in read)
      assert.equal(read.revision, 0)
      assert.equal(read.range, 'A1:B3')
      assert.deepEqual(read.cells, [
        { ref: 'A1', value: 10, valueType: 'number' },
        { ref: 'B1', value: '中文', valueType: 'string' },
        { ref: 'A2', value: 15, formula: '=SUM(A1,5)', valueType: 'number', evaluated: true },
        {
          ref: 'B2',
          value: null,
          formula: '=NOSUCHFN(A1)',
          valueType: 'error',
          evaluated: false,
          error: 'unsupported_function'
        },
        { ref: 'A3', value: null, valueType: 'empty' },
        { ref: 'B3', value: ' ', valueType: 'string' }
      ])

      service.bindRunTarget({
        runId: 'read-overview',
        artifactId: opened.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })
      const overview = await hostRead(host, 'runtime-overview', {})
      assert.ok('sheets' in overview)
      assert.deepEqual(overview.sheets, [
        { name: 'Sheet1', usedRange: 'A1:B3', rowCount: 3, columnCount: 2 }
      ])
      assert.equal(overview.complete, false)
      assert.match(overview.hint, /sheet.*range/)

      const otherSession = await host({}, { originSessionId: 'runtime-other-session' })
      assert.equal(otherSession.ok, false)
      if (!otherSession.ok) assert.equal(otherSession.error.code, 'no_target')
      await service.close(opened.document.artifactId, session.sessionId)
      const background = await host({}, { originSessionId: 'runtime-selection' })
      assert.equal(background.ok, true)
      assert.equal(service.clearRunTarget('read-selection'), true)
      const closed = await host({}, { originSessionId: 'runtime-selection' })
      assert.equal(closed.ok, false)
      if (!closed.ok) assert.equal(closed.error.code, 'target_missing')
    } finally {
      await service.dispose()
      if (draftPath) assert.equal(lsof(draftPath), '')
      await runOfficeCli(binary!, ['close', sourcePath, '--json'], { timeoutMs: 15_000 }).catch(
        () => undefined
      )
      restoreAgentDir()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test('a read rebuilds this test document after its resident exits', options, async () => {
  const root = mkdtempSync(join(tmpdir(), 'office idle recovery '))
  const restoreAgentDir = withAgentDir(root)
  const sourcePath = join(root, 'idle.xlsx')
  const service = createOfficeService()
  let draftPath = ''
  try {
    await json(['create', sourcePath])
    await json(['set', sourcePath, '/Sheet1/A1', '--prop', 'value=恢复内容'])
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
    service.bindRunTarget({
      runId: 'idle-recovery-run',
      artifactId: opened.document.artifactId,
      sessionId: session.sessionId,
      projectId: null
    })

    process.kill(opened.document.residentPid, 'SIGTERM')
    await waitUntil(
      () => !processAlive(opened.document.residentPid),
      'test resident did not exit after SIGTERM'
    )
    const recovered = await service.readRange('idle-recovery-run', {
      sheet: 'Sheet1',
      range: 'A1'
    })
    assert.ok('cells' in recovered)
    if (!('cells' in recovered)) throw new Error('missing recovered cells')
    assert.equal(recovered.cells[0]?.value, '恢复内容')
    const status = service.statusForSource(session.sessionId, sourcePath)
    assert.equal(status?.state, 'ready')
    if (status?.state === 'ready') {
      assert.notEqual(status.document.residentPid, opened.document.residentPid)
      assert.equal(processAlive(status.document.residentPid), true)
    }
  } finally {
    await service.dispose().catch(() => undefined)
    if (draftPath) assert.equal(lsof(draftPath), '')
    await runOfficeCli(binary!, ['close', sourcePath, '--json'], { timeoutMs: 15_000 }).catch(
      () => undefined
    )
    restoreAgentDir()
    rmSync(root, { recursive: true, force: true })
  }
})

test(
  'real readRange pages 1,000x10 without omissions and matches one full resident get',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office read pages '))
    const restoreAgentDir = withAgentDir(root)
    const sourcePath = join(root, 'large.xlsx')
    const csvPath = join(root, 'large.csv')
    const rows = Array.from({ length: 1_000 }, (_, row) =>
      Array.from({ length: 10 }, (_, column) => `${row + 1}-${column + 1}`).join(',')
    ).join('\n')
    writeFileSync(csvPath, rows)
    const service = createOfficeService()
    let draftPath = ''
    try {
      await json(['create', sourcePath])
      await json(['import', sourcePath, '/Sheet1', csvPath])
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
      service.bindRunTarget({
        runId: 'read-large',
        artifactId: opened.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })
      const host = integrationHost(service, { 'runtime-large': 'read-large' })

      const paged: Array<string | number | boolean | null> = []
      const refs = new Set<string>()
      let cursor: string | undefined
      let pageCount = 0
      do {
        const page = await hostRead(
          host,
          'runtime-large',
          cursor ? { cursor } : { sheet: 'Sheet1', range: 'A1:J1000' }
        )
        assert.ok('cells' in page)
        assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 256 * 1024)
        pageCount += 1
        for (const cell of page.cells) {
          paged.push(cell.value)
          assert.equal(refs.has(cell.ref), false)
          refs.add(cell.ref)
        }
        cursor = page.nextCursor
      } while (cursor)

      const full = await json(['get', draftPath, '/Sheet1/A1:J1000'])
      const expected = (full.data.results[0]?.children ?? []).map((cell) => cell.text)
      assert.equal(pageCount, 5)
      assert.equal(paged.length, 10_000)
      assert.equal(refs.size, 10_000)
      assert.deepEqual(paged, expected)
    } finally {
      await service.dispose()
      if (draftPath) assert.equal(lsof(draftPath), '')
      await runOfficeCli(binary!, ['close', sourcePath, '--json'], { timeoutMs: 15_000 }).catch(
        () => undefined
      )
      restoreAgentDir()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'readRange sees resident changes while flush is off and the XLSX bytes remain stale',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office read unflushed '))
    const restoreAgentDir = withAgentDir(root)
    const draftPath = join(root, 'unflushed.xlsx')
    const isolatedHome = join(root, 'home')
    const isolatedTmp = join(root, 'tmp')
    mkdirSync(isolatedHome)
    mkdirSync(isolatedTmp)
    const env = officeCliEnv(
      { ...process.env, HOME: isolatedHome, TMPDIR: isolatedTmp },
      { OFFICECLI_RESIDENT_FLUSH: 'off' }
    )
    const reader = new OfficeRangeReader({
      run: (_binaryPath, args, runOptions) =>
        runOfficeCli(binary!, args, { ...runOptions, env, timeoutMs: 30_000 })
    })
    let service: OfficeService | undefined
    try {
      await json(['create', draftPath], env)
      const before = workbookXml(draftPath)
      await json(['set', draftPath, '/Sheet1/A1', '--prop', 'value=UNFLUSHED_VALUE'], env)
      assert.equal(workbookXml(draftPath), before)
      assert.doesNotMatch(before, /UNFLUSHED_VALUE/)
      const session = createPhiSession({
        kind: 'ordinary',
        cwd: root,
        cwdRealPath: root,
        permissionMode: 'auto'
      })
      const dependencies: OfficeServiceDependencies = {
        detectRuntime: async () => ({
          state: 'available',
          binaryPath: binary!,
          version: '1.0.153',
          platform: 'darwin-arm64'
        }),
        prepareDraft: async (input) => ({
          artifactId: 'unflushed-artifact',
          sessionId: input.sessionId,
          projectId: input.projectId,
          sourcePath: input.sourcePath,
          sourceHash: 'integration',
          draftPath
        }),
        prepareBlankDraft: async () => {
          throw new Error('unused')
        },
        startDocument: async () => ({ residentPid: 1 }),
        adoptCreatedDocument: async () => ({ residentPid: 1 }),
        startPreview: async () => ({
          watchPid: 0,
          watchPort: 0,
          gatewayPort: 0,
          previewUrl: 'http://127.0.0.1:1/'
        }),
        stopPreview: async () => undefined,
        closeDocument: async () => {
          await json(['close', draftPath], env)
        },
        removeBlankDraft: async () => undefined,
        validateRegisteredDraft: async () => undefined,
        assertNotOfficeArtifactPath: async () => undefined,
        resolveSelection: async () => null,
        clearSelection: async () => undefined,
        readRange: (context, params) => reader.read(context, params)
      }
      service = new OfficeService(dependencies)
      const opened = await service.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath: draftPath,
        allowRoots: [root]
      })
      assert.equal(opened.state, 'ready')
      if (opened.state !== 'ready') throw new Error(opened.message)
      service.bindRunTarget({
        runId: 'unflushed-run',
        artifactId: opened.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })

      const host = integrationHost(service, { 'runtime-unflushed': 'unflushed-run' })
      const read = await hostRead(host, 'runtime-unflushed', {
        sheet: 'Sheet1',
        range: 'A1'
      })
      assert.ok('cells' in read)
      assert.equal(read.cells[0]?.value, 'UNFLUSHED_VALUE')
      assert.equal(workbookXml(draftPath), before)
    } finally {
      await service?.dispose().catch(() => undefined)
      await runOfficeCli(binary!, ['close', draftPath, '--json'], {
        env,
        timeoutMs: 15_000
      }).catch(() => undefined)
      assert.equal(lsof(draftPath), '')
      restoreAgentDir()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
