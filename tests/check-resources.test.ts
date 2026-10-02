import assert from 'node:assert/strict'
import test from 'node:test'

import { offendingResourcePaths } from '../scripts/check-resources.mjs'

test('resource check allows .DS_Store but no retired wrapper pack index', () => {
  assert.deepEqual(
    offendingResourcePaths([
      'resources/.DS_Store',
      'resources/wrappers/modules/local/differential-expression/deseq2/.DS_Store'
    ]),
    []
  )
  assert.deepEqual(offendingResourcePaths(['resources/wrappers/index.json']), [
    'resources/wrappers/index.json'
  ])
})

test('resource check allows fetched micromamba binaries and nothing else under resources/runtime', () => {
  assert.deepEqual(
    offendingResourcePaths([
      'resources/runtime/micromamba/darwin-arm64/micromamba',
      'resources/runtime/micromamba/darwin-x64/micromamba',
      'resources/runtime/micromamba/linux-x64/micromamba',
      'resources\\runtime\\micromamba\\linux-x64\\micromamba'
    ]),
    []
  )
  assert.deepEqual(
    offendingResourcePaths([
      'resources/runtime/manifest.json',
      'resources/runtime/micromamba',
      'resources/runtime/micromamba-extra'
    ]),
    [
      'resources/runtime/manifest.json',
      'resources/runtime/micromamba',
      'resources/runtime/micromamba-extra'
    ]
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
