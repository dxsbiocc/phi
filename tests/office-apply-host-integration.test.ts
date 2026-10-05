import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { get as getHttp } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { officePlatformId } from '../scripts/office/fetch-officecli.mjs'
import { officeCliEnv, runOfficeCli } from '../src/main/agent/office/office-driver'
import { officeBinaryCandidates } from '../src/main/agent/office/office-runtime'
import { createOfficeService } from '../src/main/agent/office/office-service'
import {
  officeOperationDigest,
  persistOfficeOperationLog
} from '../src/main/agent/office/office-operation-log'
import {
  createOfficeApplyHostHandler,
  createOfficeDescribeHostHandler,
  createOfficeReadHostHandler
} from '../src/main/agent/office/office-tool-host'
import { createPhiSession } from '../src/main/agent/session/session-store'

const platformId = officePlatformId()
const bundledOfficeDir = join(process.cwd(), 'resources', 'office')
const binary = platformId ? officeBinaryCandidates(platformId, { bundledOfficeDir })[0] : undefined
const enabled = process.env.PHI_OFFICE_INTEGRATION === '1' && !!binary && existsSync(binary)
const options = {
  skip: enabled ? false : 'set PHI_OFFICE_INTEGRATION=1 and run bun run office:fetch'
}

const runId = 'office-apply-host-run'
const originSessionId = 'runtime-main'
const otherOriginSessionId = 'runtime-other'

interface ApplyInput {
  readonly operation:
    | {
        readonly type: 'set_cell'
        readonly sheet: string
        readonly cell: string
        readonly value: string | number | boolean
      }
    | {
        readonly type: 'set_range'
        readonly sheet: string
        readonly range: string
        readonly values: readonly (readonly (string | number | boolean)[])[]
      }
  readonly baseRevision: number
}

interface HostFixture {
  readonly draftPath: string
  readonly read: ReturnType<typeof createOfficeReadHostHandler>
  readonly describe: ReturnType<typeof createOfficeDescribeHostHandler>
  apply(
    input: ApplyInput,
    approved: boolean,
    contextSessionId?: string,
    operationId?: string
  ): Promise<unknown>
  preparePreview(): Promise<void>
  previewEvents(): string
  previewUpdates(): readonly { at: number; action: string }[]
  closeDocument(): Promise<void>
  cleanup(): Promise<void>
}

function withAgentDir(root: string): () => void {
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  return () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  }
}

async function json(
  args: readonly string[],
  extraEnvironment: Readonly<Record<string, string>> = {}
): Promise<void> {
  const result = await runOfficeCli(binary!, [...args, '--json'], {
    env: officeCliEnv(process.env, extraEnvironment),
    timeoutMs: 30_000
  })
  assert.equal(result.exitCode, 0, result.stderr)
  assert.equal((JSON.parse(result.stdout) as { success?: unknown }).success, true)
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

function connectEventStream(url: string): Promise<{
  close: () => void
  ready: Promise<void>
  recent: () => string
  updateCount: () => number
  waitForUpdateAfter: (count: number) => Promise<void>
  updates: () => readonly { at: number; action: string }[]
}> {
  return new Promise((resolve, reject) => {
    let body = ''
    let fullCount = 0
    let updateCount = 0
    const updates: Array<{ at: number; action: string }> = []
    const updateWaiters = new Set<{ count: number; resolve: () => void }>()
    let markReady!: () => void
    const ready = new Promise<void>((resolveReady) => {
      markReady = resolveReady
    })
    const request = getHttp(url, (response) => {
      response.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        body = `${body}${text}`.slice(-64 * 1024)
        fullCount += (text.match(/"action":"full"/gu) ?? []).length
        updateCount += (text.match(/"action":/gu) ?? []).length
        for (const match of text.matchAll(/"action":"([^"]+)"/gu)) {
          updates.push({ at: performance.now(), action: match[1] })
        }
        if (fullCount >= 1 || text.includes('"action":"excel-patch"')) markReady()
        for (const waiter of [...updateWaiters]) {
          if (updateCount <= waiter.count) continue
          updateWaiters.delete(waiter)
          waiter.resolve()
        }
      })
      response.once('error', () => undefined)
      resolve({
        close: () => request.destroy(),
        ready,
        recent: () => body,
        updateCount: () => updateCount,
        updates: () => [...updates],
        waitForUpdateAfter: (count) =>
          updateCount > count
            ? Promise.resolve()
            : new Promise<void>((resolveUpdate) =>
                updateWaiters.add({ count, resolve: resolveUpdate })
              )
      })
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
        timer = setTimeout(() => reject(new Error('preview SSE did not become ready')), 15_000)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function createHostFixture(
  onWriteCli?: () => void,
  runOverride?: typeof runOfficeCli,
  prepareSource?: (sourcePath: string) => Promise<void>
): Promise<HostFixture> {
  const root = mkdtempSync(join(tmpdir(), 'office apply host '))
  const restoreAgentDir = withAgentDir(root)
  const sourcePath = join(root, 'source.xlsx')
  const service = createOfficeService(
    onWriteCli
      ? {
          runOfficeCli: async (...args) => {
            onWriteCli()
            return (runOverride ?? runOfficeCli)(...args)
          }
        }
      : runOverride
        ? { runOfficeCli: runOverride }
        : {}
  )
  let eventStream: Awaited<ReturnType<typeof connectEventStream>> | undefined
  let operationSequence = 0

  try {
    if (prepareSource) await prepareSource(sourcePath)
    else {
      await json(['create', sourcePath])
      await json(['close', sourcePath])
    }
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'ask'
    })
    const opened = await service.open({
      sessionId: session.sessionId,
      projectId: null,
      sourcePath,
      allowRoots: [root]
    })
    assert.equal(opened.state, 'ready')
    if (opened.state !== 'ready') throw new Error(opened.message)
    service.bindRunTarget({
      runId,
      artifactId: opened.document.artifactId,
      sessionId: session.sessionId,
      projectId: null
    })

    const resolveActiveRun = (runtimeSessionId: string): { runId: string } | undefined => {
      if (runtimeSessionId === originSessionId) return { runId }
      if (runtimeSessionId === otherOriginSessionId) return { runId: 'other-session-run' }
      return undefined
    }
    const read = createOfficeReadHostHandler({
      resolveActiveRun,
      readRange: (trustedRunId, params) => service.readRange(trustedRunId, params)
    })
    const describe = createOfficeDescribeHostHandler({
      resolveActiveRun,
      describeCellEdit: (trustedRunId, params) => service.describeCellEdit(trustedRunId, params),
      describeWriteRequest: (trustedRunId, request) =>
        service.describeWriteRequest(trustedRunId, request)
    })

    return {
      draftPath: opened.document.draftPath,
      read,
      describe,
      async apply(
        input,
        approved,
        contextSessionId = originSessionId,
        operationId = `tool-call-${++operationSequence}`
      ) {
        const apply = createOfficeApplyHostHandler({
          resolveActiveRun,
          authorizeApply: () => approved,
          authorizeWrite: () => approved,
          applyCellEdit: (trustedRunId, params, options) =>
            service.applyCellEdit(trustedRunId, params, options),
          applyWriteRequest: (trustedRunId, request, options) =>
            service.applyWriteRequest(trustedRunId, request, options)
        })
        return apply(input, { originSessionId: contextSessionId, toolCallId: operationId })
      },
      async preparePreview() {
        await (await fetch(opened.document.previewUrl)).text()
        eventStream = await connectEventStream(`${opened.document.previewUrl}events`)
        await json(
          [
            'set',
            opened.document.draftPath,
            '/Sheet1/J10',
            '--prop',
            'value=preview-ready',
            '--prop',
            'type=string'
          ],
          { OFFICECLI_RESIDENT_FLUSH: 'each' }
        )
        await waitForPreviewReady(eventStream.ready)
      },
      previewEvents: () => eventStream?.recent() ?? '',
      previewUpdates: () => eventStream?.updates() ?? [],
      closeDocument: () => service.close(opened.document.artifactId, session.sessionId),
      stopRun: () => service.clearRunTarget(runId),
      async cleanup() {
        eventStream?.close()
        await service.dispose()
        assert.equal(lsof(opened.document.draftPath), '')
        await runOfficeCli(binary!, ['close', sourcePath, '--json'], {
          timeoutMs: 15_000
        }).catch(() => undefined)
        assert.equal(lsof(sourcePath), '')
        restoreAgentDir()
        rmSync(root, { recursive: true, force: true })
      }
    }
  } catch (error) {
    await service.dispose().catch(() => undefined)
    restoreAgentDir()
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

const setCell = (value: string, baseRevision: number): ApplyInput => ({
  operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'A1', value },
  baseRevision
})

async function applyThroughHost(
  service: ReturnType<typeof createOfficeService>,
  trustedRunId: string,
  input: ApplyInput,
  operationId: string,
  approved = true
): Promise<unknown> {
  const handler = createOfficeApplyHostHandler({
    resolveActiveRun: () => ({ runId: trustedRunId }),
    authorizeApply: () => approved,
    applyCellEdit: (runId, params, options) => service.applyCellEdit(runId, params, options)
  })
  return handler(input, { originSessionId, toolCallId: operationId })
}

async function createClosedBlank(
  sessionId: string,
  name: string
): Promise<{ artifactId: string; draftPath: string }> {
  const service = createOfficeService()
  try {
    const created = await service.create({
      requestId: `create-${name}`,
      sessionId,
      projectId: null,
      name
    })
    assert.equal(created.state, 'ready')
    if (created.state !== 'ready') throw new Error(created.message)
    return {
      artifactId: created.document.artifactId,
      draftPath: created.document.draftPath
    }
  } finally {
    await service.dispose()
  }
}

test(
  'host workflow reads, describes, approves, applies, rereads, and persists one cell',
  options,
  async () => {
    const fixture = await createHostFixture()
    try {
      await fixture.preparePreview()
      const before = await fixture.read({ sheet: 'Sheet1', range: 'A1' }, { originSessionId })
      assert.equal(before.ok, true)
      if (!before.ok) throw new Error(before.error.message)
      assert.equal(before.value.revision, 0)

      const input = setCell('实验编号', before.value.revision)
      const description = await fixture.describe(input, {
        originSessionId,
        toolCallId: 'tool-call-1'
      })
      assert.deepEqual(description, {
        ok: true,
        value: {
          documentName: 'source.xlsx',
          sheet: 'Sheet1',
          cell: 'A1',
          before: null,
          after: '实验编号',
          revision: 0
        }
      })

      const applied = await fixture.apply(input, true)
      assert.deepEqual(applied, {
        ok: true,
        value: {
          applied: true,
          saved: true,
          revision: 1,
          sheet: 'Sheet1',
          cell: 'A1',
          before: null,
          after: '实验编号',
          previewConfirmed: true
        }
      })

      const reread = await fixture.read({ sheet: 'Sheet1', range: 'A1' }, { originSessionId })
      assert.equal(reread.ok, true)
      if (!reread.ok) throw new Error(reread.error.message)
      assert.equal(reread.value.revision, before.value.revision + 1)
      assert.ok('cells' in reread.value)
      assert.equal(reread.value.cells[0]?.value, '实验编号')
      assert.match(worksheetXml(fixture.draftPath), /实验编号/u)
    } finally {
      await fixture.cleanup()
    }
  }
)

test(
  'host apply deduplicates a repeated operation before approval or OfficeCLI',
  options,
  async () => {
    let writeCliCalls = 0
    const fixture = await createHostFixture(() => {
      writeCliCalls += 1
    })
    try {
      await fixture.preparePreview()
      const input = setCell('幂等值', 0)
      const first = await fixture.apply(input, true, originSessionId, 'deduplicated-call')
      const afterFirstDigest = digest(fixture.draftPath)
      const callsAfterFirst = writeCliCalls
      const replay = await fixture.apply(input, false, originSessionId, 'deduplicated-call')

      assert.equal((first as { ok?: unknown }).ok, true)
      assert.deepEqual(replay, {
        ...(first as Record<string, unknown>),
        value: { ...(first as { value: Record<string, unknown> }).value, deduplicated: true }
      })
      assert.equal(writeCliCalls, callsAfterFirst)
      assert.equal(digest(fixture.draftPath), afterFirstDigest)

      const conflict = await fixture.apply(
        setCell('不同值', 0),
        true,
        originSessionId,
        'deduplicated-call'
      )
      assert.deepEqual(conflict, {
        ok: false,
        error: {
          code: 'operation_conflict',
          message: '操作编号已用于不同的写入请求，未做任何修改'
        }
      })
      assert.equal(writeCliCalls, callsAfterFirst)
      assert.equal(digest(fixture.draftPath), afterFirstDigest)
    } finally {
      await fixture.cleanup()
    }
  }
)

test('host apply rejects a stale revision without changing the saved cell', options, async () => {
  const fixture = await createHostFixture()
  try {
    await fixture.preparePreview()
    const first = await fixture.apply(setCell('当前值', 0), true)
    assert.equal((first as { ok: boolean }).ok, true)
    const beforeDigest = digest(fixture.draftPath)

    const stale = await fixture.apply(setCell('过期写入', 0), true)
    assert.deepEqual(stale, {
      ok: false,
      error: { code: 'revision_conflict', message: '文档已更新，请先重新读取后再修改' }
    })
    assert.equal(digest(fixture.draftPath), beforeDigest)

    const reread = await fixture.read({ sheet: 'Sheet1', range: 'A1' }, { originSessionId })
    assert.equal(reread.ok, true)
    if (!reread.ok) throw new Error(reread.error.message)
    assert.ok('cells' in reread.value)
    assert.equal(reread.value.cells[0]?.value, '当前值')
    assert.equal(reread.value.revision, 1)
  } finally {
    await fixture.cleanup()
  }
})

test('host apply leaves the workbook unchanged when ask approval is denied', options, async () => {
  const fixture = await createHostFixture()
  try {
    const input = setCell('未批准写入', 0)
    const description = await fixture.describe(input, {
      originSessionId,
      toolCallId: 'tool-call-1'
    })
    assert.equal(description.ok, true)
    const beforeDigest = digest(fixture.draftPath)

    const denied = await fixture.apply(input, false)
    assert.deepEqual(denied, {
      ok: false,
      error: {
        code: 'approval_changed',
        message: '写入参数未获本次批准，未做任何修改'
      }
    })
    assert.equal(digest(fixture.draftPath), beforeDigest)
    const reread = await fixture.read({ sheet: 'Sheet1', range: 'A1' }, { originSessionId })
    assert.equal(reread.ok, true)
    if (!reread.ok) throw new Error(reread.error.message)
    assert.equal(reread.value.revision, 0)
    assert.ok('cells' in reread.value)
    assert.equal(reread.value.cells[0]?.value, null)
  } finally {
    await fixture.cleanup()
  }
})

test('host apply does not use a document bound to another runtime session', options, async () => {
  const fixture = await createHostFixture()
  try {
    const result = await fixture.apply(setCell('跨会话写入', 0), true, otherOriginSessionId)
    assert.deepEqual(result, {
      ok: false,
      error: {
        code: 'no_target',
        message: '当前运行没有关联的 Office 文档，请先在右侧打开表格并在输入框里关联它'
      }
    })
  } finally {
    await fixture.cleanup()
  }
})

test('host apply reports target_missing after the bound run is stopped', options, async () => {
  const fixture = await createHostFixture()
  try {
    assert.equal(fixture.stopRun(), true)
    const result = await fixture.apply(setCell('关闭后写入', 0), true)
    assert.deepEqual(result, {
      ok: false,
      error: { code: 'target_missing', message: '关联的 Office 文档已不可用' }
    })
  } finally {
    await fixture.cleanup()
  }
})

test(
  'registered blank draft restores operation receipts and revision in a new service',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office operation restart '))
    const restoreAgentDir = withAgentDir(root)
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'ask'
    })
    const firstService = createOfficeService()
    let secondService: ReturnType<typeof createOfficeService> | undefined
    let draftPath = ''
    try {
      const created = await firstService.create({
        requestId: 'restart-create',
        sessionId: session.sessionId,
        projectId: null,
        name: '重启恢复.xlsx'
      })
      assert.equal(created.state, 'ready')
      if (created.state !== 'ready') throw new Error(created.message)
      draftPath = created.document.draftPath
      firstService.bindRunTarget({
        runId: 'before-restart',
        artifactId: created.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })
      const input = setCell('重启后不重放', 0)
      const first = await applyThroughHost(
        firstService,
        'before-restart',
        input,
        'restart-operation'
      )
      assert.equal((first as { ok?: unknown }).ok, true)
      await firstService.dispose()

      secondService = createOfficeService()
      const reopened = await secondService.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath: draftPath,
        allowRoots: [root]
      })
      assert.equal(reopened.state, 'ready')
      if (reopened.state !== 'ready') throw new Error(reopened.message)
      assert.equal(reopened.document.artifactId, created.document.artifactId)
      secondService.bindRunTarget({
        runId: 'after-restart',
        artifactId: reopened.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })

      const replay = await applyThroughHost(
        secondService,
        'after-restart',
        input,
        'restart-operation',
        false
      )
      assert.deepEqual(replay, {
        ...(first as Record<string, unknown>),
        value: { ...(first as { value: Record<string, unknown> }).value, deduplicated: true }
      })
      const reread = await secondService.readRange('after-restart', {
        sheet: 'Sheet1',
        range: 'A1'
      })
      assert.equal(reread.revision, 1)
      assert.ok('cells' in reread)
      assert.equal(reread.cells[0]?.value, '重启后不重放')
      const stale = await applyThroughHost(
        secondService,
        'after-restart',
        setCell('旧版本', 0),
        'restart-stale'
      )
      assert.deepEqual(stale, {
        ok: false,
        error: { code: 'revision_conflict', message: '文档已更新，请先重新读取后再修改' }
      })
      const next = await applyThroughHost(
        secondService,
        'after-restart',
        setCell('最新版本', 1),
        'restart-next'
      )
      assert.equal((next as { value?: { revision?: unknown } }).value?.revision, 2)
    } finally {
      await secondService?.dispose().catch(() => undefined)
      await firstService.dispose().catch(() => undefined)
      if (draftPath) assert.equal(lsof(draftPath), '')
      restoreAgentDir()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test('recovered in-flight receipt is not replayed through the host', options, async () => {
  const root = mkdtempSync(join(tmpdir(), 'office operation inflight '))
  const restoreAgentDir = withAgentDir(root)
  const session = createPhiSession({
    kind: 'ordinary',
    cwd: root,
    cwdRealPath: root,
    permissionMode: 'ask'
  })
  let service: ReturnType<typeof createOfficeService> | undefined
  let draftPath = ''
  try {
    const artifact = await createClosedBlank(session.sessionId, '遗留事务.xlsx')
    draftPath = artifact.draftPath
    const params = { sheet: 'Sheet1', cell: 'A1', value: '不得重放', baseRevision: 0 }
    await persistOfficeOperationLog(draftPath, {
      version: 1,
      contentRevision: 0,
      operations: {
        'recovered-in-flight': {
          digest: officeOperationDigest(params),
          status: 'in_flight',
          createdAt: '2026-10-05T00:00:00.000Z'
        }
      }
    })
    let writeCliCalls = 0
    service = createOfficeService({
      runOfficeCli: async (...args) => {
        writeCliCalls += 1
        return runOfficeCli(...args)
      }
    })
    const reopened = await service.open({
      sessionId: session.sessionId,
      projectId: null,
      sourcePath: draftPath,
      allowRoots: [root]
    })
    assert.equal(reopened.state, 'ready')
    if (reopened.state !== 'ready') throw new Error(reopened.message)
    service.bindRunTarget({
      runId: 'recovered-in-flight-run',
      artifactId: artifact.artifactId,
      sessionId: session.sessionId,
      projectId: null
    })

    const result = await applyThroughHost(
      service,
      'recovered-in-flight-run',
      {
        operation: {
          type: 'set_cell',
          sheet: params.sheet,
          cell: params.cell,
          value: params.value
        },
        baseRevision: params.baseRevision
      },
      'recovered-in-flight'
    )
    assert.deepEqual(result, {
      ok: false,
      error: { code: 'write_unknown', message: '写入结果无法确认，文档已冻结等待核对' }
    })
    assert.equal(writeCliCalls, 0)
    const read = await service.readRange('recovered-in-flight-run', {
      sheet: 'Sheet1',
      range: 'A1'
    })
    assert.equal(read.revision, 0)
    assert.ok('cells' in read)
    assert.equal(read.cells[0]?.value, null)
  } finally {
    await service?.dispose().catch(() => undefined)
    if (draftPath) assert.equal(lsof(draftPath), '')
    restoreAgentDir()
    rmSync(root, { recursive: true, force: true })
  }
})

test('corrupt operation log is backed up and blocks host writes', options, async () => {
  const root = mkdtempSync(join(tmpdir(), 'office operation corrupt '))
  const restoreAgentDir = withAgentDir(root)
  const session = createPhiSession({
    kind: 'ordinary',
    cwd: root,
    cwdRealPath: root,
    permissionMode: 'ask'
  })
  let service: ReturnType<typeof createOfficeService> | undefined
  let draftPath = ''
  try {
    const artifact = await createClosedBlank(session.sessionId, '损坏日志.xlsx')
    draftPath = artifact.draftPath
    const operationPath = join(dirname(draftPath), 'operations.json')
    writeFileSync(operationPath, '{not-json')
    let writeCliCalls = 0
    service = createOfficeService({
      runOfficeCli: async (...args) => {
        writeCliCalls += 1
        return runOfficeCli(...args)
      }
    })
    const reopened = await service.open({
      sessionId: session.sessionId,
      projectId: null,
      sourcePath: draftPath,
      allowRoots: [root]
    })
    assert.equal(reopened.state, 'ready')
    if (reopened.state !== 'ready') throw new Error(reopened.message)
    service.bindRunTarget({
      runId: 'corrupt-operation-run',
      artifactId: artifact.artifactId,
      sessionId: session.sessionId,
      projectId: null
    })

    const result = await applyThroughHost(
      service,
      'corrupt-operation-run',
      setCell('不得写入', 0),
      'corrupt-operation'
    )
    assert.deepEqual(result, {
      ok: false,
      error: { code: 'operation_log_corrupt', message: '写入记录无法验证，文档已冻结等待核对' }
    })
    assert.equal(writeCliCalls, 0)
    assert.equal(readFileSync(operationPath, 'utf8'), '{not-json')
    assert.equal(
      readdirSync(dirname(draftPath)).some((name) => name.startsWith('operations.json.corrupt-')),
      true
    )
  } finally {
    await service?.dispose().catch(() => undefined)
    if (draftPath) assert.equal(lsof(draftPath), '')
    restoreAgentDir()
    rmSync(root, { recursive: true, force: true })
  }
})

test('two real drafts accept the same operation id independently', options, async () => {
  const root = mkdtempSync(join(tmpdir(), 'office operation scope '))
  const restoreAgentDir = withAgentDir(root)
  const session = createPhiSession({
    kind: 'ordinary',
    cwd: root,
    cwdRealPath: root,
    permissionMode: 'auto'
  })
  const service = createOfficeService()
  const draftPaths: string[] = []
  try {
    const first = await service.create({
      requestId: 'scope-first',
      sessionId: session.sessionId,
      projectId: null,
      name: '第一份.xlsx'
    })
    const second = await service.create({
      requestId: 'scope-second',
      sessionId: session.sessionId,
      projectId: null,
      name: '第二份.xlsx'
    })
    assert.equal(first.state, 'ready')
    assert.equal(second.state, 'ready')
    if (first.state !== 'ready' || second.state !== 'ready') throw new Error('create failed')
    draftPaths.push(first.document.draftPath, second.document.draftPath)
    service.bindRunTarget({
      runId: 'scope-first-run',
      artifactId: first.document.artifactId,
      sessionId: session.sessionId,
      projectId: null
    })
    service.bindRunTarget({
      runId: 'scope-second-run',
      artifactId: second.document.artifactId,
      sessionId: session.sessionId,
      projectId: null
    })

    const firstResult = await applyThroughHost(
      service,
      'scope-first-run',
      setCell('第一份', 0),
      'same-id-different-artifact'
    )
    const secondResult = await applyThroughHost(
      service,
      'scope-second-run',
      setCell('第二份', 0),
      'same-id-different-artifact'
    )
    assert.equal((firstResult as { ok?: unknown }).ok, true)
    assert.equal((secondResult as { ok?: unknown }).ok, true)
    assert.equal(
      (firstResult as { value?: { deduplicated?: unknown } }).value?.deduplicated,
      undefined
    )
    assert.equal(
      (secondResult as { value?: { deduplicated?: unknown } }).value?.deduplicated,
      undefined
    )
  } finally {
    await service.dispose().catch(() => undefined)
    for (const draftPath of draftPaths) assert.equal(lsof(draftPath), '')
    restoreAgentDir()
    rmSync(root, { recursive: true, force: true })
  }
})
