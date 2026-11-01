import assert from 'node:assert/strict'
import test from 'node:test'

import { selectShard } from '../scripts/test-affected.mjs'

const files = Array.from({ length: 11 }, (_, index) => `tests/${index}.test.ts`)

test('shards partition the suites: every suite runs exactly once', () => {
  const shards = ['1/4', '2/4', '3/4', '4/4'].map((spec) => selectShard(files, spec))
  assert.deepEqual(shards.flat().sort(), [...files].sort())
  for (const shard of shards) assert.ok(shard.length === 2 || shard.length === 3)
})

test('a malformed or out-of-range shard fails instead of silently running nothing', () => {
  for (const spec of ['', '0/4', '5/4', '1/0', 'a/b', '1', '1/4/2', '-1/4']) {
    assert.throws(() => selectShard(files, spec), /--shard/, spec)
  }
})
