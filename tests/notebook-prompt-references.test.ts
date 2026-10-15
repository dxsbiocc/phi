import assert from 'node:assert/strict'
import test from 'node:test'
import {
  notebookPromptContextReferences,
  notebookPromptReferences
} from '../src/renderer/src/features/analysis/lib/notebookPromptReferences'
import type { AnalysisNotebookContextReference } from '../src/renderer/src/types'

const candidates: AnalysisNotebookContextReference[] = [
  { id: 'variable:pd', kind: 'variable', name: 'pd', detail: 'module' },
  { id: 'variable:threshold', kind: 'variable', name: 'threshold', detail: 'float' },
  { id: 'dataframe:df', kind: 'dataframe', name: 'df' },
  { id: 'source:counts.csv', kind: 'data_source', name: 'counts.csv' },
  { id: 'cell:13', kind: 'cell_output', name: 'cell-13', cellId: 'cell-13' }
]

test('Notebook references keep source positions and map every context type to its icon kind', () => {
  const source = '使用 @pd 处理 @df；根据 @threshold 和 @counts.csv 修复 @cell-13。'
  const references = notebookPromptReferences(source, candidates)
  assert.deepEqual(
    references.map((reference) => reference.kind),
    ['module', 'dataframe', 'variable', 'data_source', 'cell_output']
  )
  for (const reference of references) {
    assert.equal(source.slice(reference.from, reference.to), reference.text)
    assert.equal(reference.text, `@${reference.name}`)
  }
})

test('unknown names, emails, escaped mentions and prefixes remain ordinary text', () => {
  const source =
    'user@pd \u005c@df @unknown @df_long @df.column @df/path @cell-130 @counts.csv.backup 𝒜@df @df变量'
  assert.deepEqual(notebookPromptReferences(source, candidates), [])
  assert.deepEqual(
    notebookPromptReferences('(@df), @pd. @threshold!', candidates).map(
      (reference) => reference.name
    ),
    ['df', 'pd', 'threshold']
  )
})

test('complete Unicode names, dotted bindings and paths use longest matching names', () => {
  const known: AnalysisNotebookContextReference[] = [
    ...candidates,
    { id: 'variable:阈值', kind: 'variable', name: '阈值' },
    { id: 'variable:df.obs', kind: 'variable', name: 'df.obs' },
    { id: 'source:文件', kind: 'data_source', name: 'data/样本 counts.csv' }
  ]
  const source = '@df.obs @阈值 @data/样本 counts.csv @df'
  assert.deepEqual(
    notebookPromptReferences(source, known).map((reference) => reference.name),
    ['df.obs', '阈值', 'data/样本 counts.csv', 'df']
  )
})

test('code examples never become Notebook reference widgets', () => {
  for (const source of [
    '`@df`',
    '```python\n@df\n@pd\n```',
    '~~~\n@cell-13\n~~~',
    '    @threshold',
    '\t@counts.csv',
    '`unfinished @df'
  ]) {
    assert.deepEqual(notebookPromptReferences(source, candidates), [], source)
    assert.deepEqual(notebookPromptContextReferences(source, candidates), [], source)
  }
})

test('submitted contexts follow remaining tokens, deduplicate repeats and restore after undo', () => {
  const source = '@df @pd @df'
  assert.deepEqual(
    notebookPromptContextReferences(source, candidates).map((reference) => reference.id),
    ['dataframe:df', 'variable:pd']
  )
  assert.deepEqual(
    notebookPromptContextReferences('@pd', candidates).map((reference) => reference.id),
    ['variable:pd']
  )
  assert.deepEqual(notebookPromptContextReferences('', candidates), [])
  assert.equal(notebookPromptContextReferences(source, candidates)[0], candidates[2])
})

test('selected metadata wins over available same-name and same-id candidates', () => {
  const selected: AnalysisNotebookContextReference = {
    ...candidates[4],
    id: 'selected_cell:13',
    detail: 'selected cell',
    preview: { code: 'full selected code' }
  }
  const known = [selected, { ...selected, preview: { code: 'stale code' } }, ...candidates]
  assert.equal(notebookPromptContextReferences('@cell-13', known)[0], selected)
  assert.equal(notebookPromptReferences('@cell-13', known)[0].id, selected.id)
})

test('refactoring retains the implicit selected cell while removed optional contexts stay removed', () => {
  const target = candidates[4]
  assert.deepEqual(notebookPromptContextReferences('', candidates, target.cellId), [target])
  assert.deepEqual(notebookPromptContextReferences('修复错误', candidates, target.cellId), [target])
  assert.deepEqual(notebookPromptContextReferences('@df @cell-13', candidates, target.cellId), [
    target,
    candidates[2]
  ])
  assert.deepEqual(notebookPromptContextReferences('修复错误', candidates), [])
})
