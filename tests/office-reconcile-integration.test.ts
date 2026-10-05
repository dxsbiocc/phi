import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { officePlatformId } from '../scripts/office/fetch-officecli.mjs'
import { officeCliEnv, runOfficeCli } from '../src/main/agent/office/office-driver'
import { officeBinaryCandidates } from '../src/main/agent/office/office-runtime'
import { createOfficeService } from '../src/main/agent/office/office-service'
import {
  loadOfficeOperationLog,
  officeOperationDigest,
  persistOfficeOperationLog,
  recordOfficeOperationPrewrite,
  startOfficeOperation
} from '../src/main/agent/office/office-operation-log'
import { createPhiSession } from '../src/main/agent/session/session-store'
import { createOfficeApplyHostHandler } from '../src/main/agent/office/office-tool-host'

const platformId = officePlatformId()
const bundledOfficeDir = join(process.cwd(), 'resources', 'office')
const binary = platformId ? officeBinaryCandidates(platformId, { bundledOfficeDir })[0] : undefined
const enabled = process.env.PHI_OFFICE_INTEGRATION === '1' && !!binary && existsSync(binary)
const options = {
  skip: enabled ? false : 'set PHI_OFFICE_INTEGRATION=1 and run bun run office:fetch'
}

type LostReplyMode = 'applied' | 'not_applied' | 'indeterminate'

function withAgentDir(root: string): () => void {
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  return () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  }
}

async function createWorkbook(path: string): Promise<void> {
  const created = await runOfficeCli(binary!, ['create', path, '--json'], {
    env: officeCliEnv(),
    timeoutMs: 30_000
  })
  assert.equal(created.exitCode, 0, created.stderr)
  const closed = await runOfficeCli(binary!, ['close', path, '--json'], { timeoutMs: 15_000 })
  assert.equal(closed.exitCode, 0, closed.stderr)
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
    return { artifactId: created.document.artifactId, draftPath: created.document.draftPath }
  } finally {
    await service.dispose()
  }
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

test(
  'real OfficeCLI lost replies reconcile without replaying the write command',
  options,
  async (t) => {
    for (const mode of ['applied', 'not_applied', 'indeterminate'] as const) {
      await t.test(mode, () => runLostReplyScenario(mode))
    }
  }
)

test(
  'a new service auto-reconciles persisted prewrite evidence without a CLI write',
  options,
  async (t) => {
    for (const outcome of ['applied', 'not_applied'] as const) {
      await t.test(outcome, () => runRestartScenario(outcome))
    }
  }
)

async function runRestartScenario(outcome: 'applied' | 'not_applied'): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `office reconcile restart ${outcome} `))
  const restoreAgentDir = withAgentDir(root)
  const session = createPhiSession({
    kind: 'ordinary',
    cwd: root,
    cwdRealPath: root,
    permissionMode: 'auto'
  })
  const artifact = await createClosedBlank(session.sessionId, `${outcome}.xlsx`)
  const operation = { sheet: 'Sheet1', cell: 'A1', value: 'expected', baseRevision: 0 }
  let state = startOfficeOperation(
    { version: 2, contentRevision: 0, operations: {}, freezeState: 'unknown' },
    `restart-${outcome}`,
    officeOperationDigest(operation),
    '2026-10-05T00:00:00.000Z'
  )
  state = recordOfficeOperationPrewrite(state, `restart-${outcome}`, operation, null)
  await persistOfficeOperationLog(artifact.draftPath, state)
  if (outcome === 'applied') {
    const changed = await runOfficeCli(
      binary!,
      [
        'set',
        artifact.draftPath,
        '/Sheet1/A1',
        '--prop',
        'value=expected',
        '--prop',
        'type=string',
        '--json'
      ],
      { env: officeCliEnv(), timeoutMs: 30_000 }
    )
    assert.equal(changed.exitCode, 0, changed.stderr)
    await runOfficeCli(binary!, ['close', artifact.draftPath, '--json'], { timeoutMs: 15_000 })
  }
  let writeCliCalls = 0
  const service = createOfficeService({
    runOfficeCli: async (binaryPath, args, runOptions) => {
      if (args[0] === 'batch') writeCliCalls += 1
      return runOfficeCli(binaryPath, args, runOptions)
    }
  })
  try {
    const reopened = await service.open({
      sessionId: session.sessionId,
      projectId: null,
      sourcePath: artifact.draftPath,
      allowRoots: [root]
    })
    assert.equal(reopened.state, 'ready')
    if (reopened.state !== 'ready') throw new Error(reopened.message)
    assert.equal(reopened.document.artifactId, artifact.artifactId)
    assert.equal(reopened.freezeState, undefined)
    service.bindRunTarget({
      runId: `restart-run-${outcome}`,
      artifactId: artifact.artifactId,
      sessionId: session.sessionId,
      projectId: null
    })
    const read = await service.readRange(`restart-run-${outcome}`, {
      sheet: 'Sheet1',
      range: 'A1'
    })
    assert.ok('cells' in read)
    assert.equal(read.revision, outcome === 'applied' ? 1 : 0)
    assert.equal(read.cells[0]?.value, outcome === 'applied' ? 'expected' : null)
    const persisted = await loadOfficeOperationLog(artifact.draftPath)
    const receipt = persisted.operations[`restart-${outcome}`]?.receipt
    assert.equal(receipt?.ok, outcome === 'applied')
    if (receipt?.ok === false) assert.equal(receipt.error.code, 'write_not_applied')
    assert.equal(writeCliCalls, 0)
  } finally {
    await service.dispose().catch(() => undefined)
    assert.equal(lsof(artifact.draftPath), '')
    restoreAgentDir()
    rmSync(root, { recursive: true, force: true })
  }
}

async function runLostReplyScenario(mode: LostReplyMode): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `office reconcile ${mode} `))
  const restoreAgentDir = withAgentDir(root)
  const sourcePath = join(root, 'source.xlsx')
  let intercepted = false
  let writeCliCalls = 0
  const injectedRun: typeof runOfficeCli = async (binaryPath, args, runOptions) => {
    if (args[0] !== 'batch') return runOfficeCli(binaryPath, args, runOptions)
    writeCliCalls += 1
    if (intercepted) return runOfficeCli(binaryPath, args, runOptions)
    intercepted = true
    if (mode === 'not_applied') throw new Error('simulated timeout before execution')
    const result = await runOfficeCli(binaryPath, args, runOptions)
    assert.equal(result.exitCode, 0, result.stderr)
    if (mode === 'indeterminate') {
      const external = await runOfficeCli(
        binaryPath,
        [
          'set',
          args[1]!,
          '/Sheet1/A1',
          '--prop',
          'value=third-value',
          '--prop',
          'type=string',
          '--json'
        ],
        { env: officeCliEnv(), timeoutMs: 30_000 }
      )
      assert.equal(external.exitCode, 0, external.stderr)
    }
    throw new Error('simulated lost reply after execution')
  }
  const service = createOfficeService({ runOfficeCli: injectedRun })
  let draftPath = ''
  try {
    await createWorkbook(sourcePath)
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
      runId: `run-${mode}`,
      artifactId: opened.document.artifactId,
      sessionId: session.sessionId,
      projectId: null
    })
    const params = { sheet: 'Sheet1', cell: 'A1', value: 'expected', baseRevision: 0 }
    const apply = applyThroughHost(service, `run-${mode}`, params, `lost-${mode}`)

    if (mode === 'applied') {
      const outcome = await apply
      assert.equal(outcome.ok, true)
      if (!outcome.ok) throw new Error(outcome.error.message)
      const result = outcome.value
      assert.equal(result.reconciled, true)
      assert.equal(result.revision, 1)
      assert.match(worksheetXml(draftPath), /expected/u)
      const next = await applyThroughHost(
        service,
        `run-${mode}`,
        { sheet: 'Sheet1', cell: 'B1', value: 'next', baseRevision: 1 },
        'after-applied'
      )
      assert.equal(next.ok && next.value.revision, 2)
    } else if (mode === 'not_applied') {
      const outcome = await apply
      assert.equal(outcome.ok, false)
      if (outcome.ok) throw new Error('expected write_not_applied')
      assert.equal(outcome.error.code, 'write_not_applied')
      assert.doesNotMatch(worksheetXml(draftPath), /expected/u)
      const retry = await applyThroughHost(service, `run-${mode}`, params, 'retry-not-applied')
      assert.equal(retry.ok && retry.value.revision, 1)
    } else {
      const outcome = await apply
      assert.equal(outcome.ok, false)
      if (outcome.ok) throw new Error('expected write_unknown')
      assert.equal(outcome.error.code, 'write_unknown')
      const read = await service.readRange(`run-${mode}`, { sheet: 'Sheet1', range: 'A1' })
      assert.ok('cells' in read)
      assert.equal(read.cells[0]?.value, 'third-value')
      assert.match(worksheetXml(draftPath), /third-value/u)
      const callsBeforeBlockedWrite = writeCliCalls
      const blocked = await applyThroughHost(
        service,
        `run-${mode}`,
        { ...params, value: 'blocked' },
        'blocked-indeterminate'
      )
      assert.equal(blocked.ok, false)
      if (blocked.ok) throw new Error('expected document_frozen')
      assert.equal(blocked.error.code, 'document_frozen')
      assert.equal(writeCliCalls, callsBeforeBlockedWrite)
      const manual = await service.reconcile(opened.document.artifactId, session.sessionId)
      assert.equal(manual.conclusion, 'indeterminate')
      assert.equal(manual.freezeState, 'unknown')
    }
    assert.equal(writeCliCalls, mode === 'indeterminate' ? 1 : 2)
    assert.equal(readFileSync(sourcePath).length > 0, true)
  } finally {
    await service.dispose().catch(() => undefined)
    if (draftPath) assert.equal(lsof(draftPath), '')
    await runOfficeCli(binary!, ['close', sourcePath, '--json'], { timeoutMs: 15_000 }).catch(
      () => undefined
    )
    assert.equal(lsof(sourcePath), '')
    restoreAgentDir()
    rmSync(root, { recursive: true, force: true })
  }
}

function applyThroughHost(
  service: ReturnType<typeof createOfficeService>,
  runId: string,
  params: { sheet: string; cell: string; value: string; baseRevision: number },
  operationId: string
): ReturnType<ReturnType<typeof createOfficeApplyHostHandler>> {
  const handler = createOfficeApplyHostHandler({
    resolveActiveRun: () => ({ runId }),
    authorizeApply: () => true,
    applyCellEdit: (trustedRunId, input, applyOptions) =>
      service.applyCellEdit(trustedRunId, input, applyOptions)
  })
  return handler(
    {
      operation: {
        type: 'set_cell',
        sheet: params.sheet,
        cell: params.cell,
        value: params.value
      },
      baseRevision: params.baseRevision
    },
    { originSessionId: 'runtime-main', toolCallId: operationId }
  )
}
