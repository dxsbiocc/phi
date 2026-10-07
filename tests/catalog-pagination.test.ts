import assert from 'node:assert/strict'
import test from 'node:test'
import { getCatalogPage } from '../src/renderer/src/components/catalog/catalogPaging'

test('catalog pages replace previous rows and include every item exactly once', () => {
  const items = Array.from({ length: 25 }, (_, id) => ({ id }))
  const first = getCatalogPage(items, 0, 10)
  const second = getCatalogPage(items, 1, 10)
  const last = getCatalogPage(items, 2, 10)

  assert.deepEqual(
    first.rows.map((item) => item.id),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  )
  assert.deepEqual(
    second.rows.map((item) => item.id),
    [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
  )
  assert.deepEqual(
    last.rows.map((item) => item.id),
    [20, 21, 22, 23, 24]
  )
  assert.deepEqual([...first.rows, ...second.rows, ...last.rows], items)
})

test('shrinking catalog results clamps a late page without leaving an empty result', () => {
  const items = Array.from({ length: 173 }, (_, id) => id)
  assert.deepEqual(getCatalogPage(items, 17, 10), { page: 17, rows: [170, 171, 172] })
  const refreshed = items.slice(0, 12)
  assert.deepEqual(getCatalogPage(refreshed, 17, 10), { page: 1, rows: [10, 11] })
  assert.deepEqual(getCatalogPage(refreshed, 1, 20), { page: 0, rows: refreshed })
})

test('empty catalogs and first-page navigation remain in bounds', () => {
  assert.deepEqual(getCatalogPage([], 5, 10), { page: 0, rows: [] })
  assert.deepEqual(getCatalogPage(['only'], -1, 10), { page: 0, rows: ['only'] })
})
