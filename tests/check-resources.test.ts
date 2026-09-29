import assert from 'node:assert/strict'
import test from 'node:test'

import { offendingResourcePaths } from '../scripts/check-resources.mjs'

test('resource check allows .DS_Store and the generated wrapper pack index', () => {
  assert.deepEqual(
    offendingResourcePaths([
      'resources/.DS_Store',
      'resources/wrappers/modules/local/differential-expression/deseq2/.DS_Store',
      'resources/wrappers/index.json'
    ]),
    []
  )
})

test('resource check rejects Nextflow leftovers and other untracked files', () => {
  const untracked = [
    'resources/wrappers/modules/local/differential-expression/deseq2/.nextflow/x',
    'resources/wrappers/modules/local/differential-expression/deseq2/.nextflow.log',
    'resources/wrappers/notes.txt'
  ]
  assert.deepEqual(offendingResourcePaths(untracked), untracked)
})
