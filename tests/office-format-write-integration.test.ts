import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { officePlatformId } from '../scripts/office/fetch-officecli.mjs'
import { officeCliEnv, runOfficeCli } from '../src/main/agent/office/office-driver'
import { officeBinaryCandidates } from '../src/main/agent/office/office-runtime'
import { createOfficeService } from '../src/main/agent/office/office-service'
import { createPhiSession } from '../src/main/agent/session/session-store'
import { validateOfficeWriteRequest } from '../src/main/agent/office/office-write'
import {
  OFFICE_RANGE_ORIGIN_SESSION_ID,
  createOfficeRangeHostFixture,
  officeBinary,
  officeRangeIntegrationOptions,
  type RangeApplyInput
} from './helpers/officeRangeIntegrationHarness'

const requestedFormat = {
  bold: true,
  fill: '#FFEEAA',
  horizontalAlign: 'center' as const,
  numberFormat: '0.00' as const
}

async function initializeFixture(draftPath: string): Promise<void> {
  const commands = [
    { command: 'set', path: '/Sheet1/A1', props: { value: 'Title', type: 'string' } },
    { command: 'set', path: '/Sheet1/B1', props: { value: 'Group', type: 'string' } },
    { command: 'set', path: '/Sheet1/A2', props: { value: 12.345, type: 'number' } },
    { command: 'set', path: '/Sheet1/B2', props: { formula: 'SUM(A2,1)' } },
    {
      command: 'set',
      path: '/Sheet1/A1:B1',
      props: { bold: 'false', fill: '#ABCDEF', 'alignment.horizontal': 'left' }
    }
  ]
  const result = await runOfficeCli(officeBinary!, ['batch', draftPath, '--json'], {
    stdin: JSON.stringify(commands),
    env: officeCliEnv(process.env, { OFFICECLI_RESIDENT_FLUSH: 'each' }),
    timeoutMs: 30_000
  })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
}

test(
  'real host format_range persists title and number formatting without changing data or formulas',
  officeRangeIntegrationOptions,
  async () => {
    const fixture = await createOfficeRangeHostFixture()
    try {
      await initializeFixture(fixture.draftPath)
      await fixture.preparePreview()
      const before = (await fixture.read(
        { sheet: 'Sheet1', range: 'A1:B2' },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as {
        ok: true
        value: {
          revision: number
          cells: Array<{ value: unknown; formula?: string; valueType?: string }>
        }
      }
      const baseline = before.value.cells.map((cell) => ({
        value: cell.value,
        formula: cell.formula,
        valueType: cell.valueType
      }))
      const titleInput: RangeApplyInput = {
        operation: {
          type: 'format_range',
          sheet: 'Sheet1',
          range: 'A1:B1',
          format: { bold: true, fill: '#FFEEAA', horizontalAlign: 'center' }
        },
        baseRevision: before.value.revision
      }
      const title = (await fixture.apply(titleInput, 'format-title')) as {
        ok: true
        value: { revision: number; changedCells: number; previewConfirmed: boolean }
      }
      assert.equal(title.ok, true, JSON.stringify(title))
      assert.equal(title.value.changedCells, 2)
      assert.equal(title.value.previewConfirmed, true, JSON.stringify(title))
      const numbers = (await fixture.apply(
        {
          operation: {
            type: 'format_range',
            sheet: 'Sheet1',
            range: 'A2:B2',
            format: { numberFormat: '0.00' }
          },
          baseRevision: title.value.revision
        },
        'format-numbers'
      )) as { ok: true; value: { revision: number } }
      assert.equal(numbers.ok, true, JSON.stringify(numbers))

      const after = (await fixture.read(
        { sheet: 'Sheet1', range: 'A1:B2' },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as {
        ok: true
        value: {
          revision: number
          cells: Array<{
            value: unknown
            formula?: string
            valueType?: string
            format?: Record<string, unknown>
          }>
        }
      }
      assert.deepEqual(
        after.value.cells.map((cell) => ({
          value: cell.value,
          formula: cell.formula,
          valueType: cell.valueType
        })),
        baseline
      )
      for (const cell of after.value.cells.slice(0, 2)) {
        assert.deepEqual(cell.format, {
          bold: true,
          fill: '#FFEEAA',
          horizontalAlign: 'center'
        })
      }
      for (const cell of after.value.cells.slice(2)) {
        assert.equal(cell.format?.numberFormat, '0.00')
      }
      assert.equal(after.value.revision, before.value.revision + 2)
      const validation = await runOfficeCli(
        officeBinary!,
        ['validate', fixture.draftPath, '--json'],
        {
          timeoutMs: 30_000
        }
      )
      assert.equal(validation.exitCode, 0, validation.stderr || validation.stdout)
    } finally {
      await fixture.cleanup()
    }
  }
)

test(
  'real format_range batch rollback and lost replies fail closed without replay',
  officeRangeIntegrationOptions,
  async (t) => {
    await t.test('unsupported property receipt', async () => {
      const fixture = await createOfficeRangeHostFixture()
      try {
        const unsupported = await runOfficeCli(
          officeBinary!,
          ['set', fixture.draftPath, '/Sheet1/A1:B1', '--prop', 'color=red', '--json'],
          { timeoutMs: 30_000 }
        )
        assert.equal(unsupported.exitCode, 2)
        const receipt = JSON.parse(unsupported.stdout) as {
          success: boolean
          warnings: Array<{ code: string; message: string }>
        }
        assert.equal(receipt.success, false)
        assert.equal(receipt.warnings[0]?.code, 'unsupported_property')
        assert.match(receipt.warnings[0]?.message ?? '', /UNSUPPORTED props: color/u)
      } finally {
        await fixture.cleanup()
      }
    })

    await t.test('atomic rollback', async () => {
      let intercepted = false
      const fixture = await createOfficeRangeHostFixture({
        runOfficeCli: async (binaryPath, args, options) => {
          if (args[0] !== 'batch' || intercepted || !options?.stdin) {
            return runOfficeCli(binaryPath, args, options)
          }
          intercepted = true
          const commands = JSON.parse(options.stdin) as unknown[]
          commands.push({ command: 'set', path: '/MissingSheet/A1', props: { bold: 'true' } })
          return runOfficeCli(binaryPath, args, { ...options, stdin: JSON.stringify(commands) })
        }
      })
      try {
        const failed = (await fixture.apply(
          {
            operation: {
              type: 'format_range',
              sheet: 'Sheet1',
              range: 'A1:B1',
              format: { bold: true }
            },
            baseRevision: 0
          },
          'format-rollback'
        )) as { ok: false; error: { code: string } }
        assert.equal(failed.ok, false)
        assert.equal(failed.error.code, 'write_failed')
        const read = (await fixture.read(
          { sheet: 'Sheet1', range: 'A1:B1' },
          { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
        )) as { ok: true; value: { cells: Array<{ format?: { bold?: boolean } }> } }
        assert.ok(read.value.cells.every((cell) => cell.format?.bold !== true))
      } finally {
        await fixture.cleanup()
      }
    })

    for (const mode of ['applied', 'not_applied'] as const) {
      await t.test(`lost reply ${mode}`, async () => {
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
            {
              operation: {
                type: 'format_range',
                sheet: 'Sheet1',
                range: 'A1:B1',
                format: { bold: true }
              },
              baseRevision: 0
            },
            `format-lost-${mode}`
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
  'real format_range keeps two Office sessions isolated',
  officeRangeIntegrationOptions,
  async () => {
    const first = await createOfficeRangeHostFixture()
    const second = await createOfficeRangeHostFixture()
    try {
      const firstResult = (await first.apply(
        {
          operation: {
            type: 'format_range',
            sheet: 'Sheet1',
            range: 'A1:B1',
            format: { fill: '#FFEEAA' }
          },
          baseRevision: 0
        },
        'same-format-operation-id'
      )) as { ok: boolean }
      const secondResult = (await second.apply(
        {
          operation: {
            type: 'format_range',
            sheet: 'Sheet1',
            range: 'A1:B1',
            format: { fill: '#AABBCC' }
          },
          baseRevision: 0
        },
        'same-format-operation-id'
      )) as { ok: boolean }
      assert.equal(firstResult.ok, true)
      assert.equal(secondResult.ok, true)
      const firstRead = (await first.read(
        { sheet: 'Sheet1', range: 'A1:B1' },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as { ok: true; value: { cells: Array<{ format?: { fill?: string } }> } }
      const secondRead = (await second.read(
        { sheet: 'Sheet1', range: 'A1:B1' },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as { ok: true; value: { cells: Array<{ format?: { fill?: string } }> } }
      assert.ok(firstRead.value.cells.every((cell) => cell.format?.fill === '#FFEEAA'))
      assert.ok(secondRead.value.cells.every((cell) => cell.format?.fill === '#AABBCC'))
    } finally {
      await second.cleanup()
      await first.cleanup()
    }
  }
)

const platformId = officePlatformId()
const binary = platformId
  ? officeBinaryCandidates(platformId, {
      bundledOfficeDir: join(process.cwd(), 'resources', 'office')
    })[0]
  : undefined
const persistenceOptions = {
  skip:
    process.env.PHI_OFFICE_INTEGRATION === '1' && binary && existsSync(binary)
      ? false
      : 'set PHI_OFFICE_INTEGRATION=1 and run bun run office:fetch'
}

test(
  'saved format survives close, registered-draft rebind, and validation',
  persistenceOptions,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office format persistence '))
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
        requestId: 'format-persistence-create',
        sessionId: session.sessionId,
        projectId: null,
        name: '格式持久化.xlsx'
      })
      assert.equal(created.state, 'ready')
      if (created.state !== 'ready') throw new Error(created.message)
      draftPath = created.document.draftPath
      first.bindRunTarget({
        runId: 'format-before-restart',
        artifactId: created.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })
      const valueRequest = validateOfficeWriteRequest({
        operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'A1', formula: '=1+1' },
        baseRevision: 0
      })
      const value = await first.applyWriteRequest('format-before-restart', valueRequest, {
        operationId: 'format-persistence-formula'
      })
      const formatRequest = validateOfficeWriteRequest({
        operation: {
          type: 'format_range',
          sheet: 'Sheet1',
          range: 'A1:A1',
          format: requestedFormat
        },
        baseRevision: value.revision
      })
      const applied = await first.applyWriteRequest('format-before-restart', formatRequest, {
        operationId: 'format-persistence-write'
      })
      assert.equal(applied.revision, 2)
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
      second.bindRunTarget({
        runId: 'format-after-restart',
        artifactId: reopened.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })
      const read = await second.readRange('format-after-restart', {
        sheet: 'Sheet1',
        range: 'A1'
      })
      assert.ok('cells' in read)
      if (!('cells' in read)) throw new Error('missing cells')
      assert.equal(read.revision, 2)
      assert.equal(read.cells[0]?.value, 2)
      assert.equal(read.cells[0]?.formula, '=1+1')
      assert.deepEqual(read.cells[0]?.format, requestedFormat)
      const replay = await second.applyWriteRequest('format-after-restart', formatRequest, {
        operationId: 'format-persistence-write'
      })
      assert.equal(replay.deduplicated, true)
      await second.dispose()
      second = undefined

      const validation = await runOfficeCli(binary!, ['validate', draftPath, '--json'], {
        timeoutMs: 30_000
      })
      assert.equal(validation.exitCode, 0, validation.stderr || validation.stdout)
    } finally {
      await second?.dispose().catch(() => undefined)
      await first.dispose().catch(() => undefined)
      if (draftPath) {
        await runOfficeCli(binary!, ['close', draftPath, '--json'], { timeoutMs: 15_000 }).catch(
          () => undefined
        )
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
