import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { officePlatformId } from '../scripts/office/fetch-officecli.mjs'
import { runOfficeCli } from '../src/main/agent/office/office-driver'
import { officeBinaryCandidates } from '../src/main/agent/office/office-runtime'
import { createOfficeService } from '../src/main/agent/office/office-service'
import { validateOfficeWriteRequest } from '../src/main/agent/office/office-write'
import { createPhiSession } from '../src/main/agent/session/session-store'
import {
  OFFICE_RANGE_ORIGIN_SESSION_ID,
  createOfficeRangeHostFixture,
  officeBinary,
  officeRangeIntegrationOptions,
  runJson,
  type RangeApplyInput
} from './helpers/officeRangeIntegrationHarness'

test(
  'real host add_sheet creates once, confirms preview, and supports immediate reads and writes',
  officeRangeIntegrationOptions,
  async () => {
    const fixture = await createOfficeRangeHostFixture()
    try {
      await fixture.preparePreview()
      const before = (await fixture.read(
        {},
        {
          originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID
        }
      )) as { ok: true; value: { revision: number; sheets: Array<{ name: string }> } }
      assert.deepEqual(
        before.value.sheets.map((sheet) => sheet.name),
        ['Sheet1']
      )

      const add: RangeApplyInput = {
        operation: { type: 'add_sheet', name: '汇总表' },
        baseRevision: before.value.revision
      }
      const created = (await fixture.apply(add, 'add-sheet-once')) as {
        ok: true
        value: {
          revision: number
          sheet: string
          path: string
          sheetNames: string[]
          previewConfirmed: boolean
          deduplicated?: boolean
        }
      }
      assert.equal(created.ok, true, JSON.stringify(created))
      assert.deepEqual(created.value, {
        applied: true,
        saved: true,
        revision: 1,
        sheet: '汇总表',
        path: '/汇总表',
        sheetCount: 2,
        sheetNames: ['Sheet1', '汇总表'],
        previewConfirmed: true
      })
      assert.equal(fixture.previewUpdates().at(-1)?.action, 'full')

      const replay = (await fixture.apply(add, 'add-sheet-once')) as typeof created
      assert.equal(replay.ok, true)
      assert.equal(replay.value.deduplicated, true)
      assert.deepEqual(replay.value.sheetNames, ['Sheet1', '汇总表'])

      const spaced = (await fixture.apply(
        { operation: { type: 'add_sheet', name: 'Case 中文' }, baseRevision: 1 },
        'add-sheet-spaced'
      )) as { ok: true; value: { revision: number; sheetNames: string[] } }
      assert.equal(spaced.ok, true)
      assert.equal(spaced.value.revision, 2)
      assert.deepEqual(spaced.value.sheetNames, ['Sheet1', '汇总表', 'Case 中文'])

      const duplicate = (await fixture.apply(
        { operation: { type: 'add_sheet', name: 'CASE 中文' }, baseRevision: 2 },
        'add-sheet-duplicate'
      )) as { ok: false; error: { code: string; sheetNames: string[] } }
      assert.equal(duplicate.ok, false)
      assert.equal(duplicate.error.code, 'sheet_exists')
      assert.deepEqual(duplicate.error.sheetNames, ['Sheet1', '汇总表', 'Case 中文'])

      const cell = (await fixture.apply(
        {
          operation: { type: 'set_cell', sheet: created.value.sheet, cell: 'A1', value: '标题' },
          baseRevision: 2
        },
        'new-sheet-cell'
      )) as { ok: true; value: { revision: number } }
      const range = (await fixture.apply(
        {
          operation: {
            type: 'set_range',
            sheet: created.value.sheet,
            range: 'A2:B2',
            values: [[2, 3]]
          },
          baseRevision: cell.value.revision
        },
        'new-sheet-range'
      )) as { ok: true; value: { revision: number } }
      const formula = (await fixture.apply(
        {
          operation: {
            type: 'set_formula',
            sheet: created.value.sheet,
            cell: 'C2',
            formula: '=SUM(A2:B2)'
          },
          baseRevision: range.value.revision
        },
        'new-sheet-formula'
      )) as { ok: true; value: { revision: number } }
      const format = (await fixture.apply(
        {
          operation: {
            type: 'format_range',
            sheet: created.value.sheet,
            range: 'A1:C2',
            format: { bold: true }
          },
          baseRevision: formula.value.revision
        },
        'new-sheet-format'
      )) as { ok: true; value: { revision: number } }
      const read = (await fixture.read(
        { sheet: created.value.sheet, range: 'A1:C2' },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as {
        ok: true
        value: {
          revision: number
          cells: Array<{ value: unknown; formula?: string; format?: unknown }>
        }
      }
      assert.equal(read.value.revision, 6)
      assert.deepEqual(
        read.value.cells.map((cell) => cell.value),
        ['标题', null, null, 2, 3, 5]
      )
      assert.equal(read.value.cells[5]?.formula, '=SUM(A2:B2)')
      assert.ok(read.value.cells.every((entry) => entry.format && 'bold' in entry.format))

      const invalidRead = (await fixture.read(
        { sheet: '从未存在', range: 'A1' },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as { ok: false; error: { code: string } }
      assert.equal(invalidRead.ok, false)
      assert.equal(invalidRead.error.code, 'invalid_sheet')
      const invalidWrite = (await fixture.apply(
        {
          operation: { type: 'set_cell', sheet: '从未存在', cell: 'A1', value: 'x' },
          baseRevision: format.value.revision
        },
        'invalid-old-sheet-path'
      )) as { ok: false; error: { code: string } }
      assert.equal(invalidWrite.ok, false)
      assert.equal(invalidWrite.error.code, 'invalid_sheet')

      const stale = (await fixture.apply(
        { operation: { type: 'add_sheet', name: '不应创建' }, baseRevision: 1 },
        'add-sheet-stale'
      )) as { ok: false; error: { code: string } }
      assert.equal(stale.ok, false)
      assert.equal(stale.error.code, 'revision_conflict')
      const overview = (await fixture.read(
        {},
        {
          originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID
        }
      )) as { ok: true; value: { revision: number; sheets: Array<{ name: string }> } }
      assert.equal(overview.value.revision, format.value.revision)
      assert.deepEqual(
        overview.value.sheets.map((sheet) => sheet.name),
        ['Sheet1', '汇总表', 'Case 中文']
      )

      const validation = await runOfficeCli(officeBinary!, [
        'validate',
        fixture.draftPath,
        '--json'
      ])
      assert.equal(validation.exitCode, 0, validation.stderr || validation.stdout)
    } finally {
      await fixture.cleanup()
    }
  }
)

test(
  'real lost add_sheet replies reconcile applied and not_applied without replay',
  officeRangeIntegrationOptions,
  async (t) => {
    for (const mode of ['applied', 'not_applied'] as const) {
      await t.test(mode, async () => {
        let intercepted = false
        let batchCalls = 0
        const fixture = await createOfficeRangeHostFixture({
          runOfficeCli: async (binaryPath, args, options) => {
            if (args[0] !== 'batch' || intercepted) return runOfficeCli(binaryPath, args, options)
            intercepted = true
            batchCalls += 1
            if (mode === 'not_applied') {
              return {
                exitCode: null,
                stdout: '',
                stderr: '',
                timedOut: true,
                truncated: false
              }
            }
            const applied = await runOfficeCli(binaryPath, args, options)
            return { ...applied, stdout: '{lost-reply' }
          }
        })
        try {
          const result = (await fixture.apply(
            { operation: { type: 'add_sheet', name: '汇总表' }, baseRevision: 0 },
            `lost-sheet-${mode}`
          )) as {
            ok: boolean
            value?: { reconciled?: boolean; revision?: number }
            error?: { code?: string }
          }
          if (mode === 'applied') {
            assert.equal(result.ok, true)
            assert.equal(result.value?.reconciled, true)
            assert.equal(result.value?.revision, 1)
          } else {
            assert.equal(result.ok, false)
            assert.equal(result.error?.code, 'write_not_applied')
          }
          assert.equal(batchCalls, 1)
        } finally {
          await fixture.cleanup()
        }
      })
    }
  }
)

test(
  'real add_sheet keeps two sessions isolated with the same operation id',
  officeRangeIntegrationOptions,
  async () => {
    const first = await createOfficeRangeHostFixture()
    const second = await createOfficeRangeHostFixture()
    try {
      const firstResult = (await first.apply(
        { operation: { type: 'add_sheet', name: '会话一' }, baseRevision: 0 },
        'same-sheet-operation-id'
      )) as { ok: boolean }
      const secondResult = (await second.apply(
        { operation: { type: 'add_sheet', name: '会话二' }, baseRevision: 0 },
        'same-sheet-operation-id'
      )) as { ok: boolean }
      assert.equal(firstResult.ok, true)
      assert.equal(secondResult.ok, true)
      const firstOverview = (await first.read(
        {},
        {
          originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID
        }
      )) as { ok: true; value: { sheets: Array<{ name: string }> } }
      const secondOverview = (await second.read(
        {},
        {
          originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID
        }
      )) as { ok: true; value: { sheets: Array<{ name: string }> } }
      assert.deepEqual(
        firstOverview.value.sheets.map((sheet) => sheet.name),
        ['Sheet1', '会话一']
      )
      assert.deepEqual(
        secondOverview.value.sheets.map((sheet) => sheet.name),
        ['Sheet1', '会话二']
      )
    } finally {
      await second.cleanup()
      await first.cleanup()
    }
  }
)

test(
  'real add_sheet enforces the twenty-sheet limit before dispatch',
  officeRangeIntegrationOptions,
  async () => {
    const fixture = await createOfficeRangeHostFixture({
      prepareSource: async (sourcePath) => {
        await runJson(['create', sourcePath])
        const commands = Array.from({ length: 19 }, (_, index) => ({
          command: 'add',
          parent: '/',
          type: 'sheet',
          props: { name: `S${index + 2}` }
        }))
        const batch = await runOfficeCli(officeBinary!, ['batch', sourcePath, '--json'], {
          stdin: JSON.stringify(commands)
        })
        assert.equal(batch.exitCode, 0, batch.stderr || batch.stdout)
        await runJson(['close', sourcePath])
      }
    })
    try {
      const result = (await fixture.apply(
        { operation: { type: 'add_sheet', name: '第21张' }, baseRevision: 0 },
        'too-many-sheets'
      )) as { ok: false; error: { code: string; sheetNames: string[] } }
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'too_many_sheets')
      assert.equal(result.error.sheetNames.length, 20)
    } finally {
      await fixture.cleanup()
    }
  }
)

const platformId = officePlatformId()
const persistenceBinary = platformId
  ? officeBinaryCandidates(platformId, {
      bundledOfficeDir: join(process.cwd(), 'resources', 'office')
    })[0]
  : undefined
const persistenceOptions = {
  skip:
    process.env.PHI_OFFICE_INTEGRATION === '1' && persistenceBinary && existsSync(persistenceBinary)
      ? false
      : 'set PHI_OFFICE_INTEGRATION=1 and run bun run office:fetch'
}

test(
  'saved sheet survives close, registered-draft rebind, overview, replay, and validation',
  persistenceOptions,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office sheet persistence '))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'ask'
    })
    const first = createOfficeService()
    let second: ReturnType<typeof createOfficeService> | undefined
    let draftPath = ''
    try {
      const created = await first.create({
        requestId: 'sheet-persistence-create',
        sessionId: session.sessionId,
        projectId: null,
        name: '工作表持久化.xlsx'
      })
      assert.equal(created.state, 'ready')
      if (created.state !== 'ready') throw new Error(created.message)
      draftPath = created.document.draftPath
      first.bindRunTarget({
        runId: 'sheet-before-restart',
        artifactId: created.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })
      const request = validateOfficeWriteRequest({
        operation: { type: 'add_sheet', name: '汇总表' },
        baseRevision: 0
      })
      const applied = await first.applyWriteRequest('sheet-before-restart', request, {
        operationId: 'sheet-persistence-write'
      })
      assert.equal(applied.revision, 1)
      await first.dispose()
      assert.equal(officeOwners(draftPath), '')

      second = createOfficeService()
      const reopened = await second.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath: draftPath,
        allowRoots: [root]
      })
      assert.equal(reopened.state, 'ready')
      if (reopened.state !== 'ready') throw new Error(reopened.message)
      assert.equal(reopened.document.artifactId, created.document.artifactId)
      second.bindRunTarget({
        runId: 'sheet-after-restart',
        artifactId: reopened.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })
      const overview = await second.readRange('sheet-after-restart', {})
      assert.equal(overview.revision, 1)
      assert.ok('sheets' in overview)
      if (!('sheets' in overview)) throw new Error('missing sheets')
      assert.deepEqual(
        overview.sheets.map((sheet) => sheet.name),
        ['Sheet1', '汇总表']
      )
      const replay = await second.applyWriteRequest('sheet-after-restart', request, {
        operationId: 'sheet-persistence-write'
      })
      assert.equal(replay.deduplicated, true)
      await second.dispose()
      second = undefined

      const validation = await runOfficeCli(persistenceBinary!, ['validate', draftPath, '--json'], {
        timeoutMs: 30_000
      })
      assert.equal(validation.exitCode, 0, validation.stderr || validation.stdout)
    } finally {
      await second?.dispose().catch(() => undefined)
      await first.dispose().catch(() => undefined)
      if (draftPath) {
        await runOfficeCli(persistenceBinary!, ['close', draftPath, '--json'], {
          timeoutMs: 15_000
        }).catch(() => undefined)
      }
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  }
)

function officeOwners(path: string): string {
  try {
    return execFileSync('/usr/sbin/lsof', ['-t', '-a', '-c', 'officecli', '--', path], {
      encoding: 'utf8'
    })
  } catch {
    return ''
  }
}
