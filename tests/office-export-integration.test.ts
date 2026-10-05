import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { officeCliEnv, runOfficeCli } from '../src/main/agent/office/office-driver'
import { parseOfficeDelimitedBytes } from '../src/main/agent/office/office-import-csv'
import {
  OFFICE_RANGE_ORIGIN_SESSION_ID,
  createOfficeRangeHostFixture,
  officeBinary,
  officeRangeIntegrationOptions,
  runJson
} from './helpers/officeRangeIntegrationHarness'

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

test(
  'real OfficeCLI exports computed values, latest edits, and only the selected sheet',
  officeRangeIntegrationOptions,
  async () => {
    const fixture = await createOfficeRangeHostFixture({ prepareSource: prepareSpecialWorkbook })
    try {
      await fixture.preparePreview()
      const before = (await fixture.read(
        { sheet: 'Sheet1', range: 'A1:F3' },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as { ok: true; value: { revision: number } }
      const firstEdit = (await fixture.apply(
        {
          operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'A3', value: 'latest-v1' },
          baseRevision: before.value.revision
        },
        'export-latest-v1'
      )) as { ok: true; value: { revision: number } }
      const csvPath = join(fixture.sourcePath, '..', 'special-Sheet1.csv')
      const csv = await fixture.exportSheet({
        targetPath: csvPath,
        requestId: 'real-export-csv',
        sheet: 'Sheet1',
        format: 'csv'
      })
      const csvBytes = await readFile(csvPath)
      const parsedCsv = parseOfficeDelimitedBytes(csvBytes, 'csv')
      assert.deepEqual(parsedCsv.values, expectedMainValues('latest-v1'))
      assert.equal(csv.sha256, digest(csvBytes))
      assert.equal(csv.revision, firstEdit.value.revision)

      const secondEdit = (await fixture.apply(
        {
          operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'A3', value: 'latest-v2' },
          baseRevision: firstEdit.value.revision
        },
        'export-latest-v2'
      )) as { ok: true; value: { revision: number } }
      const tsvPath = join(fixture.sourcePath, '..', 'special-Sheet1.tsv')
      const tsv = await fixture.exportSheet({
        targetPath: tsvPath,
        requestId: 'real-export-tsv',
        sheet: 'Sheet1',
        format: 'tsv'
      })
      assert.deepEqual(
        parseOfficeDelimitedBytes(await readFile(tsvPath), 'tsv').values,
        expectedMainValues('latest-v2')
      )
      assert.equal(tsv.revision, secondEdit.value.revision)

      const otherPath = join(fixture.sourcePath, '..', 'special-Other.csv')
      const other = await fixture.exportSheet({
        targetPath: otherPath,
        requestId: 'real-export-other',
        sheet: 'Other',
        format: 'csv'
      })
      assert.deepEqual(parseOfficeDelimitedBytes(await readFile(otherPath), 'csv').values, [
        ['only-other-sheet']
      ])
      assert.equal(other.sheet, 'Other')
      assert.equal(other.rows, 1)
      assert.equal(other.columns, 1)

      await assert.rejects(
        fixture.exportSheet({
          targetPath: csvPath,
          requestId: 'real-export-existing',
          sheet: 'Sheet1',
          format: 'csv'
        }),
        { code: 'target_exists' }
      )
      assert.equal(digest(await readFile(csvPath)), csv.sha256)
      const linked = join(fixture.sourcePath, '..', 'linked-export.csv')
      await symlink(csvPath, linked)
      await assert.rejects(
        fixture.exportSheet({
          targetPath: linked,
          requestId: 'real-export-symlink',
          sheet: 'Sheet1',
          format: 'csv'
        }),
        { code: 'unsafe_path' }
      )
      await assert.rejects(
        fixture.exportSheet({
          targetPath: join(fixture.sourcePath, '..', '..', 'outside.csv'),
          requestId: 'real-export-outside',
          sheet: 'Sheet1',
          format: 'csv'
        }),
        { code: 'outside_project' }
      )
    } finally {
      await fixture.cleanup()
    }
  }
)

test(
  'real OfficeCLI export reads the complete sparse 1000 by 80 used range',
  officeRangeIntegrationOptions,
  async () => {
    const fixture = await createOfficeRangeHostFixture({ prepareSource: prepareLargeWorkbook })
    try {
      const targetPath = join(fixture.sourcePath, '..', 'large.csv')
      const output = await fixture.exportSheet({
        targetPath,
        requestId: 'real-export-large',
        sheet: 'Sheet1',
        format: 'csv'
      })
      const parsed = parseOfficeDelimitedBytes(await readFile(targetPath), 'csv')
      assert.equal(output.rows, 1_000)
      assert.equal(output.columns, 80)
      assert.equal(parsed.rows, 1_000)
      assert.equal(parsed.columns, 80)
      assert.equal(parsed.values[0]?.[0], 'first')
      assert.equal(parsed.values[999]?.[79], 'last')
    } finally {
      await fixture.cleanup()
    }
  }
)

async function prepareSpecialWorkbook(path: string): Promise<void> {
  await runJson(['create', path])
  await runJson(['add', path, '/', '--type', 'sheet', '--prop', 'name=Other'])
  await runBatch(path, [
    set('/Sheet1/A1', 'a,b'),
    set('/Sheet1/B1', 'He said "hi"'),
    set('/Sheet1/C1', 'line1\nline2'),
    set('/Sheet1/D1', '中文🙂'),
    set('/Sheet1/E1', '=literal'),
    set('/Sheet1/F1', '007'),
    set('/Sheet1/A2', 'tab\tvalue'),
    set('/Sheet1/B2', 'emoji🚀'),
    number('/Sheet1/C2', 2),
    number('/Sheet1/D2', 3),
    { command: 'set', path: '/Sheet1/E2', props: { formula: 'SUM(C2:D2)' } },
    { command: 'set', path: '/Sheet1/F2', props: { value: true, type: 'boolean' } },
    set('/Other/A1', 'only-other-sheet')
  ])
  await runJson(['save', path])
  await runJson(['close', path])
}

async function prepareLargeWorkbook(path: string): Promise<void> {
  await runJson(['create', path])
  await runBatch(path, [set('/Sheet1/A1', 'first'), set('/Sheet1/CB1000', 'last')])
  await runJson(['save', path])
  await runJson(['close', path])
}

async function runBatch(path: string, commands: readonly unknown[]): Promise<void> {
  const result = await runOfficeCli(officeBinary!, ['batch', path, '--json'], {
    stdin: JSON.stringify(commands),
    env: officeCliEnv(process.env, { OFFICECLI_RESIDENT_FLUSH: 'each' }),
    timeoutMs: 30_000
  })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
}

function set(
  path: string,
  value: string
): { command: string; path: string; props: { value: string; type: string } } {
  return { command: 'set', path, props: { value, type: 'string' } }
}

function number(
  path: string,
  value: number
): { command: string; path: string; props: { value: number; type: string } } {
  return { command: 'set', path, props: { value, type: 'number' } }
}

function expectedMainValues(latest: string): readonly (readonly string[])[] {
  const values = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => ''))
  values[0]!.splice(0, 6, 'a,b', 'He said "hi"', 'line1\nline2', '中文🙂', '=literal', '007')
  values[1]!.splice(0, 6, 'tab\tvalue', 'emoji🚀', '2', '3', '5', 'TRUE')
  values[2]![0] = latest
  values[9]![9] = 'preview-ready'
  return values
}
