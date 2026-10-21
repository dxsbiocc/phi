import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const path = 'src/renderer/src/components/catalog/CatalogBrowseLayout.tsx'
const syntax = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
let resetEffect: ts.Expression | undefined
const visit = (node: ts.Node): void => {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(syntax) === 'useEffect' &&
    node.arguments[0]?.getText(syntax).includes('resultsRef')
  ) {
    resetEffect = node.arguments[0]
  }
  ts.forEachChild(node, visit)
}
visit(syntax)
assert.ok(resetEffect)
const effect = ts.transpileModule(`const reset = ${resetEffect.getText(syntax)}; reset();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText

test('catalog query, group or page changes reset the internal table scroller', () => {
  const table = { scrollTop: 180 }
  const results = {
    scrollTop: 0,
    querySelector: (selector: string) =>
      selector === '[data-phi-catalog-table-scroll]' ? table : null
  }
  runInNewContext(effect, { resultsRef: { current: results } })
  assert.equal(table.scrollTop, 0)
  assert.equal(results.scrollTop, 0)
})

test('catalog tables reserve the scrollbar slot inside the right padding', () => {
  const table = readFileSync('src/renderer/src/components/catalog/CatalogResultsTable.tsx', 'utf8')
  const layout = readFileSync('src/renderer/src/components/catalog/CatalogBrowseLayout.tsx', 'utf8')
  assert.match(table, /scrollbarGutter: 'stable'/)
  assert.match(table, /width: `calc\(100% \+ \$\{CATALOG_SCROLLBAR_GUTTER\}\)`/)
  assert.match(table, /mr: `-\$\{CATALOG_SCROLLBAR_GUTTER\}`/)
  assert.match(layout, /scrollbarGutter: scrollContent \? 'stable' : 'auto'/)
  assert.match(layout, /pr: scrollContent \? CATALOG_SCROLLBAR_GUTTER : 3/)
})

test('catalog reset tolerates loading and empty content without a table', () => {
  const results = { scrollTop: 0, querySelector: () => null }
  assert.doesNotThrow(() => runInNewContext(effect, { resultsRef: { current: results } }))
  assert.doesNotThrow(() => runInNewContext(effect, { resultsRef: { current: null } }))
})
