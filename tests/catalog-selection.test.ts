import assert from 'node:assert/strict'
import test from 'node:test'
import { retainSelectedCatalogId } from '../src/renderer/src/lib/catalogSelection'

const entries = [{ id: 'first' }, { id: 'second' }]

test('refresh never selects the first catalog entry after a detail tab closes', () => {
  assert.equal(retainSelectedCatalogId(null, entries), null)
})

test('refresh preserves a selected entry only while it still exists', () => {
  assert.equal(retainSelectedCatalogId('second', entries), 'second')
  assert.equal(retainSelectedCatalogId('removed', entries), null)
})
