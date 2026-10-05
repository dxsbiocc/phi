import assert from 'node:assert/strict'
import test from 'node:test'

import { detectOfficeFormulaCycle } from '../src/main/agent/office/office-formula-cycle'

test('detects a direct self-reference without reading another cell', async () => {
  let reads = 0
  const result = await detectOfficeFormulaCycle(
    { sheet: 'Sheet1', cell: 'a1', formula: '=A1+1' },
    async () => {
      reads += 1
      return undefined
    }
  )

  assert.equal(result, 'circular_reference')
  assert.equal(reads, 0)
})

test('follows formula dependencies to detect an indirect cycle', async () => {
  const reads: Array<{ sheet: string; cell: string }> = []
  const formulas = new Map([
    ['Sheet1!B1', { formula: 'c1' }],
    ['Sheet1!C1', { formula: '=$A$1' }]
  ])

  const result = await detectOfficeFormulaCycle(
    { sheet: 'Sheet1', cell: 'a1', formula: '=b1' },
    async (target) => {
      reads.push(target)
      return formulas.get(`${target.sheet}!${target.cell}`)
    }
  )

  assert.equal(result, 'circular_reference')
  assert.deepEqual(reads, [
    { sheet: 'Sheet1', cell: 'B1' },
    { sheet: 'Sheet1', cell: 'C1' }
  ])
})

test('detects a two-cell mutual cycle', async () => {
  const result = await detectOfficeFormulaCycle(
    { sheet: 'Sheet1', cell: 'A1', formula: '=B1' },
    async ({ cell }) => (cell === 'B1' ? { formula: '=a1' } : undefined)
  )

  assert.equal(result, 'circular_reference')
})

test('detects cycles across quoted and unquoted sheet references', async () => {
  const reads: Array<{ sheet: string; cell: string }> = []
  const formulas = new Map([
    ['Sheet2!B2', { formula: "='中文 表''一'!$C$3" }],
    ["中文 表'一!C3", { formula: '=Sheet1!A1' }]
  ])

  const result = await detectOfficeFormulaCycle(
    { sheet: 'Sheet1', cell: 'A1', formula: '=Sheet2!B2' },
    async (target) => {
      reads.push(target)
      return formulas.get(`${target.sheet}!${target.cell}`)
    }
  )

  assert.equal(result, 'circular_reference')
  assert.deepEqual(reads, [
    { sheet: 'Sheet2', cell: 'B2' },
    { sheet: "中文 表'一", cell: 'C3' }
  ])
})

test('expands every cell in a rectangular range while following dependencies', async () => {
  const reads: string[] = []
  const result = await detectOfficeFormulaCycle(
    { sheet: 'Sheet1', cell: 'A1', formula: '=SUM(B1:C2)' },
    async ({ sheet, cell }) => {
      reads.push(`${sheet}!${cell}`)
      return cell === 'B2' ? { formula: '=A1' } : undefined
    }
  )

  assert.equal(result, 'circular_reference')
  assert.deepEqual(reads, ['Sheet1!B1', 'Sheet1!C1', 'Sheet1!B2'])
})

test('ignores reference-like text inside escaped string literals and function names', async () => {
  const reads: Array<{ sheet: string; cell: string }> = []
  const result = await detectOfficeFormulaCycle(
    {
      sheet: 'Sheet1',
      cell: 'A1',
      formula: '=IF(TRUE,"A1 ""Sheet2!B2"" LOG10",SUM(B1,10,1E10))'
    },
    async (target) => {
      reads.push(target)
      return undefined
    }
  )

  assert.equal(result, undefined)
  assert.deepEqual(reads, [{ sheet: 'Sheet1', cell: 'B1' }])
})

test('returns undefined after traversing an acyclic dependency graph', async () => {
  const formulas = new Map([
    ['B1', { formula: '=C1+D1' }],
    ['C1', { formula: '=E1' }],
    ['D1', { formula: '=E1' }]
  ])
  const result = await detectOfficeFormulaCycle(
    { sheet: 'Sheet1', cell: 'A1', formula: '=B1' },
    async ({ cell }) => formulas.get(cell)
  )

  assert.equal(result, undefined)
})

test('returns reference_graph_too_large after 2,000 unique cell reads', async () => {
  let reads = 0
  const result = await detectOfficeFormulaCycle(
    { sheet: 'Sheet1', cell: 'Z3000', formula: '=A1:A2001' },
    async () => {
      reads += 1
      return undefined
    }
  )

  assert.equal(result, 'reference_graph_too_large')
  assert.equal(reads, 2_000)
})

test('returns reference_graph_too_large before descending beyond 64 levels', async () => {
  let reads = 0
  const result = await detectOfficeFormulaCycle(
    { sheet: 'Sheet1', cell: 'A1', formula: '=A2' },
    async ({ cell }) => {
      reads += 1
      const row = Number(cell.slice(1))
      return { formula: `=A${row + 1}` }
    }
  )

  assert.equal(result, 'reference_graph_too_large')
  assert.equal(reads, 64)
})
