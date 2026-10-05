import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  OFFICE_RANGE_ORIGIN_SESSION_ID,
  createOfficeRangeHostFixture,
  officeRangeIntegrationOptions,
  runJson,
  worksheetXml
} from './helpers/officeRangeIntegrationHarness'

test(
  'real human edits preserve types, clear content without format loss, and conflict stale Agent revisions',
  officeRangeIntegrationOptions,
  async () => {
    const fixture = await createOfficeRangeHostFixture()
    try {
      await runJson([
        'set',
        fixture.draftPath,
        '/Sheet1/A1',
        '--prop',
        'value=before',
        '--prop',
        'type=string'
      ])
      await runJson([
        'set',
        fixture.draftPath,
        '/Sheet1/A1',
        '--prop',
        'bold=true',
        '--prop',
        'fill=#FFEEAA',
        '--prop',
        'numfmt=0.00'
      ])
      await fixture.preparePreview()
      const before = (await fixture.read(
        { sheet: 'Sheet1', range: 'A1' },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as {
        ok: true
        value: { revision: number; cells: Array<{ value: unknown; format?: unknown }> }
      }
      assert.equal(before.value.revision, 0)
      const format = before.value.cells[0]?.format

      const send = (path: string, value: string): Promise<Response> =>
        fetch(`${fixture.previewUrl}api/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path, prop: 'text', value })
        })
      assert.equal((await send('/Sheet1/A1', '1e3')).status, 200)
      const afterNumber = (await fixture.read(
        { sheet: 'Sheet1', range: 'A1' },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as {
        ok: true
        value: { revision: number; cells: Array<{ value: unknown; valueType?: string }> }
      }
      assert.equal(afterNumber.value.revision, 1)
      assert.equal(afterNumber.value.cells[0]?.value, 1_000)
      assert.equal(afterNumber.value.cells[0]?.valueType, 'number')

      const stale = (await fixture.apply(
        {
          operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: 'stale' },
          baseRevision: before.value.revision
        },
        'agent-stale-after-human'
      )) as { ok: false; error: { code: string } }
      assert.equal(stale.ok, false)
      assert.equal(stale.error.code, 'revision_conflict')

      assert.equal((await send('/Sheet1/A1', '')).status, 200)
      const afterClear = (await fixture.read(
        { sheet: 'Sheet1', range: 'A1' },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as {
        ok: true
        value: {
          revision: number
          cells: Array<{ value: unknown; valueType?: string; format?: unknown }>
        }
      }
      assert.equal(afterClear.value.cells[0]?.value, null)
      assert.equal(afterClear.value.cells[0]?.valueType, 'empty')
      assert.deepEqual(afterClear.value.cells[0]?.format, format)
      const clearedXml = worksheetXml(fixture.draftPath)
      const clearedCell = clearedXml.match(/<(?:x:)?c\s[^>]*r="A1"[^>]*\/>/u)?.[0]
      assert.ok(clearedCell, `清除后磁盘 XML 缺少保留格式的 A1 节点：${clearedXml}`)
      assert.match(clearedCell, /\ss="[0-9]+"/u)
      assert.doesNotMatch(clearedCell, /<(?:x:)?(?:v|f)>/u)

      assert.equal((await send('/Sheet1/A1', '=SUM(1,2)')).status, 200)
      const invalidFormulaResponse = await send('/Sheet1/A1', '=1/0')
      assert.equal(invalidFormulaResponse.status, 422)
      assert.deepEqual(await invalidFormulaResponse.json(), {
        ok: false,
        code: 'formula_invalid'
      })
      const afterInvalid = (await fixture.read(
        { sheet: 'Sheet1', range: 'A1' },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as {
        ok: true
        value: { revision: number; cells: Array<{ value: unknown; formula?: string }> }
      }
      assert.equal(afterInvalid.value.revision, 3)
      assert.equal(afterInvalid.value.cells[0]?.formula, '=SUM(1,2)')
      assert.equal(afterInvalid.value.cells[0]?.value, 3)
      assert.match(
        worksheetXml(fixture.draftPath),
        /<(?:x:)?f>SUM\(1,2\)<\/(?:x:)?f><(?:x:)?v>3<\/(?:x:)?v>/u
      )

      await new Promise((resolve) => setTimeout(resolve, 1_050))
      const forgedBodies = [
        { path: '/Sheet1/A1', props: { x: 1, y: 2 } },
        { path: '/Sheet1/A1', prop: 'text', value: 'x', file: '/tmp/other.xlsx' },
        { path: '/Sheet1/A1:B2', prop: 'text', value: 'x' },
        { path: '/Sheet1/A1', prop: 'text', value: 'x', command: 'save' },
        { path: '/Sheet1/A1', prop: 'text', value: 'x', batch: [] }
      ]
      for (const body of forgedBodies) {
        const response = await fetch(`${fixture.previewUrl}api/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
        assert.equal(response.status, 400)
      }
      const rateLimited = await fetch(`${fixture.previewUrl}api/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(forgedBodies[0])
      })
      assert.equal(rateLimited.status, 429)
      assert.equal(
        (
          await fetch(`${fixture.previewUrl}api/switch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ file: '/tmp/other.xlsx' })
          })
        ).status,
        403
      )
      assert.equal(
        (
          await fetch(`${fixture.previewUrl}api/send`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'https://evil.example'
            },
            body: JSON.stringify({ path: '/Sheet1/A1', prop: 'text', value: 'evil' })
          })
        ).status,
        403
      )
      const unchanged = (await fixture.read(
        { sheet: 'Sheet1', range: 'A1' },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as { ok: true; value: { revision: number; cells: Array<{ value: unknown }> } }
      assert.equal(unchanged.value.revision, 3)
      assert.equal(unchanged.value.cells[0]?.value, 3)

      const operations = JSON.parse(
        readFileSync(join(dirname(fixture.draftPath), 'operations.json'), 'utf8')
      ) as { operations: Record<string, { source?: string }> }
      assert.equal(
        Object.values(operations.operations).filter((operation) => operation.source === 'human')
          .length,
        4
      )
    } finally {
      await fixture.cleanup()
    }
  }
)
