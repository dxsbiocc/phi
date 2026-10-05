import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { officeCliEnv, runOfficeCli } from '../src/main/agent/office/office-driver'
import {
  OFFICE_RANGE_ORIGIN_SESSION_ID,
  createOfficeRangeHostFixture,
  officeBinary,
  officeRangeIntegrationOptions,
  percentile,
  runJson,
  worksheetXml,
  type RangeApplyInput
} from './helpers/officeRangeIntegrationHarness'

test(
  'real host set_range writes A1:D20 with resident, disk, preview, and one revision',
  officeRangeIntegrationOptions,
  async () => {
    const fixture = await createOfficeRangeHostFixture()
    try {
      const sourceDigest = createHash('sha256')
        .update(readFileSync(fixture.sourcePath))
        .digest('hex')
      const initialCommands = Array.from({ length: 20 }, (_, row) =>
        Array.from({ length: 4 }, (_, column) => ({
          command: 'set',
          path: `/Sheet1/${String.fromCharCode(65 + column)}${row + 1}`,
          props: { value: 0, type: 'number' }
        }))
      ).flat()
      const initialized = await runOfficeCli(
        officeBinary!,
        ['batch', fixture.draftPath, '--json'],
        {
          stdin: JSON.stringify(initialCommands),
          env: officeCliEnv(process.env, { OFFICECLI_RESIDENT_FLUSH: 'each' }),
          timeoutMs: 30_000
        }
      )
      assert.equal(initialized.exitCode, 0, initialized.stderr)
      await fixture.preparePreview()
      const seed = (await fixture.apply(
        {
          operation: {
            type: 'set_cell',
            sheet: 'Sheet1',
            cell: 'J10',
            value: 'preview-seed'
          },
          baseRevision: 0
        },
        'range-preview-seed'
      )) as { ok: true; value: { previewConfirmed: boolean } }
      assert.equal(seed.value.previewConfirmed, true, JSON.stringify(seed))
      const before = (await fixture.read(
        { sheet: 'Sheet1', range: 'A1:D20', maxCells: 2_000 },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as { ok: true; value: { revision: number } }
      const values = Array.from({ length: 20 }, (_, row) =>
        Array.from({ length: 4 }, (_, column) => row * 4 + column + 1)
      )
      const input: RangeApplyInput = {
        operation: { type: 'set_range', sheet: 'Sheet1', range: 'A1:D20', values },
        baseRevision: before.value.revision
      }
      const described = (await fixture.describe(input, {
        originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID
      })) as { ok: true; value: { changedCells: number; cellCount: number } }
      assert.equal(described.value.cellCount, 80)
      assert.equal(described.value.changedCells, 80)

      const applied = (await fixture.apply(input, 'range-a1-d20')) as {
        ok: true
        value: { revision: number; changedCells: number; previewConfirmed: boolean }
      }
      assert.equal(applied.value.revision, before.value.revision + 1)
      assert.equal(applied.value.changedCells, 80)
      assert.equal(applied.value.previewConfirmed, true, JSON.stringify(applied))
      assert.match(fixture.previewEvents(), /"action":"(?:excel-patch|full)"/u)

      const readBack = (await fixture.read(
        { sheet: 'Sheet1', range: 'A1:D20', maxCells: 2_000 },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as { ok: true; value: { cells: Array<{ value: unknown }>; revision: number } }
      assert.deepEqual(
        readBack.value.cells.map((cell) => cell.value),
        values.flat()
      )
      assert.equal(readBack.value.revision, applied.value.revision)
      const xml = worksheetXml(fixture.draftPath)
      const refs = [...xml.matchAll(/\br="([A-D](?:[1-9]|1\d|20))"/gu)]
      assert.equal(new Set(refs.map((match) => match[1])).size, 80)
      const diskValues = new Map(
        [
          ...xml.matchAll(
            /<(?:x:)?c\b[^>]*\br="([A-D](?:[1-9]|1\d|20))"[^>]*>[\s\S]*?<(?:x:)?v>([^<]+)<\/(?:x:)?v>[\s\S]*?<\/(?:x:)?c>/gu
          )
        ].map((match) => [match[1], Number(match[2])])
      )
      for (let row = 0; row < 20; row += 1) {
        for (let column = 0; column < 4; column += 1) {
          const ref = `${String.fromCharCode(65 + column)}${row + 1}`
          assert.equal(diskValues.get(ref), values[row]![column], ref)
        }
      }
      assert.equal(
        createHash('sha256').update(readFileSync(fixture.sourcePath)).digest('hex'),
        sourceDigest
      )
    } finally {
      await fixture.cleanup()
    }
  }
)

test(
  'real set_range batch failure proves atomic rollback without freezing',
  officeRangeIntegrationOptions,
  async () => {
    let rollbackReceipt: Awaited<ReturnType<typeof runOfficeCli>> | undefined
    let intercepted = false
    const fixture = await createOfficeRangeHostFixture({
      runOfficeCli: async (binaryPath, args, runOptions) => {
        if (args[0] !== 'batch' || !runOptions?.stdin || intercepted) {
          return runOfficeCli(binaryPath, args, runOptions)
        }
        intercepted = true
        const commands = JSON.parse(runOptions.stdin) as Array<Record<string, unknown>>
        commands[2] = { ...commands[2], path: '/MissingSheet/A1' }
        rollbackReceipt = await runOfficeCli(binaryPath, args, {
          ...runOptions,
          stdin: JSON.stringify(commands)
        })
        return rollbackReceipt
      }
    })
    try {
      const input: RangeApplyInput = {
        operation: {
          type: 'set_range',
          sheet: 'Sheet1',
          range: 'A1:B2',
          values: [
            ['A', 'B'],
            ['C', 'D']
          ]
        },
        baseRevision: 0
      }
      const failed = (await fixture.apply(input, 'range-rollback')) as {
        ok: false
        error: { code: string }
      }
      assert.equal(failed.error.code, 'write_failed')
      assert.equal(rollbackReceipt?.exitCode, 1)
      const raw = JSON.parse(rollbackReceipt!.stdout) as {
        success: boolean
        data: { summary: { atomicRolledBack?: boolean } }
      }
      assert.equal(raw.success, false)
      assert.equal(raw.data.summary.atomicRolledBack, true)
      const unchanged = (await fixture.read(
        { sheet: 'Sheet1', range: 'A1:B2' },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as { ok: true; value: { revision: number; cells: Array<{ value: unknown }> } }
      assert.equal(unchanged.value.revision, 0)
      assert.deepEqual(
        unchanged.value.cells.map((cell) => cell.value),
        [null, null, null, null]
      )
      const retry = (await fixture.apply(input, 'range-after-rollback')) as {
        ok: boolean
        value?: { revision?: number }
      }
      assert.equal(retry.ok, true)
      assert.equal(retry.value?.revision, 1)
    } finally {
      await fixture.cleanup()
    }
  }
)

test(
  'real lost range replies reconcile applied, not_applied, and mixed without replay',
  officeRangeIntegrationOptions,
  async () => {
    for (const mode of ['applied', 'not_applied', 'mixed'] as const) {
      let batchCalls = 0
      let intercepted = false
      let draftPath = ''
      const fixture = await createOfficeRangeHostFixture({
        runOfficeCli: async (binaryPath, args, runOptions) => {
          if (args[0] !== 'batch' || intercepted) {
            return runOfficeCli(binaryPath, args, runOptions)
          }
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
          const applied = await runOfficeCli(binaryPath, args, runOptions)
          if (mode === 'mixed') {
            await runOfficeCli(
              binaryPath,
              [
                'set',
                draftPath,
                '/Sheet1/A1',
                '--prop',
                'value=third-value',
                '--prop',
                'type=string',
                '--json'
              ],
              {
                timeoutMs: 30_000,
                env: officeCliEnv(process.env, { OFFICECLI_RESIDENT_FLUSH: 'each' })
              }
            )
          }
          return { ...applied, stdout: '{lost-reply' }
        }
      })
      draftPath = fixture.draftPath
      try {
        const input: RangeApplyInput = {
          operation: {
            type: 'set_range',
            sheet: 'Sheet1',
            range: 'A1:B2',
            values: [
              ['A', 'B'],
              ['C', 'D']
            ]
          },
          baseRevision: 0
        }
        const result = (await fixture.apply(input, `lost-${mode}`)) as {
          ok: boolean
          value?: { revision?: number; reconciled?: boolean }
          error?: { code?: string }
        }
        if (mode === 'applied') {
          assert.equal(result.ok, true)
          assert.equal(result.value?.revision, 1)
          assert.equal(result.value?.reconciled, true)
        } else if (mode === 'not_applied') {
          assert.equal(result.ok, false)
          assert.equal(result.error?.code, 'write_not_applied')
        } else {
          assert.equal(result.ok, false)
          assert.equal(result.error?.code, 'write_unknown')
          const blocked = (await fixture.apply(input, 'blocked-after-mixed')) as {
            ok: false
            error: { code: string }
          }
          assert.equal(blocked.error.code, 'document_frozen')
        }
        const readable = (await fixture.read(
          { sheet: 'Sheet1', range: 'A1:B2' },
          { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
        )) as { ok: boolean }
        assert.equal(readable.ok, true)
        assert.equal(batchCalls, 1)
      } finally {
        await fixture.cleanup()
      }
    }
  }
)

test(
  'two real documents apply independent ranges with the same operation id',
  officeRangeIntegrationOptions,
  async () => {
    const first = await createOfficeRangeHostFixture()
    const second = await createOfficeRangeHostFixture()
    try {
      const firstResult = (await first.apply(
        {
          operation: {
            type: 'set_range',
            sheet: 'Sheet1',
            range: 'A1:B1',
            values: [['first-a', 'first-b']]
          },
          baseRevision: 0
        },
        'same-range-operation-id'
      )) as { ok: boolean }
      const secondResult = (await second.apply(
        {
          operation: {
            type: 'set_range',
            sheet: 'Sheet1',
            range: 'A1:B1',
            values: [['second-a', 'second-b']]
          },
          baseRevision: 0
        },
        'same-range-operation-id'
      )) as { ok: boolean }
      assert.equal(firstResult.ok, true)
      assert.equal(secondResult.ok, true)
      const firstRead = (await first.read(
        { sheet: 'Sheet1', range: 'A1:B1' },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as { ok: true; value: { cells: Array<{ value: unknown }> } }
      const secondRead = (await second.read(
        { sheet: 'Sheet1', range: 'A1:B1' },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as { ok: true; value: { cells: Array<{ value: unknown }> } }
      assert.deepEqual(
        firstRead.value.cells.map((cell) => cell.value),
        ['first-a', 'first-b']
      )
      assert.deepEqual(
        secondRead.value.cells.map((cell) => cell.value),
        ['second-a', 'second-b']
      )
    } finally {
      await second.cleanup()
      await first.cleanup()
    }
  }
)

test(
  'real 100-cell set_range records preview and transaction latency budgets',
  officeRangeIntegrationOptions,
  async (t) => {
    let batchStartedAt = 0
    const fixture = await createOfficeRangeHostFixture({
      runOfficeCli: async (binaryPath, args, runOptions) => {
        if (args[0] === 'batch') batchStartedAt = performance.now()
        return runOfficeCli(binaryPath, args, runOptions)
      },
      prepareSource: async (sourcePath) => {
        const csvPath = join(dirname(sourcePath), 'large.csv')
        const rows = Array.from({ length: 1_000 }, (_, row) =>
          Array.from({ length: 10 }, (_, column) => row * 10 + column + 1).join(',')
        ).join('\n')
        writeFileSync(csvPath, rows)
        await runJson(['create', sourcePath])
        await runJson(['import', sourcePath, '/Sheet1', csvPath])
        await runJson(['close', sourcePath])
      },
      previewSeedCell: 'J1000'
    })
    try {
      await fixture.preparePreview()
      const initial = (await fixture.read(
        { sheet: 'Sheet1', range: 'A1:J10', maxCells: 2_000 },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as { ok: true; value: { revision: number } }
      let revision = initial.value.revision
      const previewSamples: number[] = []
      const transactionSamples: number[] = []
      const affectedCells = new Set(
        Array.from({ length: 10 }, (_, row) =>
          Array.from({ length: 10 }, (_, column) => `${String.fromCharCode(65 + column)}${row + 1}`)
        ).flat()
      )
      for (let index = -2; index < 20; index += 1) {
        const offset = index % 2 === 0 ? 10_000 : 20_000
        const values = Array.from({ length: 10 }, (_, row) =>
          Array.from({ length: 10 }, (_, column) => offset + row * 10 + column)
        )
        const updatesBefore = fixture.previewUpdates().length
        const transactionStartedAt = performance.now()
        const applied = (await fixture.apply(
          {
            operation: { type: 'set_range', sheet: 'Sheet1', range: 'A1:J10', values },
            baseRevision: revision
          },
          `range-performance-${index + 2}`
        )) as { ok: true; value: { revision: number; previewConfirmed: boolean } }
        const transactionEndedAt = performance.now()
        assert.equal(applied.value.previewConfirmed, true, JSON.stringify(applied))
        const covered = new Set<string>()
        let visibleAt: number | undefined
        for (const update of fixture.previewUpdates().slice(updatesBefore)) {
          if (update.action === 'full') {
            visibleAt = update.at
            break
          }
          if (update.action !== 'excel-patch') continue
          for (const cell of update.cells) {
            if (affectedCells.has(cell)) covered.add(cell)
          }
          if (covered.size === affectedCells.size) {
            visibleAt = update.at
            break
          }
        }
        assert.notEqual(visibleAt, undefined)
        revision = applied.value.revision
        if (index >= 0) {
          previewSamples.push(visibleAt! - batchStartedAt)
          transactionSamples.push(transactionEndedAt - transactionStartedAt)
        }
      }
      const metrics = {
        samples: previewSamples.length,
        previewMs: {
          p50: percentile(previewSamples, 0.5),
          p95: percentile(previewSamples, 0.95),
          max: Math.max(...previewSamples)
        },
        transactionMs: {
          p50: percentile(transactionSamples, 0.5),
          p95: percentile(transactionSamples, 0.95)
        },
        rawPreviewMs: previewSamples,
        rawTransactionMs: transactionSamples
      }
      t.diagnostic(`O09_PERFORMANCE ${JSON.stringify(metrics)}`)
      assert.ok(metrics.previewMs.p95 <= 1_500, JSON.stringify(metrics))
      assert.ok(metrics.transactionMs.p95 <= 3_000, JSON.stringify(metrics))
    } finally {
      await fixture.cleanup()
    }
  }
)
