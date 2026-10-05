import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { officeCliEnv, runOfficeCli } from '../src/main/agent/office/office-driver'
import {
  OFFICE_RANGE_ORIGIN_SESSION_ID,
  createOfficeRangeHostFixture,
  officeBinary,
  officeRangeIntegrationOptions,
  type RangeApplyInput
} from './helpers/officeRangeIntegrationHarness'

type HostResult = {
  ok: boolean
  value?: { revision: number; computedValue?: unknown; reconciled?: boolean }
  error?: { code: string; result?: { revision?: number; reason?: string } }
}

async function readCells(
  fixture: Awaited<ReturnType<typeof createOfficeRangeHostFixture>>,
  range: string
): Promise<Array<{ value: unknown; formula?: string; evaluated?: boolean; valueType?: string }>> {
  const result = (await fixture.read(
    { sheet: 'Sheet1', range },
    { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
  )) as { ok: true; value: { cells: Array<Record<string, unknown>> } }
  assert.equal(result.ok, true)
  return result.value.cells
}

async function apply(
  fixture: Awaited<ReturnType<typeof createOfficeRangeHostFixture>>,
  input: RangeApplyInput,
  operationId: string
): Promise<HostResult> {
  return (await fixture.apply(input, operationId)) as HostResult
}

test(
  'real set_formula computes verified common functions and dependent cells recalculate',
  officeRangeIntegrationOptions,
  async () => {
    const source = join(process.cwd(), 'tests', 'fixtures', 'office', 'sample.xlsx')
    const fixture = await createOfficeRangeHostFixture({
      prepareSource: async (target) => cpSync(source, target)
    })
    const sourceHash = createHash('sha256').update(readFileSync(fixture.sourcePath)).digest('hex')
    try {
      await fixture.preparePreview()
      const initialized = await apply(
        fixture,
        {
          operation: {
            type: 'set_range',
            sheet: 'Sheet1',
            range: 'A1:C3',
            values: [
              [1, 'A', 10],
              [2, 'B', 20],
              [3, 'A', 30]
            ]
          },
          baseRevision: 0
        },
        'formula-initialize'
      )
      assert.equal(initialized.ok, true)
      let revision = initialized.value!.revision
      const formulas = [
        ['E1', '=SUM(A1:A3)', 6],
        ['E2', '=AVERAGE(A1:A3)', 2],
        ['E3', '=$A$1+$A$3', 4],
        ['E4', '=IF(A1=1,"yes","no")', 'yes'],
        ['E5', '=VLOOKUP("B",B1:C3,2,FALSE)', 20],
        ['E6', '=XLOOKUP("B",B1:B3,C1:C3,"missing",0)', 20],
        ['E7', '=SUMIF(B1:B3,"A",C1:C3)', 40],
        ['E8', '=COUNTIF(B1:B3,"A")', 2],
        ['E9', '=INDEX(C1:C3,MATCH("B",B1:B3,0))', 20],
        ['E10', '=SUMPRODUCT(A1:A3,C1:C3)', 140],
        ['E11', '=ROUND(10/3,2)', 3.33],
        ['E12', '=TEXT(DATE(2024,1,2),"yyyy-mm-dd")', '2024-01-02'],
        ['E13', '=DATE(2024,1,2)', 45293],
        ['E14', "='说明'!A2", 'Phi Office 实时预览样例'],
        ['E15', '=ROUND(AVERAGE(A1:A3),1)', 2],
        ['E16', '=IF(A1=1,"he said ""yes"", ok","no")', 'he said "yes", ok'],
        ['E17', '=A1=1', true]
      ] as const
      for (const [cell, formula, expected] of formulas) {
        const result = await apply(
          fixture,
          {
            operation: { type: 'set_formula', sheet: 'Sheet1', cell, formula },
            baseRevision: revision
          },
          `formula-${cell.toLowerCase()}`
        )
        assert.equal(result.ok, true, JSON.stringify(result))
        assert.equal(result.value?.computedValue, expected, formula)
        revision = result.value!.revision
      }

      const cells = await readCells(fixture, 'E1:E17')
      assert.deepEqual(
        cells.map((cell) => cell.value),
        formulas.map((entry) => entry[2])
      )
      assert.ok(cells.every((cell) => cell.evaluated === true))
      assert.deepEqual(
        cells.map((cell) => cell.formula),
        formulas.map((entry) => entry[1])
      )

      const dependency = await apply(
        fixture,
        {
          operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: 10 },
          baseRevision: revision
        },
        'formula-dependent-change'
      )
      assert.equal(dependency.ok, true)
      assert.equal((await readCells(fixture, 'E1'))[0]?.value, 15)
      assert.equal(
        createHash('sha256').update(readFileSync(fixture.sourcePath)).digest('hex'),
        sourceHash
      )
      const validation = await runOfficeCli(
        officeBinary!,
        ['validate', fixture.draftPath, '--json'],
        {
          timeoutMs: 30_000,
          env: officeCliEnv(process.env)
        }
      )
      assert.equal(validation.exitCode, 0, validation.stderr || validation.stdout)
    } finally {
      await fixture.cleanup()
    }
  }
)

test(
  'real invalid formulas roll back values, formulas, empty cells, and revision',
  officeRangeIntegrationOptions,
  async () => {
    const fixture = await createOfficeRangeHostFixture()
    try {
      const initialized = await apply(
        fixture,
        {
          operation: {
            type: 'set_range',
            sheet: 'Sheet1',
            range: 'A1:A3',
            values: [[1], [2], [3]]
          },
          baseRevision: 0
        },
        'formula-invalid-initialize'
      )
      let revision = initialized.value!.revision
      const seeded = await apply(
        fixture,
        {
          operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'E20', value: '保留内容' },
          baseRevision: revision
        },
        'formula-invalid-seed'
      )
      revision = seeded.value!.revision
      const invalid = [
        ['=NOSUCHFN(A1)', 'unsupported_function'],
        ['=1/0', 'error_value'],
        ['=UNKNOWNNAME', 'error_value'],
        ['=INDEX(A1:A3,99)', 'error_value'],
        ['="x"+1', 'error_value'],
        ['=NA()', 'error_value'],
        ['=#REF!', 'error_value'],
        ['=SUM(A1:A3', 'invalid_syntax']
      ] as const
      for (const [index, [formula, reason]] of invalid.entries()) {
        const result = await apply(
          fixture,
          {
            operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'E20', formula },
            baseRevision: revision
          },
          `formula-invalid-${index}`
        )
        assert.equal(result.ok, false, JSON.stringify(result))
        assert.equal(result.error?.code, 'formula_invalid')
        assert.equal(result.error?.result?.revision, revision)
        assert.equal(result.error?.result?.reason, reason)
        assert.equal((await readCells(fixture, 'E20'))[0]?.value, '保留内容')
      }

      const oldFormula = await apply(
        fixture,
        {
          operation: {
            type: 'set_formula',
            sheet: 'Sheet1',
            cell: 'E21',
            formula: '=SUM(A1:A3)'
          },
          baseRevision: revision
        },
        'formula-old-valid'
      )
      revision = oldFormula.value!.revision
      const replacement = await apply(
        fixture,
        {
          operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'E21', formula: '=1/0' },
          baseRevision: revision
        },
        'formula-old-restore'
      )
      assert.equal(replacement.error?.code, 'formula_invalid')
      const restoredFormula = (await readCells(fixture, 'E21'))[0]
      assert.equal(restoredFormula?.formula, '=SUM(A1:A3)')
      assert.equal(restoredFormula?.value, 6)
      assert.equal(restoredFormula?.evaluated, true)

      const emptyFailure = await apply(
        fixture,
        {
          operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'E22', formula: '=1/0' },
          baseRevision: revision
        },
        'formula-empty-restore'
      )
      assert.equal(emptyFailure.error?.code, 'formula_invalid')
      assert.equal((await readCells(fixture, 'E22'))[0]?.value, null)

      const circular = await apply(
        fixture,
        {
          operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'E23', formula: '=E23+1' },
          baseRevision: revision
        },
        'formula-circular-restore'
      )
      assert.equal(circular.error?.result?.reason, 'circular_reference')
      assert.equal((await readCells(fixture, 'E23'))[0]?.value, null)

      const literalEquals = await apply(
        fixture,
        {
          operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'E24', value: '=SUM(A1:A3)' },
          baseRevision: revision
        },
        'formula-literal-rejected'
      )
      assert.equal(literalEquals.error?.code, 'formula_not_supported')
      assert.equal((await readCells(fixture, 'E24'))[0]?.value, null)
    } finally {
      await fixture.cleanup()
    }
  }
)

test(
  'real lost formula replies reconcile applied and not_applied without replay',
  officeRangeIntegrationOptions,
  async () => {
    for (const mode of ['applied', 'not_applied'] as const) {
      let intercepted = false
      let formulaBatchCalls = 0
      const fixture = await createOfficeRangeHostFixture({
        runOfficeCli: async (binaryPath, args, options) => {
          const isFormulaBatch =
            args[0] === 'batch' &&
            typeof options?.stdin === 'string' &&
            options.stdin.includes('formula')
          if (!isFormulaBatch || intercepted) return runOfficeCli(binaryPath, args, options)
          intercepted = true
          formulaBatchCalls += 1
          if (mode === 'not_applied') {
            return { exitCode: null, stdout: '', stderr: '', timedOut: true, truncated: false }
          }
          const applied = await runOfficeCli(binaryPath, args, options)
          return { ...applied, stdout: '{lost-reply' }
        }
      })
      try {
        const result = await apply(
          fixture,
          {
            operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'E1', formula: '=1+1' },
            baseRevision: 0
          },
          `formula-lost-${mode}`
        )
        if (mode === 'applied') {
          assert.equal(result.ok, true)
          assert.equal(result.value?.computedValue, 2)
          assert.equal(result.value?.reconciled, true)
        } else {
          assert.equal(result.ok, false)
          assert.equal(result.error?.code, 'write_not_applied')
        }
        assert.equal(formulaBatchCalls, 1)
      } finally {
        await fixture.cleanup()
      }
    }
  }
)
