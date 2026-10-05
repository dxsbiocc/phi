import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OfficeApplyApprovalRegistry,
  formatOfficeApplyApprovalSummary,
  officeApplyApprovalDigest
} from '../src/main/agent/office/office-approval'
import {
  OfficeDeliverApprovalRegistry,
  formatOfficeDeliverApprovalSummary,
  officeDeliverApprovalDigest
} from '../src/main/agent/office/office-deliver-approval'

test('Office write approval summary makes user data visible without preserving control markup', () => {
  const summary = formatOfficeApplyApprovalSummary({
    documentName: '实验<一>.xlsx',
    sheet: 'Sheet1',
    cell: 'A1',
    before: '旧值\n```html\n<script>alert(1)</script>\u202e',
    after: `新值\r\n${'很长'.repeat(80)}`,
    revision: 4
  })

  assert.match(summary, /^将 Sheet1!A1 从「旧值↵/u)
  assert.match(summary, /改为「新值↵/u)
  assert.match(summary, /…（已截断）/u)
  assert.match(summary, /文档：实验‹一›\.xlsx/u)
  assert.doesNotMatch(summary, /[\r\n<>]/u)
  assert.doesNotMatch(summary, /\u202e/u)
  assert.ok(summary.length < 260)
})

test('Office range approval summary is bounded and shows at most six escaped changes', () => {
  const summary = formatOfficeApplyApprovalSummary({
    type: 'set_range',
    documentName: '实验<一>.xlsx',
    sheet: 'Sheet1',
    range: 'A1:D20',
    rowCount: 20,
    columnCount: 4,
    cellCount: 80,
    changedCells: 80,
    preview: Array.from({ length: 6 }, (_, index) => ({
      cell: `A${index + 1}`,
      before: `旧<${index}>\n\u202e`,
      after: `新\`${index}\``
    })),
    revision: 4
  })

  assert.match(summary, /Sheet1!A1:D20/u)
  assert.match(summary, /20 行 × 4 列，共 80 格/u)
  assert.match(summary, /80 格将改变/u)
  assert.equal((summary.match(/→/gu) ?? []).length, 6)
  assert.doesNotMatch(summary, /[\r\n<>`\u202e]/u)
  assert.ok(summary.length <= 1_200)
})

test('Office write approval digest binds the exact operation and base revision', () => {
  const input = {
    operation: { type: 'set_cell' as const, sheet: 'Sheet1', cell: 'A1', value: '实验编号' },
    baseRevision: 4
  }
  const approved = officeApplyApprovalDigest(input)

  assert.equal(approved, officeApplyApprovalDigest({ ...input, operation: { ...input.operation } }))
  assert.notEqual(
    approved,
    officeApplyApprovalDigest({ ...input, operation: { ...input.operation, cell: 'A2' } })
  )
  assert.notEqual(
    approved,
    officeApplyApprovalDigest({ ...input, operation: { ...input.operation, value: '被篡改' } })
  )
  assert.notEqual(approved, officeApplyApprovalDigest({ ...input, baseRevision: 5 }))
})

test('Office range approval digest binds every value in the normalized matrix', () => {
  const input = {
    operation: {
      type: 'set_range' as const,
      sheet: 'Sheet1',
      range: 'A1:B2',
      values: [
        ['A', 2],
        [true, 'D']
      ]
    },
    baseRevision: 4
  }
  const approved = officeApplyApprovalDigest(input)

  assert.equal(approved, officeApplyApprovalDigest(structuredClone(input)))
  assert.notEqual(
    approved,
    officeApplyApprovalDigest({
      ...input,
      operation: {
        ...input.operation,
        values: [
          ['A', 2],
          [true, 'changed']
        ]
      }
    })
  )
})

test('Office write approval is one-shot and parameter tampering consumes the grant', () => {
  const registry = new OfficeApplyApprovalRegistry({ clock: () => 1_000 })
  const input = {
    operation: { type: 'set_cell' as const, sheet: 'Sheet1', cell: 'A1', value: '实验编号' },
    baseRevision: 4
  }
  registry.grant('run-1', 'tool-1', officeApplyApprovalDigest(input))

  assert.equal(
    registry.consume('run-1', 'tool-1', {
      ...input,
      operation: { ...input.operation, value: '批准后篡改' }
    }),
    false
  )
  assert.equal(registry.consume('run-1', 'tool-1', input), false)

  registry.grant('run-1', 'tool-2', officeApplyApprovalDigest(input))
  assert.equal(registry.consume('run-1', 'tool-2', input), true)
  assert.equal(registry.consume('run-1', 'tool-2', input), false)
})

test('Office range approval rejects a one-cell matrix change', () => {
  const registry = new OfficeApplyApprovalRegistry({ clock: () => 1_000 })
  const input = {
    operation: {
      type: 'set_range' as const,
      sheet: 'Sheet1',
      range: 'A1:B2',
      values: [
        ['A', 'B'],
        ['C', 'D']
      ]
    },
    baseRevision: 4
  }
  registry.grant('run-1', 'range-tool', officeApplyApprovalDigest(input))

  assert.equal(
    registry.consume('run-1', 'range-tool', {
      ...input,
      operation: {
        ...input.operation,
        values: [
          ['A', 'B'],
          ['C', 'changed']
        ]
      }
    }),
    false
  )
})

test('Office delivery approval binds the filename and shows type plus workspace location', () => {
  const input = { outputName: '季度<报告>' }
  const registry = new OfficeDeliverApprovalRegistry({ clock: () => 1_000 })
  const digest = officeDeliverApprovalDigest(input)
  registry.grant('run-1', 'deliver-1', digest)

  const summary = formatOfficeDeliverApprovalSummary({
    fileName: '季度<报告>.xlsx',
    kind: 'xlsx',
    outputPath: '季度<报告>.xlsx'
  })
  assert.match(summary, /Excel 表格/u)
  assert.match(summary, /季度‹报告›\.xlsx/u)
  assert.match(summary, /当前工作区.*相对位置/u)
  assert.equal(registry.consume('run-1', 'deliver-1', { outputName: '篡改' }), false)
  assert.equal(registry.consume('run-1', 'deliver-1', input), false)
})
